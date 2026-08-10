# Changelog

All notable changes to `@animus-labs/cortex-code` are documented here.

## Unreleased

- **Session files moved to a composite artifact, and the move is one-way.**
  A session now saves as `state.json`, which carries the session log, both
  agent loops' histories, observational memory and per-loop usage. The old
  pair (`history.json` plus `observations.json`) is still read, so existing
  sessions resume untouched, but sessions written by this version are not
  readable by an earlier build: downgrading and running `/resume` on one
  reports "Session not found". The durable `transcript.jsonl` is unaffected
  and stays readable by anything.
- Sessions are written to disk at startup and at every turn boundary, so a
  crash during a long task no longer loses the session.
- Add upcoming changes here before cutting a release tag.

## 0.5.0

- Show compact in-place retry status and surface error cause details.
- Answer permission prompts out of band through a control file.
- Show edited file paths under collapsed change groups.
- Add durable session transcript logging.
- Collapse tool display into a borderless activity stream.
- Add a lightweight complete command.
- Rebrand the TUI and OAuth callback page.
- Bundle brand assets through `tsup` and declare the `pi-ai` dependency.
