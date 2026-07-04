//! Job object: bound the child (and any grandchildren) and guarantee cleanup.
//!
//! - JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is the load-bearing one: when the helper
//!   exits (or is killed), the job handle closes and Windows terminates every
//!   process in the job. A command that tries to outlive the helper by spawning
//!   a detached child cannot escape.
//! - JOB_OBJECT_LIMIT_ACTIVE_PROCESS caps the process count, blunting fork bombs.
//! - JOB_OBJECT_LIMIT_JOB_MEMORY (optional) caps total committed memory.
//!
//! The child must be created SUSPENDED and assigned to the job BEFORE it runs
//! (see process.rs), so it is inside the job for its whole life; assigning after
//! it has already spawned its own children would leave a race.

use std::ffi::c_void;
use windows::core::{Error, Result};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JobObjectExtendedLimitInformation,
};

use crate::winutil::OwnedHandle;

/// Cap on simultaneous processes in the job. High enough for normal parallel
/// builds/test runners, low enough to bound a runaway fork.
const ACTIVE_PROCESS_LIMIT: u32 = 4096;

/// Optional total-committed-memory cap for the whole job, in bytes. Default None:
/// a job-wide memory cap easily breaks legitimate work (a single C++/Rust link
/// can commit many GB), so it is left to the operator to set deliberately rather
/// than shipped as a footgun. Wire it here when a deployment wants it.
const JOB_MEMORY_LIMIT_BYTES: Option<usize> = None;

/// Create the kill-on-close job with the resource caps applied.
pub fn create_sandbox_job() -> Result<OwnedHandle> {
    unsafe {
        let handle = CreateJobObjectW(None, windows::core::PCWSTR::null())?;
        let job = OwnedHandle::new(handle).ok_or_else(Error::from_win32)?;

        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        let mut flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        info.BasicLimitInformation.ActiveProcessLimit = ACTIVE_PROCESS_LIMIT;
        if let Some(bytes) = JOB_MEMORY_LIMIT_BYTES {
            flags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
            info.JobMemoryLimit = bytes;
        }
        info.BasicLimitInformation.LimitFlags = flags;

        SetInformationJobObject(
            job.get(),
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )?;
        Ok(job)
    }
}

/// Put a (suspended) process into the job.
pub fn assign_process(job: &OwnedHandle, process: HANDLE) -> Result<()> {
    unsafe { AssignProcessToJobObject(job.get(), process) }
}
