# dsh-meta-research

> **Status: PRE-RELEASE `0.9.0` — under active development.** This package is published on the `next` dist-tag, not `latest`.
> Its API, wire records and panel contracts may change between `0.9.x` releases, and each package carries its own `ROADMAP.md` naming what `1.0.0` still requires.
> A published tarball is a snapshot of a moving surface: read `ROADMAP.md` before depending on a shape.

The research half of the meta layer: it answers ONE question with evidence — where has the program drifted from its own record?

It reads four live sources, computes a four-check drift census with a numerator and a denominator per check, and writes exactly one artifact. It edits nothing: not the plan, not the decision log, not the intent map, not the profile manifest.

- Decision log — GET /decision-log/api/list on the harness that serves this plugin.
- Intent map — GET /intent-map/api/map on the same origin.
- Intent field — <workspace>/plan/intent-field/field.json on disk.
- Profile manifest — the nearest package.json above the workspace's parent, on disk.
- Embedder residency — OPTIONAL, empty by default. An unconfigured meter is reported as NOT MEASURED with that reason, never as zero drift.

## Install (consumer)

A consumer installs the PUBLISHED PRE-RELEASE only:

    pnpm add dsh-meta-research@next

Then add it to the profile bundle list and restart the harness. A `dsh.profile.bundles` change hot-reloads; anything else needs a restart.

The published tarball is a snapshot of a moving surface: read `ROADMAP.md` before depending on a shape.

## Develop it (maintainer steps, NOT a consumer install)

The clone/relative-`link:` path below is how this package is DEVELOPED and tested against a live harness. It is not an install instruction for a consumer, and a source tree is never the thing a consumer consumes.

1. Clone into the machine's `plugins-src/` and build it:

    git clone <repo> plugins-src/dsh-meta-research
    cd plugins-src/dsh-meta-research
    pnpm install
    pnpm run build

2. Link THAT CLONE into a profile through a **relative** `link:` dependency (absolute paths are forbidden) and add it to the profile's bundle list:

    {
      "dependencies": { "dsh-meta-research": "link:../../plugins-src/dsh-meta-research" },
      "dsh": { "profile": { "bundles": ["dsh-meta-research"] } }
    }

3. Restart the harness. A `dsh.profile.bundles` change hot-reloads; anything else needs a restart.

On either path the program workspace is DISCOVERED at load time (`DSH_META_RESEARCH_WORKSPACE`, then the nearest ancestor carrying `AGENTS.md` + `plan/` + `research/`, then a program workspace under `profiles-tree/<tier>/<name>`, then the working directory). The census origin is taken from the `Host` header of the request that runs it, so the plugin works on any port. A wrong discovery is REPORTED by the checks, not hidden.

## Routes

| Route | Method | Answer |
|---|---|---|
| `/meta-research/api/last` | `GET` | this process's last run, or `last: null` with the note "no run recorded in this process" |
| `/meta-research/api/run` | `POST` | compute the census, write the artifact, return the record |

`last: null` means NOT RUN. It is never a run that happened to find nothing.

The same package registers one client panel through the ui-slots service (the ./client entry), showing the last run, the four checks with their denominators, the findings and the coverage counts. The frame is a bounded flex column: header fixed, body scrolls.

## Configuration

Every key is optional; every key is read.

| Key | Default |
|---|---|
| `workspaceDir` | discovered, as above |
| `recordPath` | `<workspaceDir>/research/meta-research-last.json` |
| `decisionLogUrl` | empty, resolved as `<request origin>/decision-log/api/list` |
| `intentMapUrl` | empty, resolved as `<request origin>/intent-map/api/map` |
| `embedderPsUrl` | empty: NOT MEASURED, with the reason stated in the record |
| `profileManifestPath` | discovered, as above |

Environment overrides: `DSH_META_RESEARCH_WORKSPACE`, `DSH_META_RESEARCH_RECORD`, `DSH_META_RESEARCH_DECISION_LOG_URL`, `DSH_META_RESEARCH_INTENT_MAP_URL`, `DSH_PROFILE_MANIFEST`.

## Verify

    pnpm run typecheck   # tsc --noEmit
    pnpm run build       # tsdown -> lib/index.js (ESM), lib/client.js (CJS)
    pnpm run verify      # drives the real host half, then the built client bundle

`pnpm run verify` needs Node >= 22.18 (it runs the TypeScript harness through type stripping). It exits 0 only when every assertion passes AND every deliberately broken record is REFUSED by the plugin's own validator.

## Limits, stated rather than assumed

- It is a READER. It never repairs drift; it reports it.
- The embedder check cannot go green on a deployment with no `/api/ps`-shaped meter. That is NOT MEASURED with a reason, not a pass.
- The census is computed per `POST /run`; this package does not schedule itself.

MIT licensed. See `LICENSE`.
