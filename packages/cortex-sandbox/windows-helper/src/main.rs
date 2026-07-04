//! cortex-sandbox-helper: the Cortex Windows Tier-1 (unelevated) sandbox helper.
//!
//! Node (@animus-labs/cortex-sandbox) spawns this in place of the shell:
//!
//!     cortex-sandbox-helper.exe <policy.json> -- <shell> <shellArgs...> <command>
//!
//! It reads the policy, builds a WRITE_RESTRICTED restricted token carrying a
//! synthetic capability SID, grants that SID write ACEs on the workspace roots +
//! sandbox temp, layers deny-read/deny-write ACEs over secrets and the agent
//! config, optionally drops to Low integrity, and launches the command inside a
//! kill-on-close job object with process mitigations. It inherits stdio straight
//! through to Node and exits with the child's exit code.
//!
//! FAIL CLOSED: if any containment step fails, the helper prints an error and
//! exits non-zero WITHOUT running the command. It never runs the command
//! uncontained; the "run uncontained" decision belongs to the Node layer (which
//! only does so when the helper binary is absent, and reports that honestly).
//!
//! Windows-only. On any other target this builds to a stub that errors out, so
//! the crate still participates in a cross-platform `cargo build` without
//! pulling in the Win32 surface. The real modules are exercised only by a
//! Windows build/test (see docs/cortex/windows-sandbox-build.md). NOT YET
//! COMPILED OR VERIFIED.

#[cfg(windows)]
mod acl;
#[cfg(windows)]
mod integrity;
#[cfg(windows)]
mod job;
#[cfg(windows)]
mod policy;
#[cfg(windows)]
mod process;
#[cfg(windows)]
mod sid;
#[cfg(windows)]
mod token;
#[cfg(windows)]
mod winutil;

/// Exit code when sandbox setup fails (distinct from any plausible child code so
/// the Node side can tell "the sandbox could not be established" from "the
/// command ran and failed"). 87 == ERROR_INVALID_PARAMETER, a nod to the class
/// of failure and unlikely to collide with a real command's exit code.
#[cfg(windows)]
const SETUP_FAILURE_EXIT: i32 = 87;

#[cfg(windows)]
fn main() {
    let code = match run() {
        Ok(code) => code as i32,
        Err(err) => {
            eprintln!("cortex-sandbox-helper: {err}");
            SETUP_FAILURE_EXIT
        }
    };
    std::process::exit(code);
}

#[cfg(windows)]
fn run() -> Result<u32, Box<dyn std::error::Error>> {
    use std::path::Path;

    // ---- argv: <policy.json> -- <shell> <shellArgs...> <command> ----
    let args: Vec<String> = std::env::args().collect();
    let policy_path = args
        .get(1)
        .filter(|a| *a != "--")
        .ok_or("missing policy file path (argv[1])")?;
    let sep = args
        .iter()
        .position(|a| a == "--")
        .ok_or("missing `--` separator before the command")?;
    let command_argv: Vec<String> = args[sep + 1..].to_vec();
    if command_argv.is_empty() {
        return Err("no command after `--`".into());
    }

    // ---- policy ----
    let policy = policy::Policy::load(Path::new(policy_path))?;

    // ---- principals ----
    let cap = sid::derive_capability_sid(&policy.capability_sid_name)?;
    let everyone = sid::everyone_sid()?;
    let base = token::open_process_token()?;
    let logon = unsafe { sid::logon_sid_from_token(base.get())? };

    // ---- filesystem ACLs (fail closed) ----
    // Grant the capability SID write on each writable root. A failure here means
    // the child could not write its own workspace, so it is fatal.
    for root in &policy.writable_roots {
        acl::grant_write(root, &cap)
            .map_err(|e| format!("grant write on writable root {}: {e}", root.display()))?;
    }
    // Deny read on secret paths and deny write on the agent config. Applied only
    // to paths that exist (a missing secret has nothing to read); an existing
    // path that fails to get its deny ACE is a containment hole => fatal.
    for secret in &policy.deny_read_paths {
        if secret.exists() {
            acl::deny_read(secret, &cap)
                .map_err(|e| format!("deny read on {}: {e}", secret.display()))?;
        }
    }
    for protected in &policy.deny_write_paths {
        if protected.exists() {
            acl::deny_write(protected, &cap)
                .map_err(|e| format!("deny write on {}: {e}", protected.display()))?;
        }
    }

    // ---- restricted token ----
    let restricted = token::create_restricted_token(&base, &[&cap], &logon, &everyone)?;

    // ---- Low integrity (optional) ----
    // Order: Low-label the writable roots BEFORE lowering the token, so the Low
    // child can write them (MIC blocks a Low subject writing a Medium object).
    if policy.low_integrity {
        let low = sid::low_integrity_sid()?;
        for root in &policy.writable_roots {
            integrity::label_path_low(root, &low)
                .map_err(|e| format!("Low-label writable root {}: {e}", root.display()))?;
        }
        integrity::set_token_low_integrity(&restricted, &low)?;
    }

    // ---- job object ----
    let job = job::create_sandbox_job()?;

    // ---- launch + wait ----
    let exit_code = process::spawn_and_wait(&restricted, &job, &command_argv)?;
    Ok(exit_code)
}

#[cfg(not(windows))]
fn main() {
    eprintln!(
        "cortex-sandbox-helper is a Windows-only binary; build it for x86_64-pc-windows-msvc \
         (see docs/cortex/windows-sandbox-build.md)."
    );
    std::process::exit(1);
}
