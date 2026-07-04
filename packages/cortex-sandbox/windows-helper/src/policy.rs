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

    /// Stable per-install name fed to `DeriveCapabilitySidsFromName` to derive
    /// the restricting capability SID. Deterministic, so ACEs are reused across
    /// runs rather than accumulated.
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

    /// Absolute paths that must never be readable (secret stores, credential files).
    #[serde(rename = "denyReadPaths")]
    pub deny_read_paths: Vec<PathBuf>,

    /// Absolute paths that must never be written (agent config, `.git/hooks`, `.git/config`).
    #[serde(rename = "denyWritePaths")]
    pub deny_write_paths: Vec<PathBuf>,

    /// Drop the child token to Low integrity. See integrity.rs for the MIC
    /// implications (writable roots must then also be Low-labeled).
    #[serde(rename = "lowIntegrity")]
    pub low_integrity: bool,
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
    /// Load, parse, and validate the policy from a JSON file path.
    pub fn load(path: &std::path::Path) -> Result<Self, PolicyError> {
        let text = std::fs::read_to_string(path).map_err(PolicyError::Read)?;
        let policy: Policy = serde_json::from_str(&text).map_err(PolicyError::Parse)?;
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
    fn rejects_unknown_fields_so_drift_is_loud() {
        let extra = sample_json().replace(
            "\"lowIntegrity\": true",
            "\"lowIntegrity\": true, \"unexpected\": 1",
        );
        assert!(serde_json::from_str::<Policy>(&extra).is_err());
    }
}
