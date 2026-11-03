# DISCLOSURE - dsh-meta-research 0.9.0

> **State: SOURCE PREVIEW - information-providing only.**
> This tree is readable. It is NOT installable from source.
> Install arrives with the published pre-release tarball on the next dist-tag; latest is not used.
> Until that tarball exists, cloning and building this tree is a MAINTAINER step, not a consumer install.

## 1. What this package is

dsh-meta-research is the research half of the meta layer for the dsh-meta-evolve program, and it is a Cordis plugin: it mounts two host routes and registers one client panel through the ui-slots service.

It answers ONE question with evidence - where has the program drifted from its own record - by reading four live sources, computing a four-check drift census with a numerator and a denominator per check, and writing exactly one artifact.

It is a READER and a RECORDER. It repairs nothing.

## 2. What it does today (measured 2026-11-03)

pnpm run typecheck exits 0 (tsc --noEmit), pnpm run build exits 0 (tsdown: lib/index.js ESM 59.34 kB, lib/client.js CJS 42.93 kB), and pnpm run verify exits 0.

The verify harness has two halves: the host half reports CHECKS: 17/17 passed, MUTATIONS: 5/5 changed the record AND were refused, and VERDICT: PASS; the observer render reports asserts: 45/45 passed against the built bundle (42,926 B, sha256 548a9d48512574e0bc939f2d18abd105c786e78e3962023b45a392d5931e92ba at that run).

Three changes are what made the package usable on a machine that is NOT the development machine:

1. The program workspace is DISCOVERED at load time instead of being compiled in: DSH_META_RESEARCH_WORKSPACE, then the nearest ancestor carrying AGENTS.md + plan/ + research/, then <ancestor>/profiles-tree/<tier>/<name> with the same three markers, then the working directory.
2. The census origin is taken from the request Host header instead of a hard-coded port, so the plugin is not bound to 127.0.0.1:3083.
3. The artifact write is ATOMIC - a temp sibling then a rename - with a retry for EPERM|EBUSY|EACCES|UNKNOWN, added after a real Windows lock reproduced as UNKNOWN: unknown error.

## 3. What it does NOT do

- It does not repair drift and does not edit the plan, the decision log, the intent map or the profile manifest. It writes one artifact plus one transient temp file.
- It does not schedule itself: the census is computed per POST /meta-research/api/run.
- It does not call a model, open a GPU device, or download anything. See section 5.
- It does not authenticate: its two routes inherit the harness web surface, which has no plugin-level auth gate, so any client that can reach the harness can trigger a run and a write.
- It does not record corpus provenance: the artifact carries a timestamp and a route census, not a corpus commit. That is item 1 of ROADMAP.md for 1.0.0 and it is NOT in 0.9.0.
- It does not grade the embedder check green on a deployment with no /api/ps-shaped meter: check (d) reports NOT MEASURED with a reason, never zero drift.
- It does not publish itself: 0.9.0 is a pre-release and no tarball accompanies this source preview.

## 4. Data it reads and writes

Read from disk, inside the discovered workspace: the markers AGENTS.md, plan/ and research/, which are tested with statSync and existsSync and never read as documents; <workspace>/plan/intent-field/field.json; and the profile manifest, which is DSH_PROFILE_MANIFEST, else the nearest package.json above the workspace PARENT.

Read over local HTTP: GET <origin>/decision-log/api/list and GET <origin>/intent-map/api/map, where <origin> is the configured URL or the request Host header.

Written: <workspace>/research/meta-research-last.json, overridable by recordPath or DSH_META_RESEARCH_RECORD - LF, two-space JSON, exactly one trailing newline, validated before it is written. The atomic write uses the sibling <artifact>.tmp-write, renamed onto the artifact and removed on a retry.

Nothing else on disk is touched.

## 5. Network

Routes served, and no others: GET /meta-research/api/last and POST /meta-research/api/run.

Routes called: the two local plugin routes above, on the origin the request arrived at, plus the optional embedder residency meter when embedderPsUrl is set.

It opens NO outbound connection to the internet, performs no lookup beyond the Host it was called on, downloads nothing, and calls NO model: not /api/embed, not /v1/embeddings, not /api/generate, not /api/chat.

## 6. Security posture

The artifact is UNSIGNED. Its provenance is a timestamp (ranAt) plus the route and reading census, where each source carries its location, HTTP status and byte count.

That is provenance of a RUN, not of an AUTHOR. A consumer must not read the artifact as evidence of authorship, and must not treat a file that parses as a file that is truthful: the write is validated for internal consistency only.

GET /last reports the last run of THIS PROCESS and says so; the file is what survives a restart, and a copied or hand-edited file is indistinguishable from a written one.

## 7. Licence and engines

MIT. See LICENSE.

engines: node >=22.18.0 and dsh >=0.2.0-0 <0.3.0. The Node floor is required because pnpm run verify runs the TypeScript harness by type stripping; it is declared rather than worked around for older Node.

No repository URL is declared in package.json, and none is invented here: the release owner sets it at publish time.

## 8. State

SOURCE PREVIEW - information-providing only.

Readable: yes. Installable from source: NO. The install path is the published pre-release tarball on the next dist-tag, which does not exist for 0.9.0 at the time of this writing.

Until it does, the only supported way to run this code is the maintainer path in CONTEXT.md and the DEVELOPER section of README.md.
