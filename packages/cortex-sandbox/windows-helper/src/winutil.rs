//! Small Win32 conveniences shared across modules: UTF-16 conversion, an owned
//! HANDLE that closes on drop, and last-error formatting. Kept deliberately thin
//! so the security-relevant modules read as a direct transcription of the Win32
//! recipe rather than of glue.

use std::path::Path;
use windows::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};

/// NUL-terminated UTF-16, suitable for the `*W` APIs. Keep the returned Vec
/// alive for as long as the pointer is in use.
pub fn to_wide(s: impl AsRef<str>) -> Vec<u16> {
    s.as_ref().encode_utf16().chain(std::iter::once(0)).collect()
}

/// NUL-terminated UTF-16 for a filesystem path.
pub fn path_to_wide(p: &Path) -> Vec<u16> {
    to_wide(p.to_string_lossy())
}

/// Owns a HANDLE and closes it on drop. Prevents the leak-on-early-return bugs
/// that plague raw HANDLE code, and makes the security ordering explicit (the
/// token/job/process handles all live exactly as long as their guard).
pub struct OwnedHandle(HANDLE);

impl OwnedHandle {
    /// Wrap a handle. Returns None for the null / invalid sentinels so callers
    /// can `?`-propagate a failed API without a separate validity check.
    pub fn new(h: HANDLE) -> Option<Self> {
        if h.is_invalid() || h == INVALID_HANDLE_VALUE {
            None
        } else {
            Some(Self(h))
        }
    }

    pub fn get(&self) -> HANDLE {
        self.0
    }

    /// Give up ownership; the caller becomes responsible for closing it.
    pub fn into_raw(self) -> HANDLE {
        let h = self.0;
        std::mem::forget(self);
        h
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            // SAFETY: we own this handle and it is valid; closing once is correct.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
}
