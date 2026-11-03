# ROADMAP — dsh-meta-research

**Version `0.9.0` is a PRE-RELEASE.** It is published on the `next` dist-tag and it is under active development: the surface below is what `1.0.0` still requires, not a wish list appended after the fact.

## What this package is

The research half: runs a research round over the program corpus and records the artifact it produced with its own provenance.

## What is measured today

`pnpm run verify` green with the observer render at 45 of 45 asserts (re-measured 2026-11-03: `CHECKS: 17/17 passed`, `MUTATIONS: 5/5`, `asserts: 45/45 passed`); `npm pack --dry-run` 22 files / 74.6 kB at that same run, before `DISCLOSURE.md` and `CONTEXT.md` were added - the older figure of 21 files / 73.7 kB published in this sentence did NOT reproduce and is corrected here, and the count after both documents is 24 files / 78.0 kB; workspace discovery replaces a hard-coded `<home> default and the origin is taken from the request `Host` header, so it is not bound to port 3083; the artifact write is atomic with a retry for `EPERM|EBUSY|EACCES|UNKNOWN` after a real Windows lock reproduced as `UNKNOWN: unknown error`.

## What 1.0.0 still requires

1. Provenance: the artifact must record the corpus commit and the route census it read, not only the timestamp.
2. A round with no findings must be distinguishable from a round that did not run.
3. Bounded run time with a recorded stop reason, so a hung source is an event and not a hang.
4. A refusal when the corpus is older than the artifact it claims to describe.

## Limits, stated rather than implied

`verify` needs Node >= 22.18 because it runs the TypeScript harness by type stripping; declared in `engines` and stated in the README, not fixed for older Node.

## Compatibility seam

Reads the workspace (`AGENTS.md`, `plan/`, `research/`) and the profile manifest; a layout change in the workspace is a discovery change here.

## How this roadmap is graded

An item is DONE only when a command proves it and the command is named here. An item that is only described is not done, and a roadmap whose items all read as prose is a plan, not a state.
