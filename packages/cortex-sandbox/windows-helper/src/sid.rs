//! SID primitives: derive the restricting capability SID from a stable name,
//! build the well-known SIDs the recipe needs (Everyone, Low integrity label),
//! and pull the logon-session SID off a token.
//!
//! Why a capability SID at all: the token is created WRITE_RESTRICTED (see
//! token.rs), so a write must satisfy BOTH the normal token AND the restricting
//! SID list. Placing a synthetic capability SID in that list, and granting only
//! that SID write ACEs on the workspace roots, is what confines writes to the
//! workspace while leaving reads (which do not consult the restricting list)
//! broad. `DeriveCapabilitySidsFromName` makes the SID a deterministic function
//! of a per-install name, so the same install reuses one SID and its ACEs
//! instead of accumulating fresh ones each run.

use std::ffi::c_void;
use windows::core::Result;
use windows::Win32::Foundation::{HLOCAL, PSID};
use windows::Win32::Security::Isolation::DeriveCapabilitySidsFromName;
use windows::Win32::Security::{
    CopySid, CreateWellKnownSid, GetLengthSid, GetTokenInformation, TokenGroups, TOKEN_GROUPS,
    WELL_KNOWN_SID_TYPE, WinLowLabelSid, WinWorldSid,
};
use windows::Win32::System::Memory::LocalFree;

use crate::winutil::to_wide;

/// SE_GROUP_LOGON_ID: marks the token group that is the logon-session SID.
const SE_GROUP_LOGON_ID: u32 = 0xC000_0000;

/// A self-owned SID (a copied byte buffer). No manual free: dropping the Vec
/// releases it. Use for SIDs we build or copy; the transient pointers returned
/// by Win32 allocators are copied into one of these and then freed.
#[derive(Clone)]
pub struct SidBuf(Vec<u8>);

impl SidBuf {
    /// A read pointer to the SID. Valid for as long as `self` is alive. The Win32
    /// APIs that consume a SID for comparison/ACL entry do not mutate it, so the
    /// `*const -> *mut` cast is sound for those uses.
    pub fn psid(&self) -> PSID {
        PSID(self.0.as_ptr() as *mut c_void)
    }
}

/// Copy a foreign SID into an owned buffer.
///
/// # Safety
/// `src` must point to a valid SID that outlives the call.
pub unsafe fn copy_sid(src: PSID) -> Result<SidBuf> {
    let len = GetLengthSid(src);
    let mut buf = vec![0u8; len as usize];
    CopySid(len, PSID(buf.as_mut_ptr() as *mut c_void), src)?;
    Ok(SidBuf(buf))
}

/// Build a well-known SID (Everyone, Low label, ...).
fn well_known_sid(kind: WELL_KNOWN_SID_TYPE) -> Result<SidBuf> {
    unsafe {
        // First call sizes the buffer (fails with ERROR_INSUFFICIENT_BUFFER).
        let mut cb: u32 = 0;
        let _ = CreateWellKnownSid(kind, None, None, &mut cb);
        let mut buf = vec![0u8; cb as usize];
        CreateWellKnownSid(kind, None, Some(PSID(buf.as_mut_ptr() as *mut c_void)), &mut cb)?;
        Ok(SidBuf(buf))
    }
}

/// The World / "Everyone" SID (S-1-1-0). Included in the restricting SID list and
/// the token default DACL so the child can still touch the IPC/console objects
/// that grant Everyone (pipes, ALPC ports); see token.rs for the tradeoff.
pub fn everyone_sid() -> Result<SidBuf> {
    well_known_sid(WinWorldSid)
}

/// The Low integrity label SID (S-1-16-4096). Applied to the child token
/// (integrity.rs) and, as a mandatory label, to the writable roots so a Low
/// child may write them.
pub fn low_integrity_sid() -> Result<SidBuf> {
    well_known_sid(WinLowLabelSid)
}

/// Derive the restricting capability SID from a stable per-install name.
///
/// `DeriveCapabilitySidsFromName` allocates two arrays (group SIDs and capability
/// SIDs) plus their elements, all via LocalAlloc. We copy the single capability
/// SID we need into an owned buffer and free everything the API allocated. The
/// capability SID (S-1-15-3-...) is just a SID; nothing here creates an
/// AppContainer, we only borrow the SID as an ACL/restricting principal.
pub fn derive_capability_sid(name: &str) -> Result<SidBuf> {
    let wname = to_wide(name);
    unsafe {
        let mut group_sids: *mut PSID = std::ptr::null_mut();
        let mut group_count: u32 = 0;
        let mut cap_sids: *mut PSID = std::ptr::null_mut();
        let mut cap_count: u32 = 0;

        DeriveCapabilitySidsFromName(
            windows::core::PCWSTR(wname.as_ptr()),
            &mut group_sids,
            &mut group_count,
            &mut cap_sids,
            &mut cap_count,
        )?;

        // Copy out the first capability SID before freeing the API's allocations.
        let result = if cap_count > 0 && !cap_sids.is_null() {
            let first = *cap_sids;
            copy_sid(first)
        } else {
            Err(windows::core::Error::from_win32())
        };

        free_psid_array(group_sids, group_count);
        free_psid_array(cap_sids, cap_count);

        result
    }
}

/// LocalFree each element of a PSID array and then the array itself.
///
/// # Safety
/// `arr` must be a LocalAlloc'd array of `count` LocalAlloc'd PSIDs, or null.
unsafe fn free_psid_array(arr: *mut PSID, count: u32) {
    if arr.is_null() {
        return;
    }
    for i in 0..count as isize {
        let p = *arr.offset(i);
        if !p.0.is_null() {
            let _ = LocalFree(HLOCAL(p.0));
        }
    }
    let _ = LocalFree(HLOCAL(arr as *mut c_void));
}

/// Extract the logon-session SID from a primary token by scanning its groups for
/// the SE_GROUP_LOGON_ID entry. The logon SID names this specific interactive
/// session; including it in the restricting SID list (as Codex does) lets the
/// child keep talking to session-scoped objects (the window station/desktop,
/// session pipes) that a bare capability SID would not cover.
///
/// # Safety
/// `token` must be a valid token handle opened with TOKEN_QUERY.
pub unsafe fn logon_sid_from_token(token: windows::Win32::Foundation::HANDLE) -> Result<SidBuf> {
    // Size the TokenGroups buffer.
    let mut needed: u32 = 0;
    let _ = GetTokenInformation(token, TokenGroups, None, 0, &mut needed);
    if needed == 0 {
        return Err(windows::core::Error::from_win32());
    }
    let mut buf = vec![0u8; needed as usize];
    GetTokenInformation(
        token,
        TokenGroups,
        Some(buf.as_mut_ptr() as *mut c_void),
        needed,
        &mut needed,
    )?;

    // TOKEN_GROUPS: { DWORD GroupCount; SID_AND_ATTRIBUTES Groups[]; }. Read the
    // count, then walk the variable-length Groups array. Using a pointer walk
    // (rather than the fixed [_;1] binding) keeps this correct for N groups.
    let groups = &*(buf.as_ptr() as *const TOKEN_GROUPS);
    let count = groups.GroupCount as isize;
    let first = groups.Groups.as_ptr();
    for i in 0..count {
        let entry = &*first.offset(i);
        if entry.Attributes & SE_GROUP_LOGON_ID == SE_GROUP_LOGON_ID {
            return copy_sid(entry.Sid);
        }
    }
    // No logon SID present on the token; surface the current OS error.
    Err(windows::core::Error::from_win32())
}
