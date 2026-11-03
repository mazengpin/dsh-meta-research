# CONTEXT - dsh-meta-research

## The problem

The program keeps its record in four places - the decision log, the intent field, the intent map and the profile manifest - and none of them is compared with the others, so drift stays invisible until a human notices two records disagreeing.

dsh-meta-research makes that comparison a measurement: four checks, each with a numerator and a denominator, plus one written artifact that says what was read and what it found.

## The context and the constraint that shaped it

The program workspace is neither the package nor the profile: it is a directory inside a profile, at profiles-tree/<tier>/<name>, holding AGENTS.md, plan/ and research/.

That layout IS the constraint. A package installed from a tarball lives wherever the package manager put it, so any path compiled into the bundle is correct on exactly one machine, and the first run elsewhere would write its artifact into a tree that does not exist.

Discovery exists because of that constraint, not because configuration was inconvenient: the workspace is found by its markers in a stated order, and a wrong answer is REPORTED by the checks rather than hidden.

The same reasoning removed the hard-coded port: a harness may listen on any port, so the origin is read from the Host header of the request that runs the census.

A third constraint was learned the hard way: the artifact write was not atomic and a real Windows lock reproduced as UNKNOWN: unknown error, so the write became a temp sibling plus a rename, retried for EPERM|EBUSY|EACCES|UNKNOWN.

## The intent, and what was deliberately NOT attempted

Intent: a research half that MEASURES drift on a live program and never repairs it, and that can be installed on another machine without editing a path by hand.

Deliberately not attempted:

- Automatic repair of any drift it finds.
- A scheduler inside the plugin; the census is per POST /meta-research/api/run.
- A model call or a device: the embedder check reads RESIDENCY METADATA only, and an unconfigured meter is NOT MEASURED with a reason.
- Comparing the index model name with the loaded blob path llama.cpp publishes, which would manufacture a naming difference as a drift finding.
- A corpus commit fingerprint in the artifact; that is a 1.0.0 item named in ROADMAP.md.

## Alternatives rejected

- Default embedder meter on the local inference server (its port is withheld here; the route is a server-agnostic /api/ps): REJECTED, and the reason IS recorded. That server is stopped on this host and answers 000, so check (d) reported of:null with unreadable: TypeError: ECONNREFUSED on every run, and the census could never reach 4 of 4.
- Re-pointing that meter at llama.cpp /v1/models: REJECTED, and the reason IS recorded. That route publishes the loaded blob path, not a model name, so the comparison would manufacture drift out of a naming difference.
- Any further alternative rejected during development: NOT RECORDED. Only the two above carry a recorded reason, and an unrecorded rejection must not be presented as one.

## Recreate a working environment (node, pnpm, git only)

1. node --version - must satisfy >=22.18.0, because the verify harness runs TypeScript by type stripping.
2. git clone <repo> plugins-src/dsh-meta-research and cd into it.
3. pnpm install.
4. pnpm run build - expect exit 0 and lib/index.js plus lib/client.js.
5. pnpm run typecheck - expect exit 0.
6. pnpm run verify - expect exit 0, CHECKS: 17/17 passed, MUTATIONS: 5/5, asserts: 45/45 passed.
7. Put the package into a profile with a RELATIVE link: dependency plus a dsh.profile.bundles entry, then restart the harness; a bundles change alone hot-reloads.
8. If discovery must be steered, set DSH_META_RESEARCH_WORKSPACE to the workspace root - an explicit answer wins over every search step.

## What to read next

- README.md - routes, configuration keys, environment overrides and the DEVELOPER versus CONSUMER install split.
- DISCLOSURE.md - what it does today, what it does NOT do, data paths, network, security posture and the SOURCE PREVIEW state.
- ROADMAP.md - what 1.0.0 still requires.
- verify/host-half.ts and verify/observer-render.mjs - the assertions, which are the specification.
