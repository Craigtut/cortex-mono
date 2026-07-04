//! DACL edits: grant the capability SID write access on the writable roots, and
//! deny it read on secret paths / write on the agent config. Mirrors Codex's
//! `acl.rs`: fetch the object's current DACL (GetNamedSecurityInfoW), merge one
//! EXPLICIT_ACCESS_W (SetEntriesInAclW), and write it back
//! (SetNamedSecurityInfoW). New deny ACEs are placed before allow ACEs by
//! SetEntriesInAclW, which is the order Windows evaluates for a deny to win.
//!
//! All ACEs are inheritable (CONTAINER_INHERIT | OBJECT_INHERIT) so a grant/deny
//! on a root covers files and subdirectories created later.
//!
//! Teardown: we key every ACE to a STABLE capability SID (derived from the
//! per-install name), so re-running reuses the same ACEs instead of
//! accumulating fresh ones. That is the design's "stable cap SID" branch, so the
//! happy path needs no teardown; `revoke` exists for a consumer that wants to
//! scrub the synthetic principal's ACEs entirely.

use std::ffi::c_void;
use std::path::Path;
use windows::core::{Error, Result, PCWSTR, PWSTR};
use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::{
    GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, DENY_ACCESS, GRANT_ACCESS,
    REVOKE_ACCESS, SE_FILE_OBJECT, ACCESS_MODE, EXPLICIT_ACCESS_W,
};
use windows::Win32::Security::{
    ACL, CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, OBJECT_INHERIT_ACE, PSECURITY_DESCRIPTOR,
    PSID,
};

use crate::sid::SidBuf;
use crate::token::sid_trustee;
use crate::winutil::path_to_wide;

// Standard Win32 access-right values (winnt.h). Spelled numerically so the masks
// read the same whether or not the `windows` crate's FILE_ACCESS_RIGHTS newtype
// shifts between versions.
const FILE_GENERIC_READ: u32 = 0x0012_0089;
const FILE_GENERIC_WRITE: u32 = 0x0012_0116;
const FILE_GENERIC_EXECUTE: u32 = 0x0012_00A0;
const DELETE: u32 = 0x0001_0000;
const FILE_DELETE_CHILD: u32 = 0x0000_0040;
const FILE_WRITE_DATA: u32 = 0x0000_0002;
const FILE_APPEND_DATA: u32 = 0x0000_0004;
const FILE_WRITE_EA: u32 = 0x0000_0010;
const FILE_WRITE_ATTRIBUTES: u32 = 0x0000_0100;
const GENERIC_READ: u32 = 0x8000_0000;
const GENERIC_WRITE: u32 = 0x4000_0000;

/// Read + write + execute + delete: what a workspace root needs to be usable.
const WRITE_ALLOW_MASK: u32 =
    FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE | FILE_DELETE_CHILD;
/// Everything that constitutes "read".
const READ_DENY_MASK: u32 = FILE_GENERIC_READ | GENERIC_READ;
/// Everything that constitutes "write/append/delete".
const WRITE_DENY_MASK: u32 = FILE_GENERIC_WRITE
    | FILE_WRITE_DATA
    | FILE_APPEND_DATA
    | FILE_WRITE_EA
    | FILE_WRITE_ATTRIBUTES
    | GENERIC_WRITE
    | DELETE
    | FILE_DELETE_CHILD;

const INHERIT_BOTH: windows::Win32::Security::ACE_FLAGS = windows::Win32::Security::ACE_FLAGS(
    CONTAINER_INHERIT_ACE.0 | OBJECT_INHERIT_ACE.0,
);

/// Grant the capability SID read/write/execute on a writable root.
pub fn grant_write(path: &Path, cap: &SidBuf) -> Result<()> {
    apply_ace(path, cap.psid(), GRANT_ACCESS, WRITE_ALLOW_MASK)
}

/// Deny the capability SID read on a secret path.
pub fn deny_read(path: &Path, cap: &SidBuf) -> Result<()> {
    apply_ace(path, cap.psid(), DENY_ACCESS, READ_DENY_MASK)
}

/// Deny the capability SID write on the agent config / protected tree.
pub fn deny_write(path: &Path, cap: &SidBuf) -> Result<()> {
    apply_ace(path, cap.psid(), DENY_ACCESS, WRITE_DENY_MASK)
}

/// Remove the capability SID's ACEs from a path (optional teardown).
pub fn revoke(path: &Path, cap: &SidBuf) -> Result<()> {
    apply_ace(path, cap.psid(), REVOKE_ACCESS, 0)
}

/// Fetch the DACL, merge a single ACE for `psid`, and write it back.
fn apply_ace(path: &Path, psid: PSID, mode: ACCESS_MODE, mask: u32) -> Result<()> {
    let wpath = path_to_wide(path);
    unsafe {
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut sd = PSECURITY_DESCRIPTOR::default();
        let rc = GetNamedSecurityInfoW(
            PCWSTR(wpath.as_ptr()),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            None,
            None,
            Some(&mut dacl as *mut *mut ACL),
            None,
            &mut sd,
        );
        if rc.is_err() {
            return Err(Error::from(rc.to_hresult()));
        }

        let entry = EXPLICIT_ACCESS_W {
            grfAccessPermissions: mask,
            grfAccessMode: mode,
            grfInheritance: INHERIT_BOTH,
            Trustee: sid_trustee(psid),
        };

        let mut new_dacl: *mut ACL = std::ptr::null_mut();
        let merge = SetEntriesInAclW(Some(&[entry]), Some(dacl as *const ACL), &mut new_dacl);
        let result = if merge.is_err() {
            Err(Error::from(merge.to_hresult()))
        } else {
            let set = SetNamedSecurityInfoW(
                PWSTR(wpath.as_ptr() as *mut u16),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                PSID::default(),
                PSID::default(),
                Some(new_dacl as *const ACL),
                None,
            );
            if set.is_err() {
                Err(Error::from(set.to_hresult()))
            } else {
                Ok(())
            }
        };

        if !new_dacl.is_null() {
            let _ = LocalFree(HLOCAL(new_dacl as *mut c_void));
        }
        if !sd.is_invalid() {
            let _ = LocalFree(HLOCAL(sd.0));
        }
        result
    }
}
