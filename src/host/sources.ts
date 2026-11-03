/**
 * Source readers for the drift census.
 *
 * Every read returns a `SourceReading` whose `readable` flag is TRUE ONLY WHEN
 * THE TRANSPORT SUCCEEDED AND THE PAYLOAD HAS THE SHAPE THE CHECK NEEDS. The
 * distinction matters twice over in this program: a request that returns `404`
 * on both sides has compared two non-answers, and a payload that parses but
 * carries no `decisions` array is an unanswered request wearing a success code.
 * Both are reported here as unreadable WITH A REASON, which is what lets each
 * check report `of: null` instead of a confident zero.
 *
 * Nothing here writes. Nothing here spawns a process. Nothing here opens a
 * device or asks a model to infer anything: the embedder read is RESIDENCY
 * METADATA (`/api/ps` shaped), not an inference route, and the census never calls
 * `/api/embed`, `/v1/embeddings`, `/api/generate` or `/api/chat`. An UNCONFIGURED
 * meter is not fetched at all — see `readEmbedderResidency`.
 *
 * @module dsh-meta-research/host/sources
 */

import { readFileSync } from 'node:fs'
import type { SourceReading } from './types.ts'

/**
 * Per-request budget. A hung source must degrade to `of: null`, not hang the route.
 *
 * RAISED 8_000 -> 60_000 on 2026-10-18, and the reason is that the OLD VALUE WAS
 * SHORTER THAN TWO OF ITS OWN SUBJECTS' READ TIMES, so the fail-soft path fired
 * on HEALTHY sources and the census reported a permanent `of: null` for checks it
 * could have computed. Measured on the live host (POST /meta-research/api/run,
 * 23:02:02Z, 8.2 s wall) — `checksEvaluated {count:1, of:4}` with `complete:false`,
 * and the two unreadable sources carried these exact reasons:
 *   decision-log: "http://127.0.0.1:3083/decision-log/api/list returned HTTP 200
 *                  but its body could not be read: TimeoutError: The operation was
 *                  aborted due to timeout"   <- the status ARRIVED; the BODY timed out
 *   intent-map:   "http://127.0.0.1:3083/intent-map/api/map timed out after 8000 ms"
 * Both endpoints answer 200 when probed directly and unbounded (decision-log/list
 * 1,131,219 B, intent-map/map 47,632 B), so the transport was healthy and only the
 * DEADLINE was wrong. The distinguishing signal is the first reason's shape: a 200
 * with an unreadable body is NOT a 404 and must never be read as "absent".
 *
 * 60_000 is a bound, not an unbounded wait, so the fail-soft property the comment
 * above states is preserved: a genuinely hung source still degrades to `of: null`,
 * it just takes long enough to stop firing on a 1.1 MB live append-only log that
 * only grows. Raising this cannot make a BROKEN source readable; it can only stop
 * reporting a WORKING one as broken.
 */
const HTTP_TIMEOUT_MS = 60_000

/** Reasons are persisted in the artifact, so keep them short enough to be read. */
const MAX_REASON_CHARS = 400

function clip(text: string): string {
  return text.length <= MAX_REASON_CHARS ? text : `${text.slice(0, MAX_REASON_CHARS)}…`
}

/** Render an unknown thrown value as a reason a human can act on. */
function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause
    if (cause !== null && typeof cause === 'object') {
      const code = (cause as { code?: unknown }).code
      if (typeof code === 'string') return `${error.name}: ${code}`
    }
    return `${error.name}: ${error.message}`
  }
  return String(error)
}

/**
 * Read the embedder's residency metadata, or STATE THAT NO METER IS CONFIGURED.
 *
 * An empty URL is not a fetch of `''` and it is not a silence: it is a source
 * that cannot be read for a reason the operator can act on. The reason says why
 * no llama.cpp default exists, so the next reader does not "fix" this by
 * pointing it at a route that answers with a blob path and manufactures drift.
 */
export function readEmbedderResidency(url: string): Promise<SourceReading> {
  if (url.trim() === '') {
    return Promise.resolve({
      name: 'embedder-ps',
      // Not a URL and not an empty string: the run RECORD requires a non-empty
      // location (validate.ts:191), and a blank one would be refused as malformed
      // rather than published as an absence. This names WHERE the value would come
      // from, which is the only honest location a value that does not exist has.
      location: 'config:embedderPsUrl',
      readable: false,
      value: null,
      status: null,
      bytes: null,
      reason: clip(
        'no embedder residency meter is configured, so check (d) cannot compare the index model with a running one — '
        + 'ollama\'s /api/ps on :11434 answers 000 (ollama is stopped) and llama.cpp publishes the loaded blob path rather '
        + 'than a model name, so this meter is REQUIRED: set the plugin\'s `embedderPsUrl` (or a non-empty embedder origin) '
        + 'at a service that publishes a `models[]` of model NAMES',
      ),
    })
  }
  return readHttpJson('embedder-ps', url)
}

/** Read a JSON document over HTTP, with status and body size recorded. */
export async function readHttpJson(name: string, url: string): Promise<SourceReading> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError'
    return {
      name,
      location: url,
      readable: false,
      value: null,
      status: null,
      bytes: null,
      reason: clip(timedOut ? `${url} timed out after ${HTTP_TIMEOUT_MS} ms` : `${url} unreadable: ${errorText(error)}`),
    }
  }

  let text: string
  try {
    text = await response.text()
  } catch (error) {
    return {
      name,
      location: url,
      readable: false,
      value: null,
      status: response.status,
      bytes: null,
      reason: clip(`${url} returned HTTP ${response.status} but its body could not be read: ${errorText(error)}`),
    }
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (!response.ok) {
    return {
      name,
      location: url,
      readable: false,
      value: null,
      status: response.status,
      bytes,
      reason: clip(`HTTP ${response.status} from ${url}`),
    }
  }
  try {
    return {
      name,
      location: url,
      readable: true,
      value: JSON.parse(text) as unknown,
      status: response.status,
      bytes,
      reason: null,
    }
  } catch (error) {
    return {
      name,
      location: url,
      readable: false,
      value: null,
      status: response.status,
      bytes,
      reason: clip(`${url} returned HTTP ${response.status} but the body is not JSON: ${errorText(error)}`),
    }
  }
}

/**
 * Read a JSON document from disk.
 *
 * `readable` says the BYTES were read and parsed. Whether the document has the
 * shape a check needs is decided by that check and reported as its own reason —
 * a file that is present but carries no `documents` array is not a clean zero.
 */
export function readDiskJson(name: string, location: string): SourceReading {
  let text: string
  try {
    text = readFileSync(location, 'utf8')
  } catch (error) {
    return {
      name,
      location,
      readable: false,
      value: null,
      status: null,
      bytes: null,
      reason: clip(`${location} unreadable: ${errorText(error)}`),
    }
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  try {
    return { name, location, readable: true, value: JSON.parse(text) as unknown, status: null, bytes, reason: null }
  } catch (error) {
    return {
      name,
      location,
      readable: false,
      value: null,
      status: null,
      bytes,
      reason: clip(`${location} is not JSON: ${errorText(error)}`),
    }
  }
}
