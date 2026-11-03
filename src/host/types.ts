/**
 * Types for the drift census this plugin computes and records.
 *
 * **THE SHAPE ENCODES THE RULE THE PROGRAM KEEPS RE-LEARNING: ABSENT IS NOT
 * ZERO.** Every check carries `of` and `checked` as `number | null`, and `null`
 * is the value that means "this population was never read". A check that could
 * not be computed reports `of: null` WITH a non-empty `reason` — never `0`, and
 * never an empty `findings` array standing in for "clean". `validate.ts` refuses
 * a run record in which `of` is `null` without a reason, or in which a check
 * claims to have examined anything without a denominator.
 *
 * The census is a READER: it has no write path into the plan, the decision log,
 * or the intent map. It reads four sources and writes one artifact.
 *
 * @module dsh-meta-research/host/types
 */

/** The four drift checks, named by their finding kind. */
export const FINDING_KINDS = [
  'scope-missing-path',
  'intent-plan-document-missing',
  'authorised-clone-not-linked',
  'intent-map-stale',
] as const

/** Union of the four check kinds. */
export type FindingKind = (typeof FINDING_KINDS)[number]

/** The fixed order the census emits the four checks in. */
export const CHECK_ORDER: readonly FindingKind[] = FINDING_KINDS

/** One unit of drift. `id` is the record the finding is about. */
export interface Finding {
  kind: FindingKind
  id: string
  detail: string
}

/** A value read from one source, with its readability stated rather than assumed. */
export interface SourceReading {
  /** Stable short name used in the census's `sources` list. */
  name: string
  /** URL or absolute path the value came from. */
  location: string
  /** True only when the source was fetched AND had the shape the check needs. */
  readable: boolean
  /** The parsed payload, or null when `readable` is false. */
  value: unknown
  /** HTTP status when the source was a URL, else null. */
  status: number | null
  /** Response/request body size in bytes when measurable, else null. */
  bytes: number | null
  /** Why the source is unusable. Non-empty whenever `readable` is false. */
  reason: string | null
}

/** The census's own account of a source. */
export interface SourceSummary {
  name: string
  location: string
  readable: boolean
  status: number | null
  bytes: number | null
  reason: string | null
}

/** The fields every check reports, exactly the three the brief names plus `unit`. */
export interface CheckBase {
  kind: FindingKind
  /** What one unit of `of` is, stated so the denominator cannot be guessed. */
  unit: string
  /** The population the check is about. `null` = never read. */
  of: number | null
  /** How many units were actually examined. `null` when `of` is `null`. */
  checked: number | null
  findings: Finding[]
  /** Why the check could not be computed, or why `checked < of`. */
  reason: string | null
}

/** (a) active decision scope entry that does not exist on disk. */
export interface ScopeMissingPathCheck extends CheckBase {
  kind: 'scope-missing-path'
  /** Every scope entry the population names, including globs and unreadable ones. */
  scopeEntriesTotal: number | null
  /** Non-glob scope entries actually probed against disk. */
  scopeEntriesExamined: number | null
  /** Scope entries naming a path that exists nowhere the census looked. */
  missingPaths: number | null
  /** Wildcard scope entries; patterns are not paths and are counted, not probed. */
  globPatternsSkipped: number | null
  /** Scope entries whose existence could not be determined (I/O error). */
  unreadablePaths: number | null
}

/** (b) intent row with value `plan` whose source document is gone. */
export interface IntentPlanDocumentMissingCheck extends CheckBase {
  kind: 'intent-plan-document-missing'
  /** Source documents (the row's own document plus its evidence pointers) probed. */
  sourceDocumentsExamined: number | null
  /** Source documents that do not exist on disk. */
  sourceDocumentsMissing: number | null
  /** Source documents whose existence could not be determined. */
  sourceDocumentsUnreadable: number | null
}

/** (c) clone named by an active decision that the profile neither bundles nor links. */
export interface AuthorisedCloneNotLinkedCheck extends CheckBase {
  kind: 'authorised-clone-not-linked'
  /** Distinct `plugins-src/<name>` names named by active decisions and present on disk. */
  cloneNamesExamined: number | null
  /** Distinct clone names found on disk in either `plugins-src` root. */
  clonesOnDisk: number | null
  /** Clones present on disk with no bundle entry and no `link:` dependency. */
  unlinkedClones: number | null
  /** Clones whose package.json could not be read, so a bundle match was inconclusive. */
  unreadableClones: number | null
}

/** (d) intent-map index model vs the model the running embedder reports. */
export interface IntentMapStaleCheck extends CheckBase {
  kind: 'intent-map-stale'
  /** `intentMap.index.identity.model`, or null when absent/unreadable. */
  indexModel: string | null
  /** Model names the embedder reported resident, or null when that was not read. */
  residentModels: string[] | null
}

/**
 * All four checks, as a fixed-order tuple.
 *
 * An array rather than an object keyed by kind: the panel iterates it, and the
 * tuple type makes "a check was dropped" a compile error rather than a row that
 * silently disappears from a rendered table. `validate.ts` re-checks the same
 * property on the serialised record, because a type cannot police JSON that
 * arrived from disk.
 */
export type CensusChecks = [
  ScopeMissingPathCheck,
  IntentPlanDocumentMissingCheck,
  AuthorisedCloneNotLinkedCheck,
  IntentMapStaleCheck,
]

/** Any one check, for generic iteration. */
export type AnyCheck = CensusChecks[number]

/** A count that carries its denominator, or null when the denominator is unread. */
export interface Ratio {
  count: number
  /** The population `count` was taken over. `null` when part of it was unread. */
  of: number | null
}

/** The drift census: four checks, five sources, totals that must close. */
export interface Census {
  censusAt: string
  /** True only when all four checks were actually computed. */
  complete: boolean
  /** How many checks produced a denominator, over the four the census defines. */
  checksEvaluated: Ratio
  sources: SourceSummary[]
  checks: CensusChecks
  totals: {
    /** Sum of the four denominators that were readable, over all four when complete. */
    unitsExamined: Ratio
    findings: Ratio
    byKind: Record<FindingKind, Ratio>
    checksNotEvaluated: Ratio
  }
}

/** The durable run record written to `research/meta-research-last.json`. */
export interface RunRecord {
  ranAt: string
  census: Census
  findings: Finding[]
}
