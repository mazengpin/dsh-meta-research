/**
 * The two host routes of `dsh-meta-research`.
 *
 * - `GET  /meta-research/api/last` — the last run record, or `last: null` with
 *   the note "no run recorded in this process". `null` means NOT RUN; it is
 *   never a run whose findings happened to be empty, because those are different
 *   facts and this program has paid for confusing them.
 * - `POST /meta-research/api/run`  — compute the drift census, write the
 *   artifact, set the in-process pointer, and answer with the record.
 *
 * The two paths are defined HERE, once, and `index.ts` re-exports them; nothing
 * hand-writes the path a second time. A doubled segment advertised by a route
 * table is worse than an absent path, because the advertised copy is the one a
 * client trusts.
 *
 * **NO DEVICE, NO MODEL.** The network reads are local HTTP sources, and the
 * embedder read is RESIDENCY METADATA (`/api/ps` shaped: a `models[]` of model
 * NAMES), never an embedding or generation route. That meter has NO DEFAULT any
 * more — `:11434` is dead and llama.cpp publishes a blob path, not a name — so an
 * unconfigured meter is REPORTED as unconfigured rather than fetched. The full
 * route set the plugin serves is exactly the two above; there is no hidden third
 * surface.
 *
 * @module dsh-meta-research/host/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { HostContext } from '../types.ts'
import { buildCensus } from './census.ts'
import { getLastRun, setLastRun, writeRunRecord } from './record.ts'
import { readDiskJson, readEmbedderResidency, readHttpJson } from './sources.ts'
import type { RunRecord } from './types.ts'

/** The route prefix this plugin owns. */
export const PREFIX = '/meta-research/api'

/** The last-run route. */
export const LAST_PATH = `${PREFIX}/last`

/** The census-run route. */
export const RUN_PATH = `${PREFIX}/run`

/** The artifact path, relative to the program workspace. */
export const ARTIFACT_RELATIVE_PATH = 'research/meta-research-last.json'

/** Origin used only when a request carries no `Host` and no origin override is configured. */
export const DEFAULT_ORIGIN = 'http://127.0.0.1:3083'

/** Path of the decision-log list route, relative to the origin. */
export const DECISION_LOG_PATH = '/decision-log/api/list'

/** Path of the intent map route, relative to the origin. */
export const INTENT_MAP_PATH = '/intent-map/api/map'

const PLUGIN_NAME = 'meta-research'

/** Where the census reads and writes. All of it is resolvable from `workspaceDir`. */
export interface MountOptions {
  /** Program workspace root — the canonical resolution root for plan/, research/, runner/, tmp/. */
  workspaceDir: string
  /** The durable artifact path (absolute). */
  recordPath: string
  /** `GET` endpoint of the decision log. */
  decisionLogUrl: string
  /** `GET` endpoint of the intent map. */
  intentMapUrl: string
  /** `GET` endpoint of the embedder's residency metadata. */
  embedderPsUrl: string
  /** Absolute path of the profile manifest. */
  profileManifestPath: string
}

/** Write one JSON body with direct response ownership. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
  })
  res.end(text)
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * The origin the census should read: an explicitly configured URL wins; then the
 * `Host` this request arrived on, because a harness may listen on any port and a
 * hard-coded port is a wrong reading on every other deployment; then the fallback.
 */
function originOf(req: IncomingMessage): string {
  const host = req.headers.host
  return typeof host === 'string' && host.length > 0 ? `http://${host}` : DEFAULT_ORIGIN
}

/** A configured URL when present, else a path resolved against the request origin. */
function sourceUrl(configured: string, origin: string, path: string): string {
  return configured.length > 0 ? configured : `${origin}${path}`
}

/** `GET /last`: the last run of this process, or an explicit NOT RUN. */
function lastHandler(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    sendJson(res, 405, { ok: false, error: 'method-not-allowed', allow: 'GET' })
    return
  }
  const last = getLastRun()
  sendJson(
    res,
    200,
    last === null
      ? { ok: true, last: null, note: 'no run recorded in this process' }
      : { ok: true, last, note: `last run recorded at ${last.ranAt}` },
  )
}

/**
 * Serialise runs: two overlapping POSTs queue rather than interleave their
 * writes to one artifact. The queue is a promise chain, so a failed run does not
 * wedge the next one.
 */
let queue: Promise<unknown> = Promise.resolve()

function serialise<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task)
  queue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

/** Read every source, compute the census, persist it, return the record. */
async function computeAndRecord(options: MountOptions, origin: string): Promise<RunRecord> {
  const censusAt = new Date().toISOString()
  const [decisions, intentMap, embedderPs] = await Promise.all([
    readHttpJson('decision-log', sourceUrl(options.decisionLogUrl, origin, DECISION_LOG_PATH)),
    readHttpJson('intent-map', sourceUrl(options.intentMapUrl, origin, INTENT_MAP_PATH)),
    readEmbedderResidency(options.embedderPsUrl),
  ])
  const intentField = readDiskJson('intent-field', join(options.workspaceDir, 'plan/intent-field/field.json'))
  const profileManifest = readDiskJson('profile-manifest', options.profileManifestPath)

  const census = buildCensus({
    censusAt,
    workspaceDir: options.workspaceDir,
    profileManifestPath: options.profileManifestPath,
    decisions,
    intentMap,
    intentField,
    profileManifest,
    embedderPs,
  })
  const run: RunRecord = {
    ranAt: censusAt,
    census,
    findings: census.checks.flatMap((check) => check.findings),
  }
  writeRunRecord(options.recordPath, run)
  return run
}

/** `POST /run`: compute and record; answer only after the artifact is written. */
function runHandler(options: MountOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      sendJson(res, 405, { ok: false, error: 'method-not-allowed', allow: 'POST' })
      return
    }
    try {
      const run = await serialise(() => computeAndRecord(options, originOf(req)))
      setLastRun(run)
      sendJson(res, 200, { ok: true, run })
    } catch (error) {
      // The route reports the failure rather than answering with a record it
      // could not persist: an empty findings array here would be a clean surface
      // over a run that never landed.
      sendJson(res, 500, { ok: false, error: 'run-failed', message: errorText(error) })
    }
  }
}

/** Mount both routes, each through `ctx.effect` so unload removes it. */
export function mountRoutes(ctx: HostContext, options: MountOptions): void {
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: LAST_PATH, handler: lastHandler }),
    `${PLUGIN_NAME}:last`,
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: RUN_PATH, handler: runHandler(options) }),
    `${PLUGIN_NAME}:run`,
  )
}
