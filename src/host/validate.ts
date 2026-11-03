/**
 * Structural validation of a run record, applied BEFORE it is written.
 *
 * **A VERDICT THAT CANNOT REFUSE IS A CAPTION.** The route validates the record
 * it is about to persist and refuses to write a malformed one; the verify
 * harness drives the same function with fabricated findings and proves it goes
 * red. That is the only reason it exists in the shipped path rather than only
 * in the harness: a validator that never blocks a write is documentation.
 *
 * The rules encoded here are the ones the program has paid for:
 *
 * - **NO CLEAN SURFACE FROM AN UNREAD SOURCE.** A check with `of: null` must
 *   carry a non-empty `reason` and must NOT carry findings — an unevaluated
 *   check cannot have found drift, and must not look like it passed.
 * - **EVERY COUNT CARRIES ITS DENOMINATOR.** `checked` is only legal beside a
 *   numeric `of`, and can never exceed it.
 * - **TWO ENCODINGS OF ONE FACT MUST NOT BE ABLE TO DISAGREE.** The top-level
 *   `findings` array is compared, element by element, against the concatenation
 *   of the per-check arrays it is supposed to flatten; `totals` is recomputed
 *   from the checks rather than trusted.
 * - **THE FOUR CHECKS ARE ALL THERE.** Exactly four, one per kind, in the fixed
 *   order. A missing row reads like a row with no findings, so it is refused.
 *
 * @module dsh-meta-research/host/validate
 */

import { CHECK_ORDER } from './types.ts'
import type { Finding, FindingKind } from './types.ts'

/** One reason the record may not be recorded. */
export interface ValidationProblem {
  path: string
  problem: string
}

type Obj = Record<string, unknown>

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function isNullableCount(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0)
}

/** Compare two findings by the three fields that make them findings. */
function sameFinding(a: Finding, b: Finding): boolean {
  return a.kind === b.kind && a.id === b.id && a.detail === b.detail
}

function validateFinding(value: unknown, path: string, expectedKind: FindingKind, problems: ValidationProblem[]): Finding | null {
  if (!isObject(value)) {
    problems.push({ path, problem: 'finding is not an object' })
    return null
  }
  if (value.kind !== expectedKind) {
    problems.push({ path: `${path}.kind`, problem: `expected ${expectedKind}, got ${String(value.kind)}` })
  }
  if (!isNonEmptyString(value.id)) problems.push({ path: `${path}.id`, problem: 'id must be a non-empty string' })
  if (!isNonEmptyString(value.detail)) problems.push({ path: `${path}.detail`, problem: 'detail must be a non-empty string' })
  return {
    kind: value.kind as FindingKind,
    id: isNonEmptyString(value.id) ? value.id : '',
    detail: isNonEmptyString(value.detail) ? value.detail : '',
  }
}

/** Validate one check object against the kind the census defines for that slot. */
function validateCheck(value: unknown, path: string, kind: FindingKind, problems: ValidationProblem[]): number | null {
  if (!isObject(value)) {
    problems.push({ path, problem: 'check is not an object' })
    return null
  }
  if (value.kind !== kind) {
    problems.push({ path: `${path}.kind`, problem: `expected ${kind}, got ${String(value.kind)}` })
  }
  if (!isNonEmptyString(value.unit)) problems.push({ path: `${path}.unit`, problem: 'unit must state what one unit of the denominator is' })

  const of = value.of
  const checked = value.checked
  if (!isNullableCount(of)) {
    problems.push({ path: `${path}.of`, problem: 'of must be a non-negative integer or null' })
    return null
  }
  if (of === null) {
    if (!isNonEmptyString(value.reason)) {
      problems.push({ path: `${path}.reason`, problem: 'an unevaluated check (of: null) must state a non-empty reason' })
    }
    if (!Array.isArray(value.findings) || value.findings.length > 0) {
      problems.push({ path: `${path}.findings`, problem: 'an unevaluated check (of: null) must carry an empty findings array' })
    }
    if (checked !== null) {
      problems.push({ path: `${path}.checked`, problem: 'checked must be null when of is null' })
    }
    return null
  }

  if (checked === null || !isNullableCount(checked) || typeof checked !== 'number') {
    problems.push({ path: `${path}.checked`, problem: 'checked must be a non-negative integer when of is a number' })
    return of
  }
  if (checked > of) {
    problems.push({ path: `${path}.checked`, problem: `checked (${checked}) exceeds of (${of})` })
  }
  if (!Array.isArray(value.findings)) {
    problems.push({ path: `${path}.findings`, problem: 'findings must be an array' })
    return of
  }
  if (value.findings.length > checked) {
    problems.push({ path: `${path}.findings`, problem: `findings (${value.findings.length}) exceed checked (${checked})` })
  }
  // Kind-specific extras, when present, must be counts that also carry a denominator.
  for (const key of [
    'scopeEntriesTotal',
    'scopeEntriesExamined',
    'missingPaths',
    'globPatternsSkipped',
    'unreadablePaths',
    'sourceDocumentsExamined',
    'sourceDocumentsMissing',
    'sourceDocumentsUnreadable',
    'cloneNamesExamined',
    'clonesOnDisk',
    'unlinkedClones',
    'unreadableClones',
  ]) {
    if (key in value && !isNullableCount(value[key])) {
      problems.push({ path: `${path}.${key}`, problem: `${key} must be a non-negative integer or null` })
    }
  }
  if ('indexModel' in value && value.indexModel !== null && typeof value.indexModel !== 'string') {
    problems.push({ path: `${path}.indexModel`, problem: 'indexModel must be a string or null' })
  }
  if ('residentModels' in value && value.residentModels !== null) {
    const models = value.residentModels
    if (!Array.isArray(models) || models.some((model) => typeof model !== 'string')) {
      problems.push({ path: `${path}.residentModels`, problem: 'residentModels must be an array of strings or null' })
    }
  }
  return of
}

/**
 * Validate a candidate run record.
 *
 * @param value - the object about to be written and served.
 * @returns every problem found; an empty array means the record may be written.
 */
export function validateRunRecord(value: unknown): ValidationProblem[] {
  const problems: ValidationProblem[] = []

  if (!isObject(value)) {
    return [{ path: '$', problem: 'run record is not an object' }]
  }

  const topKeys = Object.keys(value).sort()
  const expectedTopKeys = ['census', 'findings', 'ranAt']
  if (topKeys.join(',') !== expectedTopKeys.join(',')) {
    problems.push({ path: '$', problem: `top-level keys must be exactly ${expectedTopKeys.join(', ')}; got ${topKeys.join(', ')}` })
  }
  if (!isIsoDate(value.ranAt)) problems.push({ path: 'ranAt', problem: 'ranAt must be an ISO-8601 date string' })

  if (!isObject(value.census)) {
    return problems.concat({ path: 'census', problem: 'census is not an object' })
  }
  const census = value.census
  if (!isIsoDate(census.censusAt)) problems.push({ path: 'census.censusAt', problem: 'censusAt must be an ISO-8601 date string' })

  // Sources: a source reading must never lose the reason it is unusable.
  if (!Array.isArray(census.sources) || census.sources.length === 0) {
    problems.push({ path: 'census.sources', problem: 'sources must be a non-empty array' })
  } else {
    const names = new Set<string>()
    census.sources.forEach((source, index) => {
      const path = `census.sources[${index}]`
      if (!isObject(source)) {
        problems.push({ path, problem: 'source is not an object' })
        return
      }
      if (!isNonEmptyString(source.name)) problems.push({ path: `${path}.name`, problem: 'name must be a non-empty string' })
      else if (names.has(source.name)) problems.push({ path: `${path}.name`, problem: `duplicate source name ${source.name}` })
      else names.add(source.name)
      if (!isNonEmptyString(source.location)) problems.push({ path: `${path}.location`, problem: 'location must be a non-empty string' })
      if (typeof source.readable !== 'boolean') problems.push({ path: `${path}.readable`, problem: 'readable must be a boolean' })
      if (!(source.status === null || typeof source.status === 'number')) {
        problems.push({ path: `${path}.status`, problem: 'status must be a number or null' })
      }
      if (!isNullableCount(source.bytes)) problems.push({ path: `${path}.bytes`, problem: 'bytes must be a non-negative integer or null' })
      if (source.readable === false && !isNonEmptyString(source.reason)) {
        problems.push({ path: `${path}.reason`, problem: 'an unreadable source must state a non-empty reason' })
      }
    })
  }

  // The four checks: present, in order, one per kind.
  if (!Array.isArray(census.checks) || census.checks.length !== CHECK_ORDER.length) {
    problems.push({
      path: 'census.checks',
      problem: `checks must be an array of exactly ${String(CHECK_ORDER.length)} rows (one per finding kind); got ${Array.isArray(census.checks) ? String(census.checks.length) : typeof census.checks}`,
    })
  }
  const denominators: number[] = []
  const checksFindings: Finding[] = []
  if (Array.isArray(census.checks)) {
    census.checks.forEach((check, index) => {
      const kind = CHECK_ORDER[index]
      if (kind === undefined) {
        problems.push({ path: `census.checks[${index}]`, problem: 'unexpected extra check' })
        return
      }
      const of = validateCheck(check, `census.checks[${index}]`, kind, problems)
      denominators.push(of === null ? 0 : of)
      if (isObject(check) && Array.isArray(check.findings)) {
        check.findings.forEach((finding, findingIndex) => {
          const validated = validateFinding(finding, `census.checks[${index}].findings[${findingIndex}]`, kind, problems)
          if (validated !== null) checksFindings.push(validated)
        })
      }
    })
  }

  // Top-level findings must be exactly the flattening of the per-check arrays.
  if (!Array.isArray(value.findings)) {
    problems.push({ path: 'findings', problem: 'findings must be an array' })
  } else {
    if (value.findings.length !== checksFindings.length) {
      problems.push({
        path: 'findings',
        problem: `top-level findings (${String(value.findings.length)}) do not match the per-check flattening (${String(checksFindings.length)})`,
      })
    } else {
      value.findings.forEach((finding, index) => {
        const expected = checksFindings[index]
        if (!isObject(finding)) {
          problems.push({ path: `findings[${index}]`, problem: 'finding is not an object' })
          return
        }
        if (expected !== undefined && !sameFinding(finding as unknown as Finding, expected)) {
          problems.push({ path: `findings[${index}]`, problem: 'finding disagrees with the same row in its check' })
        }
      })
    }
  }

  // Totals are recomputed from the checks, never trusted.
  const checksEvaluated = Array.isArray(census.checks) ? census.checks.filter((check) => isObject(check) && check.of !== null).length : 0
  const unitsExamined = denominators.reduce((sum, denominator) => sum + denominator, 0)
  const findingsCount = checksFindings.length
  const notEvaluated = CHECK_ORDER.length - checksEvaluated
  const complete = notEvaluated === 0

  if (census.complete !== complete) {
    problems.push({ path: 'census.complete', problem: `complete must be ${String(complete)} given ${String(checksEvaluated)} evaluated checks` })
  }

  if (!isObject(census.totals)) {
    problems.push({ path: 'census.totals', problem: 'totals is not an object' })
    return problems
  }
  const totals = census.totals

  const expectRatio = (path: string, ratio: unknown, count: number, of: number | null): void => {
    if (!isObject(ratio)) {
      problems.push({ path, problem: 'ratio is not an object' })
      return
    }
    if (ratio.count !== count) problems.push({ path: `${path}.count`, problem: `expected ${String(count)}, got ${String(ratio.count)}` })
    if (ratio.of !== of) problems.push({ path: `${path}.of`, problem: `expected ${String(of)}, got ${String(ratio.of)}` })
  }

  expectRatio('census.totals.findings', totals.findings, findingsCount, unitsExamined)
  expectRatio('census.totals.unitsExamined', totals.unitsExamined, unitsExamined, complete ? unitsExamined : null)
  expectRatio('census.totals.checksEvaluated', census.checksEvaluated, checksEvaluated, CHECK_ORDER.length)
  expectRatio('census.totals.checksNotEvaluated', totals.checksNotEvaluated, notEvaluated, CHECK_ORDER.length)

  if (!isObject(totals.byKind)) {
    problems.push({ path: 'census.totals.byKind', problem: 'byKind is not an object' })
  } else {
    for (const kind of CHECK_ORDER) {
      const ratio = totals.byKind[kind]
      const actual = checksFindings.filter((finding) => finding.kind === kind).length
      expectRatio(`census.totals.byKind.${kind}`, ratio, actual, findingsCount)
    }
  }

  return problems
}
