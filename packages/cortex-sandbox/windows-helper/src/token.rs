//! Restricted-token construction: the heart of the recipe.
//!
//! Sequence (mirrors Codex's shipped `token.rs`, verified against its source):
//!   1. OpenProcessToken on our own process to get a duplicable base token.
//!   2. Assemble the restricting SID list: [capability SIDs..., logon, Everyone].
//!   3. CreateRestrictedToken(DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED).
//!      WRITE_RESTRICTED is the crux: a WRITE now needs the DACL to grant BOTH
//!      the normal token AND one of the restricting SIDs. Reads only consult the
//!      normal token, so reads stay broad. We include logon + Everyone in the
//!      restricting list (as Codex does) so the child can still write the
//!      IPC/console objects those SIDs own (pipes, ALPC, the console); the price
//!      is that genuinely world-writable disk locations remain writable, which
//!      the deny-write ACEs and (optionally) Low integrity backstop.
//!   4. Set a permissive token default DACL (GENERIC_ALL for logon/Everyone/cap)
//!      so the restricted process can still create its own pipes and job/IPC
//!      objects instead of hitting ACCESS_DENIED (PowerShell pipelines need this).
//!   5. Re-enable SeChangeNotifyPrivilege, which DISABLE_MAX_PRIVILEGE stripped,
//!      so directory traversal ("bypass traverse checking") still works.
//!
//! DISABLE_MAX_PRIVILEGE drops every privilege; LUA_TOKEN produces a filtered,
//! Medium-integrity token. Integrity is lowered further to Low separately (see
//! integrity.rs) when the policy asks for it.

use std::ffi::c_void;
use windows::core::{Error, Result, PWSTR};
use windows::Win32::Foundation::{HANDLE, HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::{
    SetEntriesInAclW, EXPLICIT_ACCESS_W, GRANT_ACCESS, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
};
use windows::Win32::Security::{
    AdjustTokenPrivileges, CreateRestrictedToken, LookupPrivilegeValueW, SetTokenInformation,
    ACL, CREATE_RESTRICTED_TOKEN_FLAGS, LUID_AND_ATTRIBUTES, NO_INHERITANCE, PSID,
    SE_PRIVILEGE_ENABLED, SID_AND_ATTRIBUTES, TOKEN_ACCESS_MASK, TOKEN_ADJUST_DEFAULT,
    TOKEN_ADJUST_PRIVILEGES, TOKEN_ADJUST_SESSIONID, TOKEN_ASSIGN_PRIMARY, TOKEN_DEFAULT_DACL,
    TOKEN_DUPLICATE, TOKEN_PRIVILEGES, TOKEN_QUERY, TokenDefaultDacl,
};
use windows::Win32::System::Threading::GetCurrentProcess;

use crate::sid::SidBuf;
use crate::winutil::{to_wide, OwnedHandle};

// CreateRestrictedToken flags (winnt.h). The `windows` crate exposes these as
// module constants too; defined locally so the recipe reads unambiguously.
const DISABLE_MAX_PRIVILEGE: u32 = 0x1;
const LUA_TOKEN: u32 = 0x4;
const WRITE_RESTRICTED: u32 = 0x8;
const GENERIC_ALL: u32 = 0x1000_0000;

/// Open the current process token with the accesses CreateRestrictedToken and
/// CreateProcessAsUser will need downstream.
pub fn open_process_token() -> Result<OwnedHandle> {
    let desired: TOKEN_ACCESS_MASK = TOKEN_DUPLICATE
        | TOKEN_QUERY
        | TOKEN_ASSIGN_PRIMARY
        | TOKEN_ADJUST_DEFAULT
        | TOKEN_ADJUST_SESSIONID
        | TOKEN_ADJUST_PRIVILEGES;
    let mut h = HANDLE::default();
    unsafe {
        // OpenProcessToken lives under Win32_System_Threading in the windows crate.
        windows::Win32::System::Threading::OpenProcessToken(GetCurrentProcess(), desired, &mut h)?;
    }
    OwnedHandle::new(h).ok_or_else(Error::from_win32)
}

/// Build the WRITE_RESTRICTED restricted token.
///
/// `capabilities` are the restricting capability SIDs (usually one, derived from
/// the per-install name). `logon` and `everyone` complete the restricting list.
pub fn create_restricted_token(
    base: &OwnedHandle,
    capabilities: &[&SidBuf],
    logon: &SidBuf,
    everyone: &SidBuf,
) -> Result<OwnedHandle> {
    // Restricting SID list, exact order: capabilities..., logon, Everyone.
    let mut restrict: Vec<SID_AND_ATTRIBUTES> = Vec::with_capacity(capabilities.len() + 2);
    for cap in capabilities {
        restrict.push(sid_and_attrs(cap.psid()));
    }
    restrict.push(sid_and_attrs(logon.psid()));
    restrict.push(sid_and_attrs(everyone.psid()));

    let mut new_token = HANDLE::default();
    unsafe {
        CreateRestrictedToken(
            base.get(),
            CREATE_RESTRICTED_TOKEN_FLAGS(DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED),
            None,            // SidsToDisable: none (WRITE_RESTRICTED handles the write gate)
            None,            // PrivilegesToDelete: none beyond DISABLE_MAX_PRIVILEGE
            Some(&restrict), // SidsToRestrict
            &mut new_token,
        )
        .map_err(|e| Error::new(e.code(), format!("CreateRestrictedToken: {e}")))?;
    }
    let token = OwnedHandle::new(new_token).ok_or_else(Error::from_win32)?;

    // Permissive default DACL: without it, objects the child creates (pipes,
    // job/IPC handles) can come back ACCESS_DENIED under the restricted token.
    let dacl_sids = [logon.psid(), everyone.psid()]
        .into_iter()
        .chain(capabilities.iter().map(|c| c.psid()))
        .collect::<Vec<_>>();
    set_default_dacl(&token, &dacl_sids)
        .map_err(|e| Error::new(e.code(), format!("set default DACL: {e}")))?;

    // Restore traverse-checking bypass (stripped by DISABLE_MAX_PRIVILEGE).
    enable_privilege(&token, "SeChangeNotifyPrivilege")
        .map_err(|e| Error::new(e.code(), format!("enable SeChangeNotifyPrivilege: {e}")))?;

    Ok(token)
}

fn sid_and_attrs(psid: PSID) -> SID_AND_ATTRIBUTES {
    SID_AND_ATTRIBUTES {
        Sid: psid,
        Attributes: 0,
    }
}

/// Install a token default DACL that grants GENERIC_ALL to each SID, so the
/// restricted process can create and open its own objects.
fn set_default_dacl(token: &OwnedHandle, sids: &[PSID]) -> Result<()> {
    if sids.is_empty() {
        return Ok(());
    }
    let entries: Vec<EXPLICIT_ACCESS_W> = sids
        .iter()
        .map(|psid| EXPLICIT_ACCESS_W {
            grfAccessPermissions: GENERIC_ALL,
            grfAccessMode: GRANT_ACCESS,
            grfInheritance: NO_INHERITANCE,
            Trustee: sid_trustee(*psid),
        })
        .collect();

    unsafe {
        let mut new_dacl: *mut ACL = std::ptr::null_mut();
        let rc = SetEntriesInAclW(Some(&entries), None, &mut new_dacl);
        if rc.is_err() {
            return Err(Error::from(rc.to_hresult()));
        }
        let mut info = TOKEN_DEFAULT_DACL {
            DefaultDacl: new_dacl,
        };
        let res = SetTokenInformation(
            token.get(),
            TokenDefaultDacl,
            &mut info as *mut _ as *const c_void,
            std::mem::size_of::<TOKEN_DEFAULT_DACL>() as u32,
        );
        if !new_dacl.is_null() {
            let _ = LocalFree(HLOCAL(new_dacl as *mut c_void));
        }
        res?;
    }
    Ok(())
}

/// A TRUSTEE_W naming a SID principal.
pub fn sid_trustee(psid: PSID) -> TRUSTEE_W {
    TRUSTEE_W {
        pMultipleTrustee: std::ptr::null_mut(),
        MultipleTrusteeOperation: Default::default(),
        TrusteeForm: TRUSTEE_IS_SID,
        TrusteeType: TRUSTEE_IS_UNKNOWN,
        // The `*W` ACL APIs read a SID trustee's pointer out of ptstrName.
        ptstrName: PWSTR(psid.0 as *mut u16),
    }
}

/// Enable one named privilege on the token (e.g. SeChangeNotifyPrivilege).
fn enable_privilege(token: &OwnedHandle, name: &str) -> Result<()> {
    let wname = to_wide(name);
    let mut luid = Default::default();
    unsafe {
        LookupPrivilegeValueW(
            windows::core::PCWSTR::null(),
            windows::core::PCWSTR(wname.as_ptr()),
            &mut luid,
        )?;
        let tp = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            Privileges: [LUID_AND_ATTRIBUTES {
                Luid: luid,
                Attributes: SE_PRIVILEGE_ENABLED,
            }],
        };
        AdjustTokenPrivileges(token.get(), false, Some(&tp), 0, None, None)?;
    }
    Ok(())
}
