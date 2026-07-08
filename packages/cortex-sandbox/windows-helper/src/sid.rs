//! SID primitives: derive the restricting synthetic SID from a stable name,
//! build the well-known SIDs the recipe needs (Everyone, Low integrity label),
//! and pull the logon-session SID off a token.
//!
//! Why a synthetic restricting SID at all: the token is created WRITE_RESTRICTED
//! (see token.rs), so a write must satisfy BOTH the normal token AND the
//! restricting SID list. Placing a synthetic SID in that list, and granting only
//! that SID write ACEs on the workspace roots, is what confines writes to the
//! workspace while leaving reads (which do not consult the restricting list)
//! broad.
//!
//! Why a plain `S-1-5-21-...` SID and not a capability SID
//! (`DeriveCapabilitySidsFromName`, S-1-15-3-...): `CreateRestrictedToken`
//! rejects a capability SID in its `SidsToRestrict` list with
//! ERROR_INVALID_PARAMETER (capability SIDs are only meaningful inside an
//! AppContainer). Codex's shipped helper uses a synthetic account SID for
//! exactly this reason. We derive it DETERMINISTICALLY from the policy's
//! per-install + per-workspace name (a stable 128-bit hash fills the four
//! sub-authorities) so the same workspace reuses one SID and its persisted ACEs
//! instead of accumulating fresh ones, while a different workspace's name yields
//! a different SID and its grant ACEs never authorize this token. The SID is not
//! a real account (nothing is ever logged on as it); it exists only as an
//! ACL/restricting principal, exactly as Codex's random SID does.

use std::ffi::c_void;
use windows::core::Result;
use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Authorization::ConvertStringSidToSidW;
use windows::Win32::Security::{
    CopySid, CreateWellKnownSid, GetLengthSid, GetTokenInformation, TokenGroups, PSID,
    TOKEN_GROUPS, WELL_KNOWN_SID_TYPE, WinLowLabelSid, WinWorldSid,
};

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
        let _ = CreateWellKnownSid(kind, None, PSID::default(), &mut cb);
        let mut buf = vec![0u8; cb as usize];
        CreateWellKnownSid(kind, None, PSID(buf.as_mut_ptr() as *mut c_void), &mut cb)?;
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

/// Derive the restricting synthetic SID deterministically from the policy's
/// stable per-install + per-workspace name.
///
/// The name is hashed to 128 bits, which fill the four sub-authorities of an
/// `S-1-5-21-a-b-c-d` SID (the same shape Codex's helper uses, except Codex
/// randomizes and persists the sub-authorities; we derive them from the name so
/// the SID is reproducible without a state file). `ConvertStringSidToSidW`
/// allocates the SID via LocalAlloc; we copy it into an owned buffer and free
/// the original. The SID names no real account; it is only ever an
/// ACL/restricting principal.
pub fn derive_capability_sid(name: &str) -> Result<SidBuf> {
    let sid_string = synthetic_sid_string(name);
    let wsid = to_wide(&sid_string);
    unsafe {
        let mut psid = PSID::default();
        ConvertStringSidToSidW(windows::core::PCWSTR(wsid.as_ptr()), &mut psid)?;
        // Copy into an owned buffer, then free the LocalAlloc'd original.
        let result = copy_sid(psid);
        if !psid.0.is_null() {
            let _ = LocalFree(HLOCAL(psid.0));
        }
        result
    }
}

/// Build the deterministic `S-1-5-21-a-b-c-d` string for a name. The four
/// sub-authorities are a 128-bit FNV-1a hash of the name (four 32-bit lanes with
/// distinct offset bases), so distinct names practically never collide and the
/// same name is always the same SID. This is a synthetic principal, not a
/// security-grade hash: collisions would only ever merge two workspaces'
/// write-grant scopes, and 2^-128 makes that a non-event.
fn synthetic_sid_string(name: &str) -> String {
    // FNV-1a 32-bit, seeded with distinct offset bases for four independent lanes.
    const PRIME: u32 = 0x0100_0193;
    const BASES: [u32; 4] = [0x811c_9dc5, 0x1000_0000, 0x2000_0000, 0x3000_0000];
    let mut lanes = BASES;
    for (i, lane) in lanes.iter_mut().enumerate() {
        // Salt each lane so the same byte stream diverges across lanes.
        *lane ^= i as u32 + 1;
        for &b in name.as_bytes() {
            *lane ^= b as u32;
            *lane = lane.wrapping_mul(PRIME);
        }
    }
    format!("S-1-5-21-{}-{}-{}-{}", lanes[0], lanes[1], lanes[2], lanes[3])
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

#[cfg(test)]
mod tests {
    use super::synthetic_sid_string;

    #[test]
    fn synthetic_sid_is_deterministic_and_well_formed() {
        let a = synthetic_sid_string("cortex-sandbox-0123456789abcdef");
        let b = synthetic_sid_string("cortex-sandbox-0123456789abcdef");
        assert_eq!(a, b, "same name must map to the same SID");
        assert!(a.starts_with("S-1-5-21-"), "must be an account-domain SID: {a}");
        assert_eq!(a.matches('-').count(), 7, "S-1-5-21 plus four sub-authorities: {a}");
    }

    #[test]
    fn synthetic_sid_differs_by_name() {
        let a = synthetic_sid_string("cortex-sandbox-workspace-a");
        let b = synthetic_sid_string("cortex-sandbox-workspace-b");
        assert_ne!(a, b, "different workspaces must not share a restricting SID");
    }
}
