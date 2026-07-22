//! The on-disk policy contract, deserialized from the JSON file whose path is
//! `argv[1]`. This MUST stay in lockstep with `WindowsHelperPolicy` in
//! `packages/cortex-sandbox/src/windows.ts`: the TS provider writes this file,
//! the helper reads it, and a field rename on either side silently breaks
//! containment. Both carry `version`, and the helper rejects a mismatch.
//!
//! Security rule (CVE-2025-59532): `writable_roots` is authored from trusted
//! session config on the Node side. The helper treats it as ground truth and
//! never widens it from anything the model controls (there is no command-derived
//! writable root here; the command is only ever the argv tail after `--`).

use serde::Deserialize;
use std::path::PathBuf;

/// The single supported policy schema version. Bump in lockstep with
/// `WINDOWS_POLICY_VERSION` on the TS side.
pub const SUPPORTED_VERSION: u32 = 1;

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    /// Schema version; must equal `SUPPORTED_VERSION`.
    pub version: u32,

    /// Name used to derive the restricting capability SID (via a deterministic
    /// synthetic SID string, see sid.rs). The Node side derives it per install AND per workspace
    /// (base name + a stable hash of the canonical workspace roots), so one
    /// workspace's persisted grant ACEs never authorize a token created for
    /// another workspace. Deterministic per workspace, so ACEs are reused
    /// across runs rather than accumulated.
    #[serde(rename = "capabilitySidName")]
    pub capability_sid_name: String,

    /// Absolute paths the sandboxed child may write. Includes `sandbox_temp`.
    #[serde(rename = "writableRoots")]
    pub writable_roots: Vec<PathBuf>,

    /// The per-session sandbox temp dir (a member of `writable_roots`). Called
    /// out separately so the helper can Low-label it even if the child's TEMP is
    /// pointed here.
    #[serde(rename = "sandboxTemp")]
    pub sandbox_temp: PathBuf,

    /// Secret paths given deny-read ACEs. INERT at Tier 1 (a same-user
    /// WRITE_RESTRICTED token only restricts writes; reads ride the normal
    /// token); kept for a Tier-2 dedicated-user token, which evaluates them.
    #[serde(rename = "denyReadPaths")]
    pub deny_read_paths: Vec<PathBuf>,

    /// Absolute paths that must never be written (agent config, `.git/hooks`,
    /// `.git/config`, and the policy file's own directory).
    #[serde(rename = "denyWritePaths")]
    pub deny_write_paths: Vec<PathBuf>,

    /// Drop the child token to Low integrity. See integrity.rs for the MIC
    /// implications (writable roots must then also be Low-labeled).
    #[serde(rename = "lowIntegrity")]
    pub low_integrity: bool,
}

/// Case-folded, separator-normalized, trailing-separator-stripped key for
/// comparing two Windows paths for identity (mirrors the TS provider's
/// `normalizeWindowsPath`).
fn normalized_path_key(path: &std::path::Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

#[derive(Debug)]
pub enum PolicyError {
    Read(std::io::Error),
    Parse(serde_json::Error),
    UnsupportedVersion { found: u32, supported: u32 },
    Empty(&'static str),
}

impl std::fmt::Display for PolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PolicyError::Read(e) => write!(f, "could not read policy file: {e}"),
            PolicyError::Parse(e) => write!(f, "could not parse policy JSON: {e}"),
            PolicyError::UnsupportedVersion { found, supported } => write!(
                f,
                "unsupported policy version {found} (helper supports {supported}); \
                 the @animus-labs/cortex-sandbox provider and this helper are out of sync"
            ),
            PolicyError::Empty(field) => write!(f, "policy field `{field}` must not be empty"),
        }
    }
}

impl std::error::Error for PolicyError {}

impl Policy {
    /// The writable roots to enforce: `writable_roots` plus `sandbox_temp` if
    /// the policy did not already list it. The TS provider always includes the
    /// sandbox temp in `writableRoots`, but the helper must not depend on that:
    /// the child's TEMP/TMP point at `sandbox_temp`, so a policy that omitted it
    /// would break every temp write while still claiming containment.
    /// Comparison is case-insensitive with separators normalized, matching how
    /// Windows treats paths and how the TS side canonicalizes them.
    pub fn effective_writable_roots(&self) -> Vec<PathBuf> {
        let mut roots = self.writable_roots.clone();
        let has_temp = roots
            .iter()
            .any(|r| normalized_path_key(r) == normalized_path_key(&self.sandbox_temp));
        if !has_temp {
            roots.push(self.sandbox_temp.clone());
        }
        roots
    }

    /// Load, parse, and validate the policy from a JSON file path.
    ///
    /// TODO(windows-build): before trusting the file, reject one not owned by
    /// the current user (GetNamedSecurityInfoW with OWNER_SECURITY_INFORMATION
    /// and compare against the process token's user SID). The Node side already
    /// keeps the file outside every writable root and deny-writes its
    /// directory, but an owner check closes the remaining local-tamper window
    /// (another process of a different user swapping in attacker-chosen
    /// writable roots).
    pub fn load(path: &std::path::Path) -> Result<Self, PolicyError> {
        let text = std::fs::read_to_string(path).map_err(PolicyError::Read)?;
        // Tolerate a UTF-8 BOM: the TS provider writes without one, but a
        // hand-authored policy from PowerShell/Notepad usually carries it and
        // serde_json rejects it as a parse error.
        let text = text.trim_start_matches('\u{feff}');
        let policy: Policy = serde_json::from_str(text).map_err(PolicyError::Parse)?;
        policy.validate()?;
        Ok(policy)
    }

    fn validate(&self) -> Result<(), PolicyError> {
        if self.version != SUPPORTED_VERSION {
            return Err(PolicyError::UnsupportedVersion {
                found: self.version,
                supported: SUPPORTED_VERSION,
            });
        }
        if self.capability_sid_name.trim().is_empty() {
            return Err(PolicyError::Empty("capabilitySidName"));
        }
        // A workspace-write sandbox with no writable root would fail every
        // write; that is a misconfiguration, not an intended read-only run
        // (the Restricted rung skips the helper entirely on the Node side).
        if self.writable_roots.is_empty() {
            return Err(PolicyError::Empty("writableRoots"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // These tests are pure serde/validation and are the ONLY part of the crate
    // that is platform-independent. They are documented here for when the crate
    // is first built on Windows CI; they do not run on the macOS host that
    // authored the scaffold.
    fn sample_json() -> &'static str {
        r#"{
            "version": 1,
            "capabilitySidName": "cortex-sandbox-install-1",
            "writableRoots": ["C:\\ws", "C:\\Temp\\cortex-sbx-1"],
            "sandboxTemp": "C:\\Temp\\cortex-sbx-1",
            "denyReadPaths": ["C:\\Users\\me\\.ssh"],
            "denyWritePaths": ["C:\\Users\\me\\.cortex"],
            "lowIntegrity": true
        }"#
    }

    #[test]
    fn parses_and_validates_a_well_formed_policy() {
        let p: Policy = serde_json::from_str(sample_json()).expect("parse");
        p.validate().expect("valid");
        assert_eq!(p.version, SUPPORTED_VERSION);
        assert_eq!(p.capability_sid_name, "cortex-sandbox-install-1");
        assert_eq!(p.writable_roots.len(), 2);
        assert!(p.low_integrity);
    }

    #[test]
    fn rejects_a_version_mismatch() {
        let bumped = sample_json().replace("\"version\": 1", "\"version\": 999");
        let p: Policy = serde_json::from_str(&bumped).expect("parse");
        assert!(matches!(
            p.validate(),
            Err(PolicyError::UnsupportedVersion { found: 999, .. })
        ));
    }

    #[test]
    fn rejects_empty_writable_roots() {
        let none = sample_json().replace(
            "\"writableRoots\": [\"C:\\\\ws\", \"C:\\\\Temp\\\\cortex-sbx-1\"]",
            "\"writableRoots\": []",
        );
        let p: Policy = serde_json::from_str(&none).expect("parse");
        assert!(matches!(p.validate(), Err(PolicyError::Empty("writableRoots"))));
    }

    #[test]
    fn effective_writable_roots_reuses_a_listed_sandbox_temp() {
        let p: Policy = serde_json::from_str(sample_json()).expect("parse");
        // sample lists the temp in writableRoots (differing only in case would also match)
        assert_eq!(p.effective_writable_roots().len(), 2);
    }

    #[test]
    fn effective_writable_roots_appends_a_missing_sandbox_temp() {
        let missing = sample_json().replace(
            "\"writableRoots\": [\"C:\\\\ws\", \"C:\\\\Temp\\\\cortex-sbx-1\"]",
            "\"writableRoots\": [\"C:\\\\ws\"]",
        );
        let p: Policy = serde_json::from_str(&missing).expect("parse");
        let roots = p.effective_writable_roots();
        assert_eq!(roots.len(), 2);
        assert_eq!(roots[1], std::path::PathBuf::from("C:\\Temp\\cortex-sbx-1"));
    }

    #[test]
    fn effective_writable_roots_matches_temp_case_insensitively() {
        let cased = sample_json().replace(
            "\"sandboxTemp\": \"C:\\\\Temp\\\\cortex-sbx-1\"",
            "\"sandboxTemp\": \"c:\\\\temp\\\\CORTEX-SBX-1\\\\\"",
        );
        let p: Policy = serde_json::from_str(&cased).expect("parse");
        assert_eq!(p.effective_writable_roots().len(), 2);
    }

    #[test]
    fn rejects_unknown_fields_so_drift_is_loud() {
        let extra = sample_json().replace(
            "\"lowIntegrity\": true",
            "\"lowIntegrity\": true, \"unexpected\": 1",
        );
        assert!(serde_json::from_str::<Policy>(&extra).is_err());
    }
}
