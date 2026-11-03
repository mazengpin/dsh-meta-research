/**
 * dsh-meta-research — the research half of the meta layer.
 *
 * The meta layer folds RESEARCH onto the current architecture. This half answers
 * one question WITH EVIDENCE: **where has the program drifted from its own
 * record?** It is a READER plus a recorder: it reads the decision log and the
 * intent map over HTTP, and `plan/intent-field/field.json` and the profile
 * manifest from disk; it computes a four-check drift census; it writes exactly
 * one artifact, `research/meta-research-last.json`. It does not edit the plan,
 * the log, the map, or the profile.
 *
 * **TWO ROUTES, BOTH STATED ONCE.**
 *
 * - `GET  /meta-research/api/last` — the last run of this process, or
 *   `{"ok":true,"last":null,"note":"no run recorded in this process"}`.
 * - `POST /meta-research/api/run`  — compute the census, record it, return it.
 *
 * The paths live in `host/routes.ts` and are re-exported here; no second copy is
 * hand-written, because an advertised path that the dispatcher does not serve is
 * the `D-0071` failure.
 *
 * **NO DEVICE AND NO MODEL.** Nothing here opens a GPU device, spawns a process,
 * or asks a model to produce anything. The only network reads are the two local
 * plugin routes and the embedder's `/api/ps` RESIDENCY METADATA; inference is
 * `llama.cpp`'s business and its controlling scripts', not this plugin's.
 *
 * @module dsh-meta-research
 */

import { join } from 'node:path'
import type { HostContext } from './types.ts'
import { LAST_PATH, RUN_PATH, mountRoutes } from './host/routes.ts'
import type { MountOptions } from './host/routes.ts'
import { discoverWorkspace, findProfileManifest } from './host/workspace.ts'

export { ARTIFACT_RELATIVE_PATH, LAST_PATH, PREFIX, RUN_PATH } from './host/routes.ts'
export { CHECK_ORDER, FINDING_KINDS } from './host/types.ts'
export type { Census, CheckBase, Finding, RunRecord } from './host/types.ts'
export { validateRunRecord } from './host/validate.ts'
export { discoverWorkspace, findProfileManifest, isProgramWorkspace } from './host/workspace.ts'

/** Plugin name used by loader diagnostics. */
export const name = 'meta-research'

/** The host service this plugin requires before `apply` runs. */
export const inject = ['webServer'] as const

/**
 * The program workspace, which is the canonical root every record path in the
 * census resolves against. Overridable by config or by
 * `DSH_META_RESEARCH_WORKSPACE`; otherwise it is DISCOVERED at load time
 * (`host/workspace.ts`) so that an install with no manual steps finds the
 * records without a path compiled into the bundle.
 */
export const DEFAULT_WORKSPACE = discoverWorkspace()

/** Origin of the two local plugin routes the census reads. */
export const DEFAULT_ORIGIN = 'http://127.0.0.1:3083'

/**
 * Origin of the embedder whose residency metadata check (d) compares.
 *
 * **EMPTY ON PURPOSE: THIS METER HAS NO LIVE DEFAULT ON THIS DEPLOYMENT.** It
 * named `http://127.0.0.1:11434`, ollama's `/api/ps`. Ollama is stopped here
 * (`:11434` answers `000`), so check (d) reported `of:null` with
 * "unreadable: TypeError: ECONNREFUSED" on EVERY run — measured live at
 * 2026-10-26T14:44:21Z, `POST /meta-research/api/run` → `complete:false`,
 * `checksEvaluated {count:3, of:4}` — and the census could never reach 4 of 4.
 *
 * Re-pointing it at the live llama.cpp embedder would be a MISREADING rather
 * than a fix. `GET :8012/v1/models` is the only residency route llama.cpp
 * serves, and it publishes the loaded BLOB PATH
 * (`<home>\\.ollama\\models\\blobs\\sha256-0650…`): `models[].name`,
 * `models[].model`, `data[].id` and `data[].aliases[]` are all that one path
 * (measured 2026-10-26T14:43:17Z, 1,065 B, `meta.n_embd` 1024, `owned_by`
 * "llamacpp"). Comparing a blob path with the index's `qwen3-embedding:0.6b`
 * would MANUFACTURE a drift finding out of a naming difference. The other
 * candidate — asking `POST /v1/embeddings` which model it is — is an inference
 * call this plugin's charter forbids, and its answer echoes the REQUESTED id
 * rather than reporting a served one.
 *
 * So the meter is REQUIRED: config `embedderPsUrl` (or this origin, when a
 * deployment has a real meter) must name a service publishing a `models[]` of
 * model NAMES. Empty is loud — check (d) reports NOT MEASURED with a reason that
 * says the meter is unconfigured — where `:11434` was a value that looked
 * configured, was read as a transport fault, and could never work.
 */
export const DEFAULT_EMBEDDER_ORIGIN = ''

/** The artifact path, relative to the program workspace. */
const ARTIFACT_RELATIVE_PATH_VALUE = 'research/meta-research-last.json'

/**
 * The row's config, before defaults.
 *
 * Every key is optional and every key is READ — none is accepted and then
 * ignored. `workspaceDir` moves every derived path together, which is what a
 * verifier wants when it must not touch the live artifact.
 */
export interface Config {
  workspaceDir?: string
  recordPath?: string
  decisionLogUrl?: string
  intentMapUrl?: string
  embedderPsUrl?: string
  profileManifestPath?: string
  [key: string]: unknown
}

function stringOption(raw: Config, key: string, fallback: string): string {
  const value = raw[key]
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function resolveOptions(raw: Config): MountOptions {
  const workspaceDir = stringOption(raw, 'workspaceDir', process.env.DSH_META_RESEARCH_WORKSPACE ?? DEFAULT_WORKSPACE)
  return {
    workspaceDir,
    recordPath: stringOption(
      raw,
      'recordPath',
      process.env.DSH_META_RESEARCH_RECORD ?? join(workspaceDir, ARTIFACT_RELATIVE_PATH_VALUE),
    ),
    decisionLogUrl: stringOption(raw, 'decisionLogUrl', process.env.DSH_META_RESEARCH_DECISION_LOG_URL ?? ''),
    intentMapUrl: stringOption(raw, 'intentMapUrl', process.env.DSH_META_RESEARCH_INTENT_MAP_URL ?? ''),
    embedderPsUrl: stringOption(raw, 'embedderPsUrl', DEFAULT_EMBEDDER_ORIGIN === '' ? '' : `${DEFAULT_EMBEDDER_ORIGIN}/api/ps`),
    profileManifestPath: stringOption(raw, 'profileManifestPath', findProfileManifest(workspaceDir)),
  }
}

/**
 * Mount the two routes.
 *
 * `apply` is explicitly NOT async: Cordis treats a prototype-bearing ordinary
 * function as a constructor, whose returned Promise is not startup work
 * (`mcp-client/src/index.ts:150-153` records the same trap). Route registration
 * is synchronous; the run route does its I/O when it is called.
 *
 * @param ctx - plugin context carrying the web server.
 * @param rawConfig - the row's config, before defaults.
 */
export function apply(ctx: HostContext, rawConfig: Config = {}): void {
  const options = resolveOptions(rawConfig)
  ctx.logger.info(
    `[${name}] mounting 2 advertised routes: GET ${LAST_PATH}, POST ${RUN_PATH}; record -> ${options.recordPath}`,
  )
  mountRoutes(ctx, options)
}
