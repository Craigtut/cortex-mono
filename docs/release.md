# Release process

Cortex uses separate tag-triggered release workflows for the framework, sandbox, and CLI packages. The workflows stage packages on npm with trusted publishing. A maintainer still approves the staged package with 2FA before it goes live. A package's first publication must be done manually because npm cannot stage a brand-new package.

No npm publish token should be stored in GitHub.

## Release paths

| Package | Workflow | Tag format |
| --- | --- | --- |
| `@animus-labs/cortex` | `.github/workflows/release-cortex.yml` | `cortex-vX.Y.Z` |
| `@animus-labs/cortex-sandbox` | `.github/workflows/release-cortex-sandbox.yml` | `cortex-sandbox-vX.Y.Z` |
| `@animus-labs/cortex-code` | `.github/workflows/release-cortex-code.yml` | `cortex-code-vX.Y.Z` |

Each workflow rejects the release if the tag does not match the package version, if the changelog is missing that version, or if the package version is already published on npm.

The verify job builds and packs the tarball without OIDC publish permissions. The stage job has OIDC permission, but it does not check out repository code or install project dependencies. It only downloads the verified tarball artifact and stages that tarball on npm.

## One-time GitHub setup

Create a GitHub environment named `npm-publish`.

Recommended settings:

- Add required reviewers.
- Prevent self-review if there is more than one maintainer.
- Restrict deployment tags to `cortex-v*`, `cortex-sandbox-v*`, and `cortex-code-v*`.

The environment approval happens before npm receives an OIDC token.

## One-time npm setup

Configure trusted publishing for each npm package after its first publication.

For `@animus-labs/cortex`:

- Publisher: GitHub Actions
- Repository: this repository
- Workflow filename: `release-cortex.yml`
- Environment: `npm-publish`
- Allowed action: `npm stage publish`

For `@animus-labs/cortex-code`:

- Publisher: GitHub Actions
- Repository: this repository
- Workflow filename: `release-cortex-code.yml`
- Environment: `npm-publish`
- Allowed action: `npm stage publish`

Then set each package's publishing access to require 2FA and disallow tokens.

For `@animus-labs/cortex-sandbox`, use the same settings with workflow filename
`release-cortex-sandbox.yml` after the initial manual publication. The sandbox
and CLI workflows check that their workspace dependency versions are already
available on npm, so publish and approve dependencies before triggering them.

## Release 0.6.0

The registry check on 2026-09-06 found Cortex and Cortex Code at `0.5.0`, both
published from commit `1e88afe4b37435bf607ccc646bbf8acb1afdff66`. The sandbox
package returned 404. The next release set is:

| Order | Package | Version | Reason |
| --- | --- | --- | --- |
| 1 | `@animus-labs/cortex` | `0.6.0` | Breaking API restructure and new sandbox/duplex capabilities. |
| 2 | `@animus-labs/cortex-sandbox` | `0.1.0` | First release; requires Cortex `^0.6.0`. |
| 3 | `@animus-labs/cortex-code` | `0.6.0` | New framework dependency, sandbox integration, and session format. |

This is a minor version boundary for the pre-1.0 packages, not a patch:
the former `CortexAgent` is now `AgentLoop`, the new facade defaults to duplex,
and saved CLI sessions cannot be read by older builds after migration. Existing
`^0.5.0` consumers will not automatically receive `0.6.0`. See each package's
changelog for the complete release notes.

Validate locally before release:

```bash
npm run release:check:cortex
npm run release:check:cortex-sandbox
npm run release:check:cortex-code
```

Publish and approve Cortex `0.6.0` through its tag workflow first. Then pack and
review the initial sandbox tarball, and publish it interactively with npm 2FA:

```bash
mkdir -p release-artifacts
npm pack -w packages/cortex-sandbox --pack-destination release-artifacts
npm publish ./release-artifacts/animus-labs-cortex-sandbox-0.1.0.tgz --access public
```

Do not trigger the sandbox staging workflow for this first version.
[npm staged publishing requires an existing package](https://docs.npmjs.com/staged-publishing/).
Configure its trusted publisher after this initial publication for subsequent
releases. Finally, trigger and approve Cortex Code `0.6.0` through its tag workflow.

The sandbox `0.1.0` tarball does not contain the signed Windows helper. It
provides macOS/Linux backends and the Windows provider interface, with honest
no-containment reporting when no helper is supplied. A release promising native
Windows containment must wait for signing and Windows artifact automation
described in `docs/cortex/windows-sandbox-build.md`. Cortex Code keeps Windows
containment opt-in and supports `sandbox.requireEnforcement`.

The commands above are publishing instructions, not actions performed by local
release preparation. npm and GitHub approvals still apply.

Local preparation passed all three package release checks (2,966 framework,
99 sandbox, and 575 CLI tests; 12 sandbox tests skipped), lint with no errors,
and all 28 documentation examples. Installing the three tarballs together in a
clean directory passed dependency resolution, framework/sandbox imports, model
lookup, and CLI startup. The isolated production dependency audit reported zero
vulnerabilities. These checks ran on macOS with Node 25.2.1; remote release jobs
and Windows helper signing were not run.

## Prepare a Cortex release

```bash
npm version -w packages/cortex patch --no-git-tag-version
```

Update `packages/cortex/CHANGELOG.md` by moving the relevant `Unreleased` entries under the new version heading.

Commit the version and changelog changes:

```bash
git add package.json package-lock.json packages/cortex/package.json packages/cortex/CHANGELOG.md
git commit -m "chore(release): bump cortex to X.Y.Z"
```

Create and push the tag:

```bash
git tag cortex-vX.Y.Z
git push origin main
git push origin cortex-vX.Y.Z
```

After the workflow stages the package, review and approve the staged release on npmjs.com or with the npm CLI:

```bash
npm stage list @animus-labs/cortex
npm stage view <stage-id>
npm stage download <stage-id>
npm stage approve <stage-id>
```

## Prepare a Cortex Code release

```bash
npm version -w packages/cortex-code patch --no-git-tag-version
```

Update `packages/cortex-code/CHANGELOG.md` by moving the relevant `Unreleased` entries under the new version heading.

Commit the version and changelog changes:

```bash
git add package.json package-lock.json packages/cortex-code/package.json packages/cortex-code/CHANGELOG.md
git commit -m "chore(release): bump cortex-code to X.Y.Z"
```

Create and push the tag:

```bash
git tag cortex-code-vX.Y.Z
git push origin main
git push origin cortex-code-vX.Y.Z
```

After the workflow stages the package, review and approve the staged release on npmjs.com or with the npm CLI:

```bash
npm stage list @animus-labs/cortex-code
npm stage view <stage-id>
npm stage download <stage-id>
npm stage approve <stage-id>
```
