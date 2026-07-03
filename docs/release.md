# Release process

Cortex uses separate tag-triggered release workflows for the framework package and the CLI package. The workflows stage packages on npm with trusted publishing. A maintainer still approves the staged package with 2FA before it goes live.

No npm publish token should be stored in GitHub.

## Release paths

| Package | Workflow | Tag format |
| --- | --- | --- |
| `@animus-labs/cortex` | `.github/workflows/release-cortex.yml` | `cortex-vX.Y.Z` |
| `@animus-labs/cortex-code` | `.github/workflows/release-cortex-code.yml` | `cortex-code-vX.Y.Z` |

Each workflow rejects the release if the tag does not match the package version, if the changelog is missing that version, or if the package version is already published on npm.

The verify job builds and packs the tarball without OIDC publish permissions. The stage job has OIDC permission, but it does not check out repository code or install project dependencies. It only downloads the verified tarball artifact and stages that tarball on npm.

## One-time GitHub setup

Create a GitHub environment named `npm-publish`.

Recommended settings:

- Add required reviewers.
- Prevent self-review if there is more than one maintainer.
- Restrict deployment tags to `cortex-v*` and `cortex-code-v*`.

The environment approval happens before npm receives an OIDC token.

## One-time npm setup

Configure trusted publishing for both npm packages.

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
