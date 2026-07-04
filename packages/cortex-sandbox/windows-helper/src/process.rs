//! Launch the child under the restricted token, inside the job, with process
//! mitigations, then wait and return its exit code.
//!
//! Ordering matters for containment:
//!   1. Build STARTUPINFOEXW carrying a proc-thread attribute list with the
//!      mitigation policy and the explicit stdio handle list.
//!   2. CreateProcessAsUserW(restricted_token, ..., CREATE_SUSPENDED | ...).
//!      Because the token is a restricted version of our OWN token,
//!      CreateProcessAsUser succeeds UNELEVATED (no SeAssignPrimaryToken needed) —
//!      this is what makes the Tier-1 helper work without admin.
//!   3. AssignProcessToJobObject BEFORE resuming, so the child is in the
//!      kill-on-close job for its entire life (no escape window).
//!   4. ResumeThread, WaitForSingleObject, GetExitCodeProcess.
//!
//! stdio: the child inherits the helper's own std handles (the pipes Node gave
//! the helper), restricted to exactly those three via the handle-list attribute.
//! So child output flows straight back to Node; the helper does not pump bytes.
//!
//! environment + cwd: passed as NULL, so the child inherits the helper's
//! environment (which Node set to the credential-scrubbed child env) and the
//! helper's current directory (which Node set to the command's cwd). Keeping
//! these implicit means the writable-root policy, not a model-supplied cwd,
//! governs where writes land.

use std::ffi::c_void;
use windows::core::{Error, Result, PCWSTR, PWSTR};
use windows::Win32::Foundation::{HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation};
use windows::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows::Win32::System::Threading::{
    CreateProcessAsUserW, DeleteProcThreadAttributeList, GetExitCodeProcess,
    InitializeProcThreadAttributeList, ResumeThread, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_SUSPENDED, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

use crate::winutil::{to_wide, OwnedHandle};

/// PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY (processthreadsapi.h).
const PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY: usize = 0x0002_0007;
/// PROC_THREAD_ATTRIBUTE_HANDLE_LIST.
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST: usize = 0x0002_0002;

// Mitigation policy bits (winnt.h; each field is a 2-bit selector, 01 = ALWAYS_ON).
// Enabled by default: compatible with running arbitrary dev tools while still
// hardening image loading and blocking legacy injection.
const MITIGATION_IMAGE_LOAD_NO_REMOTE: u64 = 1 << 52; // no DLLs from UNC/remote
const MITIGATION_IMAGE_LOAD_NO_LOW_LABEL: u64 = 1 << 56; // no DLLs from Low-labeled dirs
const MITIGATION_IMAGE_LOAD_PREFER_SYSTEM32: u64 = 1 << 60; // resolve system DLLs from System32
const MITIGATION_EXTENSION_POINT_DISABLE: u64 = 1 << 32; // block AppInit / Winsock LSP injection

// Part of the documented recipe but DISABLED by default because each breaks the
// tools a coding agent must run. Flip into DEFAULT_MITIGATIONS for a hardened
// deployment that only runs Microsoft-signed, non-JIT, console tooling:
//   - WIN32K_DISABLE: win32k syscall lockdown; breaks anything that touches
//     user32/gdi32 (many tools load them transitively).
//   - BLOCK_NON_MICROSOFT_BINARIES: blocks loading non-MS-signed images, i.e.
//     node.exe, git.exe, python.exe, cargo.exe — the agent's whole toolchain.
//   - PROHIBIT_DYNAMIC_CODE: blocks JIT; breaks Node/V8, .NET, and PowerShell.
#[allow(dead_code)]
const MITIGATION_WIN32K_DISABLE: u64 = 1 << 44;
#[allow(dead_code)]
const MITIGATION_BLOCK_NON_MICROSOFT_BINARIES: u64 = 1 << 28;
#[allow(dead_code)]
const MITIGATION_PROHIBIT_DYNAMIC_CODE: u64 = 1 << 36;

/// The mitigation set applied to every sandboxed child. See the constants above
/// for why the aggressive bits are excluded by default.
const DEFAULT_MITIGATIONS: u64 = MITIGATION_IMAGE_LOAD_NO_REMOTE
    | MITIGATION_IMAGE_LOAD_NO_LOW_LABEL
    | MITIGATION_IMAGE_LOAD_PREFER_SYSTEM32
    | MITIGATION_EXTENSION_POINT_DISABLE;

/// Launch `argv` (shell + args + command) under `token`, place it in `job`,
/// run it to completion, and return its process exit code.
pub fn spawn_and_wait(token: &OwnedHandle, job: &OwnedHandle, argv: &[String]) -> Result<u32> {
    let application = argv
        .first()
        .ok_or_else(|| Error::from_win32())?;
    let app_wide = to_wide(application);
    let mut cmdline_wide = to_wide(argv_to_command_line(argv));

    // The three std handles the child should inherit (the helper's own pipes).
    let stdin = unsafe { GetStdHandle(STD_INPUT_HANDLE) }?;
    let stdout = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) }?;
    let stderr = unsafe { GetStdHandle(STD_ERROR_HANDLE) }?;
    let mut handles = [stdin, stdout, stderr];
    for h in handles {
        unsafe {
            SetHandleInformation(h, HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT)?;
        }
    }

    let mut attr_list = ProcThreadAttrList::with_capacity(2)?;
    let mut mitigations: u64 = DEFAULT_MITIGATIONS;
    attr_list.set(
        PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY,
        &mut mitigations as *mut _ as *mut c_void,
        std::mem::size_of::<u64>(),
    )?;
    attr_list.set(
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        handles.as_mut_ptr() as *mut c_void,
        std::mem::size_of_val(&handles),
    )?;

    let mut si = STARTUPINFOEXW::default();
    si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    si.StartupInfo.hStdInput = stdin;
    si.StartupInfo.hStdOutput = stdout;
    si.StartupInfo.hStdError = stderr;
    si.lpAttributeList = attr_list.as_ptr();

    let mut pi = PROCESS_INFORMATION::default();
    unsafe {
        CreateProcessAsUserW(
            token.get(),
            PCWSTR(app_wide.as_ptr()),
            PWSTR(cmdline_wide.as_mut_ptr()),
            None,        // default process security
            None,        // default thread security
            true.into(), // bInheritHandles: required for the std handle inheritance
            CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,
            None,             // inherit the helper's (scrubbed) environment
            PCWSTR::null(),   // inherit the helper's current directory (Node set it)
            &si.StartupInfo,
            &mut pi,
        )?;
    }

    // Own the returned handles so they always close.
    let process = OwnedHandle::new(pi.hProcess).ok_or_else(Error::from_win32)?;
    let thread = OwnedHandle::new(pi.hThread).ok_or_else(Error::from_win32)?;

    // Into the job BEFORE it runs, then release it.
    crate::job::assign_process(job, process.get())?;
    unsafe {
        ResumeThread(thread.get());
        WaitForSingleObject(process.get(), INFINITE);
    }

    let mut code: u32 = 0;
    unsafe {
        GetExitCodeProcess(process.get(), &mut code)?;
    }
    Ok(code)
}

/// A RAII proc-thread attribute list. `InitializeProcThreadAttributeList` is
/// called twice (size query, then real init); each `set` is one
/// `UpdateProcThreadAttribute`. The backing buffer and every value pointer must
/// outlive the CreateProcess call, so callers keep the value storage alive.
struct ProcThreadAttrList {
    buffer: Vec<u8>,
}

impl ProcThreadAttrList {
    fn with_capacity(count: u32) -> Result<Self> {
        let mut size: usize = 0;
        unsafe {
            // First call returns the required byte size (ignore the expected error).
            let _ = InitializeProcThreadAttributeList(
                LPPROC_THREAD_ATTRIBUTE_LIST(std::ptr::null_mut()),
                count,
                0,
                &mut size,
            );
        }
        let mut buffer = vec![0u8; size];
        unsafe {
            InitializeProcThreadAttributeList(
                LPPROC_THREAD_ATTRIBUTE_LIST(buffer.as_mut_ptr() as *mut c_void),
                count,
                0,
                &mut size,
            )?;
        }
        Ok(Self { buffer })
    }

    fn as_ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        LPPROC_THREAD_ATTRIBUTE_LIST(self.buffer.as_mut_ptr() as *mut c_void)
    }

    fn set(&mut self, attribute: usize, value: *mut c_void, size: usize) -> Result<()> {
        unsafe {
            UpdateProcThreadAttribute(self.as_ptr(), 0, attribute, Some(value), size, None, None)?;
        }
        Ok(())
    }
}

impl Drop for ProcThreadAttrList {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(LPPROC_THREAD_ATTRIBUTE_LIST(
                self.buffer.as_mut_ptr() as *mut c_void,
            ));
        }
    }
}

/// Join an argv into a single Windows command line, quoting per the
/// CommandLineToArgvW rules (backslashes are only special before a quote).
/// The child (cmd.exe / PowerShell) parses argv[0] as its own path; the tail is
/// the shell flags and the one command string, already composed by Node.
pub fn argv_to_command_line(argv: &[String]) -> String {
    let mut out = String::new();
    for (i, arg) in argv.iter().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\u{b}', '"']) {
            out.push_str(arg);
        } else {
            out.push('"');
            let mut backslashes = 0usize;
            for ch in arg.chars() {
                match ch {
                    '\\' => {
                        backslashes += 1;
                    }
                    '"' => {
                        // Escape all pending backslashes (they precede a quote) and the quote.
                        out.extend(std::iter::repeat('\\').take(backslashes * 2 + 1));
                        backslashes = 0;
                        out.push('"');
                    }
                    _ => {
                        out.extend(std::iter::repeat('\\').take(backslashes));
                        backslashes = 0;
                        out.push(ch);
                    }
                }
            }
            // Trailing backslashes precede the closing quote, so double them.
            out.extend(std::iter::repeat('\\').take(backslashes * 2));
            out.push('"');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::argv_to_command_line;

    #[test]
    fn quotes_only_when_needed() {
        assert_eq!(argv_to_command_line(&["cmd.exe".into()]), "cmd.exe");
        assert_eq!(
            argv_to_command_line(&["a".into(), "b".into()]),
            "a b"
        );
    }

    #[test]
    fn quotes_spaces_and_escapes_quotes_and_backslashes() {
        assert_eq!(
            argv_to_command_line(&["a b".into()]),
            "\"a b\""
        );
        // A literal quote is backslash-escaped.
        assert_eq!(argv_to_command_line(&["a\"b".into()]), "\"a\\\"b\"");
        // Trailing backslashes before the closing quote are doubled.
        assert_eq!(argv_to_command_line(&["a\\".into(), "x y".into()]), "a\\ \"x y\"");
        assert_eq!(argv_to_command_line(&["a b\\".into()]), "\"a b\\\\\"");
    }
}
