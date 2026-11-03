/**
 * The run record: one artifact, one in-process pointer.
 *
 * The artifact is `research/meta-research-last.json` and it is the DURABLE
 * evidence: a process restart clears the in-process pointer and does not clear
 * the file, which is exactly why `GET /last` says "in this process" — it reports
 * what this process has recorded, and the file is what survives.
 *
 * **THE WRITE IS VALIDATED BEFORE IT HAPPENS.** `validateRunRecord` either
 * returns an empty problem list or throws here; the route then answers 500
 * rather than serving a record it refused to persist. A record that cannot be
 * written is not a run.
 *
 * The text is `JSON.stringify(run, null, 2)` plus exactly one `\n`, written with
 * `writeFileSync` — Node does not translate `\n` on Windows, so the file is LF
 * and ends with one trailing newline, which is this program's writing rule and
 * is asserted by the verify harness rather than assumed.
 *
 * @module dsh-meta-research/host/record
 */

import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RunRecord } from './types.ts'
import { validateRunRecord } from './validate.ts'

/** In-process pointer. `null` means NOT RUN in this process — not "ran, found nothing". */
let lastRun: RunRecord | null = null

/** The last run recorded by this process, or null when none has been. */
export function getLastRun(): RunRecord | null {
  return lastRun
}

/** Record the last run in memory, after it has been persisted. */
export function setLastRun(run: RunRecord): void {
  lastRun = run
}

/** A written artifact's path and byte size. */
export interface WrittenRecord {
  path: string
  bytes: number
}

/**
 * Validate then persist a run record.
 *
 * @throws when the record is malformed (nothing is written) or the write fails.
 */
export function writeRunRecord(recordPath: string, run: RunRecord): WrittenRecord {
  const problems = validateRunRecord(run)
  if (problems.length > 0) {
    const shown = problems.slice(0, 5).map((problem) => `${problem.path}: ${problem.problem}`)
    const more = problems.length > shown.length ? ` (+${String(problems.length - shown.length)} more)` : ''
    throw new Error(`refusing to record a malformed run: ${shown.join('; ')}${more}`)
  }
  const text = `${JSON.stringify(run, null, 2)}\n`
  mkdirSync(dirname(recordPath), { recursive: true })
  writeTextWithRetry(recordPath, text)
  return { path: recordPath, bytes: Buffer.byteLength(text, 'utf8') }
}


/** Windows raises `UNKNOWN`/`EPERM`/`EBUSY` while another process holds the artifact. */
const TRANSIENT_WRITE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'UNKNOWN'])

/** Sleep synchronously, so a retry does not turn a route into a scheduler. */
function wait(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Write one file ATOMICALLY: a temp sibling then a rename, retried on the four
 * transient Windows codes. A half-written artifact read by a second process is
 * worse than a failed run, and a first run that fails because a reader held the
 * file is a manual step the caller did not ask for.
 */
function writeTextWithRetry(path: string, text: string, attempts = 5): void {
  const temp = `${path}.tmp-write`
  let lastError: unknown = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      writeFileSync(temp, text, 'utf8')
      renameSync(temp, path)
      return
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (!TRANSIENT_WRITE_CODES.has(code) || attempt === attempts) break
      try {
        unlinkSync(temp)
      } catch {
        // the temp file may not have been created; nothing to clean up
      }
      wait(attempt * 25)
    }
  }
  throw lastError
}