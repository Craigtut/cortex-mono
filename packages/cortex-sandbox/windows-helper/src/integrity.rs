//! Mandatory Integrity Control (MIC): drop the child token to Low, and Low-label
//! the writable roots so the Low child can still write them.
//!
//! Why both are needed. Windows enforces MIC independently of DACLs: a subject
//! at integrity IL_s is denied WRITE to an object at IL_o when IL_s < IL_o
//! (the default NO_WRITE_UP policy). Almost everything on disk is Medium, so a
//! Low token cannot write it, which is exactly the extra containment we want.
//! But the workspace and sandbox temp are Medium too, so the child could not
//! write them either, defeating the point. The fix is the standard low-IL
//! sandbox pattern (used by the IE/Chrome renderer): stamp a Low mandatory
//! label on precisely the writable roots, lowering IL_o to Low there so the
//! Low child's writes are no longer "up". Reads are unaffected: the default
//! policy is NO_WRITE_UP only (not NO_READ_UP), so a Low process still reads
//! Medium/High objects, keeping reads broad.
//!
//! Net effect: writes must now pass THREE gates (the WRITE_RESTRICTED cap-SID
//! DACL check, the normal DACL, and MIC), which is genuine defense-in-depth.
//!
//! Tradeoff (documented in the runbook): a Low-IL process is more constrained
//! than the cap-SID scheme alone (UIPI blocks messaging higher-IL windows, some
//! tools misbehave at Low, the child may be unable to edit pre-existing
//! Medium-labeled files inside the workspace, and the Low label persists on the
//! labeled dirs). Codex ships Medium (LUA_TOKEN only) for compatibility; we
//! match that: Medium is the default and Low is the opt-in policy toggle
//! (`lowIntegrity`). Only the workspace roots and the dedicated sandbox temp
//! are ever labeled; the Node side keeps the machine's real temp root out of
//! writableRoots so it is never labeled.

use std::ffi::c_void;
use std::path::Path;
use windows::core::{Error, Result, PWSTR};
use windows::Win32::Security::Authorization::{SetNamedSecurityInfoW, SE_FILE_OBJECT};
use windows::Win32::Security::{
    AddMandatoryAce, InitializeAcl, SetTokenInformation, ACL, ACL_REVISION,
    CONTAINER_INHERIT_ACE, LABEL_SECURITY_INFORMATION, OBJECT_INHERIT_ACE, PSID,
    SID_AND_ATTRIBUTES, TOKEN_MANDATORY_LABEL, TokenIntegrityLevel,
};

use crate::sid::SidBuf;
use crate::winutil::{path_to_wide, OwnedHandle};

/// SE_GROUP_INTEGRITY: marks the label SID as the token's integrity level.
const SE_GROUP_INTEGRITY: u32 = 0x20;
/// SYSTEM_MANDATORY_LABEL_NO_WRITE_UP: the default (and only) policy bit we set,
/// so higher-IL subjects can still write while the object's own IL becomes Low.
const SYSTEM_MANDATORY_LABEL_NO_WRITE_UP: u32 = 0x1;

/// Set the token's integrity level to Low.
pub fn set_token_low_integrity(token: &OwnedHandle, low_sid: &SidBuf) -> Result<()> {
    let mut label = TOKEN_MANDATORY_LABEL {
        Label: SID_AND_ATTRIBUTES {
            Sid: low_sid.psid(),
            Attributes: SE_GROUP_INTEGRITY,
        },
    };
    // Microsoft's documented length: the struct plus the referenced SID length.
    let len = std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32
        + unsafe { windows::Win32::Security::GetLengthSid(low_sid.psid()) };
    unsafe {
        SetTokenInformation(
            token.get(),
            TokenIntegrityLevel,
            &mut label as *mut _ as *const c_void,
            len,
        )?;
    }
    Ok(())
}

/// Apply an inheritable Low mandatory label to a directory (or file), so a Low
/// child may write within it. No-op-safe to call on each writable root.
pub fn label_path_low(path: &Path, low_sid: &SidBuf) -> Result<()> {
    // A SACL holding a single SYSTEM_MANDATORY_LABEL_ACE. Allocate a DWORD-aligned
    // buffer (ACLs must be 4-byte aligned) with generous headroom for the ACE+SID.
    let mut acl_buf = vec![0u32; 64]; // 256 bytes; a label ACE + SID is well under this
    let acl = acl_buf.as_mut_ptr() as *mut ACL;
    unsafe {
        InitializeAcl(acl, (acl_buf.len() * 4) as u32, ACL_REVISION)?;
        AddMandatoryAce(
            acl,
            ACL_REVISION,
            // Inherit onto files and subdirectories created later under the root.
            OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE,
            SYSTEM_MANDATORY_LABEL_NO_WRITE_UP,
            low_sid.psid(),
        )?;

        let wpath = path_to_wide(path);
        let rc = SetNamedSecurityInfoW(
            PWSTR(wpath.as_ptr() as *mut u16),
            SE_FILE_OBJECT,
            LABEL_SECURITY_INFORMATION,
            PSID::default(),
            PSID::default(),
            None,                    // DACL untouched
            Some(acl as *const ACL), // SACL carries the mandatory label
        );
        if rc.is_err() {
            return Err(Error::from(rc.to_hresult()));
        }
    }
    Ok(())
}
