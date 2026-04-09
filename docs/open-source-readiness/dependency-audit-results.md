# Dependency Audit Results

Date: 2026-04-08

## Summary

Production dependency audit is now clean. All three production advisories were resolved by updating transitive dependency versions in the lock file via `npm audit fix`. No direct dependency version changes were required.

## Baseline (Before Fix)

Running `npm audit --workspaces --omit=dev --audit-level=high` reported 3 vulnerabilities (2 moderate, 1 high):

| Package | Severity | Advisory | Chain |
|---------|----------|----------|-------|
| basic-ftp 5.2.0 | High | GHSA-chqc-8p9q-pq6q (FTP Command Injection via CRLF) | cortex -> pi-ai -> proxy-agent -> pac-proxy-agent -> get-uri -> basic-ftp |
| hono <=4.12.11 | Moderate | 5 advisories (cookie validation, IP matching, path traversal, middleware bypass) | cortex -> @modelcontextprotocol/sdk -> hono |
| @hono/node-server <1.19.13 | Moderate | GHSA-92pp-h63x-v22m (middleware bypass via repeated slashes in serveStatic) | cortex -> @modelcontextprotocol/sdk -> @hono/node-server |

## Resolution

`npm audit fix` updated three transitive dependencies within their existing semver ranges. Only `package-lock.json` changed; no `package.json` modifications were needed.

| Package | Before | After | Fix |
|---------|--------|-------|-----|
| basic-ftp | 5.2.0 | 5.2.1 | Patches CRLF injection |
| hono | 4.12.10 | 4.12.12 | Patches all 5 moderate advisories |
| @hono/node-server | 1.19.12 | 1.19.13 | Patches serveStatic middleware bypass |

### Post-fix production audit

```
$ npm audit --workspaces --omit=dev
found 0 vulnerabilities
```

## Reachability Analysis

Neither vulnerability is reachable in Cortex's runtime:

### basic-ftp (High)

The chain is: `pi-ai -> proxy-agent -> pac-proxy-agent -> get-uri -> basic-ftp`. The `basic-ftp` module is only invoked when `get-uri` resolves an `ftp://` URI from a PAC proxy configuration file. Cortex does not use FTP URIs, and modern proxy configurations virtually never reference FTP endpoints. The vulnerability (CRLF injection in FTP commands) requires a malicious FTP server, so even if basic-ftp were invoked, exploitation would require an attacker-controlled network configuration.

### hono and @hono/node-server (Moderate)

The MCP SDK uses `@hono/node-server` only in its server-side `streamableHttp` module (`@modelcontextprotocol/sdk/server/streamableHttp`). Cortex imports exclusively from the MCP client modules (`@modelcontextprotocol/sdk/client/*`). The vulnerable code paths (cookie handling, IP restriction, static file serving, path traversal in SSG) are in server features that Cortex never loads or executes.

## Remaining Advisories (Dev-Only)

5 moderate severity advisories remain in dev dependencies only. These do not affect production:

| Package | Severity | Advisory | Chain |
|---------|----------|----------|-------|
| esbuild <=0.24.2 | Moderate | GHSA-67mh-4wv8-2f99 (dev server request forwarding) | vitest -> vite -> esbuild |

This is a single root-cause vulnerability in esbuild's development server. The 5 reported entries are the same advisory cascading through the dependency chain (esbuild, vite, vite-node, @vitest/mocker, vitest). Fixing it requires upgrading vitest to v4.x (breaking change from current v2.x).

This advisory only applies to esbuild's local development server and has no production impact. It should be addressed when the project upgrades to vitest v4.

## Direct Dependency Upgrade Assessment

### Current versions

- `@mariozechner/pi-ai`: resolved 0.58.4 (latest 0.66.1, specifier `^0.58.0`)
- `@mariozechner/pi-agent-core`: resolved 0.58.4 (latest 0.66.1, specifier `^0.58.0`)
- `@modelcontextprotocol/sdk`: resolved 1.29.0 (latest 1.29.0, specifier `^1.27.1`)

### @modelcontextprotocol/sdk

Already at the latest version (1.29.0). No action needed.

### @mariozechner/pi-ai and pi-agent-core

Upgrading from 0.58.x to 0.66.x is a significant version jump (8 minor versions in a 0.x package, where minor versions can contain breaking changes). This upgrade is NOT needed to fix any of the current audit advisories, since `npm audit fix` already resolved the basic-ftp issue within the current version range.

Upgrading pi-ai/pi-agent-core should be evaluated separately for feature and compatibility reasons, not as a security remediation. Notable changes in the newer versions likely include API modifications that would require code adjustments.

## Recommended Next Steps

1. **Commit the lock file update.** This resolves all production advisories with zero code changes.
2. **Evaluate vitest v4 upgrade.** When ready, upgrade vitest to address the dev-only esbuild advisory. This is low priority since it only affects local development.
3. **Evaluate pi-ai/pi-agent-core upgrade separately.** Track upstream changes and plan an upgrade when there is a feature motivation, not just for the security fix (which is already resolved).
4. **Add `npm audit --omit=dev --audit-level=high` to CI.** This prevents new production advisories from being introduced silently.
