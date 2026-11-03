/**
 * The Client half's transport and normalization — written against the route
 * contract `GET /meta-research/api/last` and `POST /meta-research/api/run`.
 *
 * THE FOUR THINGS THIS FILE MUST NOT COLLAPSE:
 *
 *  1. **`last: null` is NOT a missing `build`/`ok` flag and NOT a scaffold body.**
 *     The route's run record is the `last` FIELD. `null` means no run has ever been
 *     recorded; the FIELD BEING ABSENT means the host does not serve the contract at
 *     all; a failed read means nothing is known. Those become three different states
 *     in `toLast`, and the panel renders them with three different tokens, because a
 *     reader acts differently on each.
 *  2. **An absent count is not a zero.** `checked` and `of` are `null` when the field
 *     is missing, and `0` only when the route actually sent `0`. `of: null` means the
 *     check was NOT EVALUATED — the host documents it as honest partial coverage, so
 *     it can render neither a zero nor a clean row.
 *  3. **A 404 on `/run` is not a refusal.** It means the control's route is not
 *     registered on this host (the host half is not mounted), which is a different
 *     instruction from "the route rejected this request".
 *  4. **A run is READ FROM THE ROUTE, not from the POST's body.** The host confirms
 *     `POST /run` answers only after the census is computed, the artifact is written
 *     and the in-process last is set, so `runResearch` never treats the POST response
 *     as the result: the panel re-reads `/last` and shows the record the route made.
 *     The POST body is ignored on purpose, because a body-derived result would show
 *     a value this component echoed rather than one the route recorded.
 *
 * THE CONTRACT IS THE HOST LANE'S FINALISED SHAPE, confirmed by `research-host`:
 * `GET /last` is always `200` with `{ok, last, note}` where `note` is always present;
 * a run is `{ranAt, census, findings}`; `census.checks` is the ARRAY of four CHECKs,
 * each `{kind, unit, of, checked, findings: FINDING[], reason}`.
 *
 * TWO CONVENTIONS COPIED DELIBERATELY from the sibling `dsh-lvl1-gate`: the URL is
 * resolved against the PAGE BASE with query and hash dropped (so the panel works
 * under a reverse-proxy prefix and can never carry a launch token into a plugin
 * route), and every read is `cache: 'no-store'` — a cached reading is a lie about the
 * present.
 *
 * @module dsh-meta-research/client/api
 */

import type { CheckView, CoverageView, FailureState, FindingView, LastView, RatioView, ResearchView } from './view.ts'

/** Placeholder origin for the non-DOM case (specs, SSR): resolution needs a base. */
const PLACEHOLDER_ORIGIN = 'http://dsh.invalid/'

/**
 * The page base, read STRUCTURALLY.
 *
 * `tsconfig.json` declares no DOM lib, which is right for a package whose host half
 * is Node: importing the whole DOM lib to name one global would let every browser
 * API typecheck here by accident. So the base is reached through `globalThis` with
 * its shape declared at the point of use, and a non-DOM caller falls back to the
 * placeholder origin rather than throwing.
 * @returns the absolute base URL to resolve routes against.
 */
function pageBase(): string {
  const scope = globalThis as { location?: { href?: unknown } }
  const href = scope.location?.href
  return typeof href === 'string' ? href : PLACEHOLDER_ORIGIN
}

/** The two routes this panel uses: the read, and the one control it POSTs. */
export const ROUTES = {
  last: '/meta-research/api/last',
  run: '/meta-research/api/run',
} as const

/** Why one call failed, as far as the panel needs to distinguish it. */
export type Failure = 'not-mounted' | 'refused' | 'rejected' | 'unreachable' | 'malformed'

/** A typed failure from this plugin's route. */
export class ResearchError extends Error {
  constructor(readonly failure: Failure, message: string) {
    super(message)
    this.name = 'ResearchError'
  }
}

/**
 * Resolve one route against the page base, without a query and without a hash.
 * @param path - the route path, e.g. `/meta-research/api/last`.
 * @returns the absolute URL to fetch.
 */
export function routeUrl(path: string): string {
  const url = new URL(path, pageBase())
  url.search = ''
  url.hash = ''
  return url.toString()
}

/** Fetch one JSON payload, throwing a typed failure. */
async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(routeUrl(path), {
      cache: 'no-store',
      ...init,
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
    })
  } catch (error) {
    throw new ResearchError('unreachable', error instanceof Error ? error.message : String(error))
  }
  if (response.status === 404) throw new ResearchError('not-mounted', `${path} is not registered on this host`)
  if (response.status === 403) throw new ResearchError('refused', `${path} refused this request`)
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new ResearchError('rejected', `HTTP ${response.status}${detail === '' ? '' : `: ${detail.slice(0, 300)}`}`)
  }
  try {
    return await response.json()
  } catch (error) {
    throw new ResearchError('malformed', error instanceof Error ? error.message : String(error))
  }
}

/** Map a failure onto the read state the view model speaks. */
function readFailure(error: unknown): { state: FailureState; note: string } {
  if (error instanceof ResearchError) {
    const state: FailureState = error.failure === 'rejected' ? 'refused' : error.failure
    return { state, note: error.message }
  }
  return { state: 'malformed', note: error instanceof Error ? error.message : String(error) }
}

/** Narrow an unknown to a record. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** Read a string-or-null field without coercing an absent field into a value. */
function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Read a number-or-null field; a non-number is `null` (unread), never `0`. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Read a boolean-or-null field. */
function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/** Read one `{count, of}` pair, or `null` when the pair itself was not sent. */
function ratioOf(raw: unknown): RatioView | null {
  const record = asRecord(raw)
  if (record === null) return null
  return { count: num(record['count']), of: num(record['of']) }
}

/** A last-run slice that was never read. */
function unreadLast(note: string): LastView {
  return { state: 'unread', at: null, checks: null, findings: null, coverage: null, note }
}

/**
 * Normalise the `last` field against the HOST LANE'S FINALISED CONTRACT.
 *
 * The contract, confirmed by `research-host` and not assumed from the brief's
 * shorthand: `last` is `{ ranAt, census, findings }`, where the four drift checks are
 * `census.checks` (an ARRAY, in fixed order) and each CHECK is
 * `{ kind, unit, of, checked, findings: FINDING[], reason }`. So a check's label is
 * `kind`, its numerator is `findings.length` (NOT `findings` as a number), its
 * denominator is `of`, and `of: null` means the check was NOT EVALUATED. Reading
 * `last.checks` or `check.findings` as a number would have produced a panel that
 * renders NOT MEASURED everywhere and looks broken while the host is correct.
 * @param raw - the `last` field of the route payload.
 * @returns the last-run slice.
 */
export function toLast(raw: unknown): LastView {
  if (raw === null || raw === undefined) {
    return { state: 'not-run', at: null, checks: null, findings: null, coverage: null, note: null }
  }
  const record = asRecord(raw)
  if (record === null) {
    const shape = Array.isArray(raw) ? 'an array' : typeof raw
    return {
      state: 'contract-missing',
      at: null,
      checks: null,
      findings: null,
      coverage: null,
      note: `"last" is neither null nor an object (it is ${shape}); this host does not serve the run contract`,
    }
  }

  const censusRaw = asRecord(record['census'])

  // The checks live on the CENSUS, not on the run object, and each one's `findings`
  // is an ARRAY. A numeric `findings` is tolerated as a fallback but is not the
  // contract; an absent field stays `null` (unread) rather than becoming 0.
  const checksRaw = censusRaw === null ? null : censusRaw['checks']
  let checks: CheckView[] | null = null
  if (Array.isArray(checksRaw)) {
    checks = checksRaw.map((entry) => {
      const row = asRecord(entry)
      const findingsField = row?.['findings']
      const findings = Array.isArray(findingsField) ? findingsField.length : num(findingsField)
      return {
        name: str(row?.['kind']) ?? str(row?.['name']) ?? str(row?.['id']),
        unit: str(row?.['unit']),
        findings,
        checked: num(row?.['checked']),
        of: num(row?.['of']),
        reason: str(row?.['reason']),
      }
    })
  }

  const findingsRaw = record['findings']
  let findings: FindingView[] | null = null
  if (Array.isArray(findingsRaw)) {
    findings = findingsRaw.map((entry) => {
      const row = asRecord(entry)
      return {
        kind: str(row?.['kind']) ?? str(row?.['type']),
        id: str(row?.['id']),
        detail: str(row?.['detail']) ?? str(row?.['message']),
      }
    })
  }

  const totals = censusRaw === null ? null : asRecord(censusRaw['totals'])
  const coverage: CoverageView | null = censusRaw === null
    ? null
    : {
      complete: bool(censusRaw['complete']),
      checksEvaluated: ratioOf(censusRaw['checksEvaluated']),
      unitsExamined: totals === null ? null : ratioOf(totals['unitsExamined']),
      findings: totals === null ? null : ratioOf(totals['findings']),
      checksNotEvaluated: totals === null ? null : ratioOf(totals['checksNotEvaluated']),
    }

  // The notes state what the route did NOT send. They are diagnostics, not prose:
  // they name the defect in the contract instead of inventing a table to fill.
  const notes: string[] = []
  if (censusRaw === null) notes.push('the run object carries no census object')
  if (checks === null) notes.push('the census carries no checks[] array')
  else if (checks.length !== 4) notes.push(`the census reported ${checks.length} check(s); the program expects 4`)
  if (findings === null) notes.push('the run object carries no findings[] array')

  return {
    state: 'run',
    at: str(record['ranAt']) ?? str(record['at']),
    checks,
    findings,
    coverage,
    note: notes.length === 0 ? null : notes.join('; '),
  }
}

/**
 * Normalise a whole `/meta-research/api/last` payload.
 *
 * The `last` KEY's presence is tested with `Object.prototype.hasOwnProperty`, not
 * with a truthy read, because `last: null` and no `last` key are different facts and
 * a `??`/`||` would fold them together — this program's absent-versus-empty trap
 * arriving through its own observer.
 * @param raw - the route payload.
 * @returns one complete view.
 */
export function toResearchView(raw: unknown): ResearchView {
  const fetchedAt = new Date().toISOString()
  const body = asRecord(raw)
  if (body === null) {
    return {
      fetchedAt,
      read: 'malformed',
      note: 'the /last payload was not a JSON object',
      last: unreadLast('the payload was not a JSON object, so no run record was read'),
    }
  }
  if (body['ok'] === false) {
    return {
      fetchedAt,
      read: 'refused',
      note: str(body['error']) ?? 'the route refused the read',
      last: unreadLast('the route refused the read, so no run record was read'),
    }
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'last')) {
    const keys = Object.keys(body)
    return {
      fetchedAt,
      read: 'loaded',
      note: null,
      last: {
        state: 'contract-missing',
        at: null,
        checks: null,
        findings: null,
        coverage: null,
        note: `the payload has no "last" field (keys: ${keys.length === 0 ? 'none' : keys.join(', ')}); this host does not serve the run contract`,
      },
    }
  }
  return {
    fetchedAt,
    read: 'loaded',
    note: str(body['note']),
    last: toLast(body['last']),
  }
}

/**
 * One read of the last run, never rejecting: a failed read is a STATE of the view.
 * @returns the normalised view.
 */
export async function fetchLast(): Promise<ResearchView> {
  try {
    return toResearchView(await requestJson(ROUTES.last))
  } catch (error) {
    const failure = readFailure(error)
    return { fetchedAt: null, read: failure.state, note: failure.note, last: unreadLast(failure.note) }
  }
}

/**
 * Start a run. `POST /meta-research/api/run`.
 *
 * The response BODY is deliberately not required — the route may answer `200`,
 * `202` or `204` — and it is never used as the result. The caller re-reads `/last`
 * so the change the operator sees is the record the route made.
 * @returns a short outcome for the operator, e.g. `HTTP 200`.
 */
export async function runResearch(): Promise<string> {
  let response: Response
  try {
    response = await fetch(routeUrl(ROUTES.run), {
      method: 'POST',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
  } catch (error) {
    throw new ResearchError('unreachable', error instanceof Error ? error.message : String(error))
  }
  if (response.status === 404) throw new ResearchError('not-mounted', `${ROUTES.run} is not registered on this host`)
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new ResearchError('rejected', `HTTP ${response.status}${detail === '' ? '' : `: ${detail.slice(0, 300)}`}`)
  }
  return `HTTP ${response.status}`
}
