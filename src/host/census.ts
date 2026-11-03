/**
 * The drift census: four checks, each with a numerator AND a denominator.
 *
 * This is a READER. It never writes to the plan, the decision log or the intent
 * map; it reads them over HTTP and from disk, computes what is missing, and
 * hands the result to `record.ts`, which persists exactly one artifact.
 *
 * **THE CENSUS ASKS ONE QUESTION: WHERE HAS THE PROGRAM DRIFTED FROM ITS OWN
 * RECORD?** Each check compares a claim on the record against the disk:
 *
 * a) `scope-missing-path` — an ACTIVE decision scopes a path that is not there.
 * b) `intent-plan-document-missing` — an intent row says the stage is `plan`,
 *    but the document that row cites as its source is not there.
 * c) `authorised-clone-not-linked` — an ACTIVE decision names
 *    `plugins-src/<name>`, the clone exists, and the profile neither bundles it
 *    nor links it. A decision authorising work that never reaches the running
 *    profile is the divergence between intent and deployment.
 * d) `intent-map-stale` — the vector index records one embedding model, the
 *    running embedder reports another (or cannot be read).
 *
 * **AN UNREADABLE SOURCE IS NEVER A ZERO.** Each check starts from a source
 * reading whose usability is stated; when a source cannot be read the check
 * reports `of: null` and a reason, and `validate.ts` refuses a record in which
 * `of: null` appears without one. The alternative — publishing `0 findings` for
 * a source that was never read — is this program's most expensive recorded
 * failure mode, and it looks exactly like a pass.
 *
 * **NO DEVICE, NO MODEL.** Check (d) reads `/api/ps`, the embedder's residency
 * METADATA, and compares names. No inference call is made; GPU work belongs to
 * `llama.cpp` and its controlling scripts, and nothing here spawns a process.
 *
 * @module dsh-meta-research/host/census
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { CHECK_ORDER, FINDING_KINDS } from './types.ts'
import type {
  AuthorisedCloneNotLinkedCheck,
  Census,
  CensusChecks,
  Finding,
  IntentMapStaleCheck,
  IntentPlanDocumentMissingCheck,
  ScopeMissingPathCheck,
  SourceReading,
  SourceSummary,
} from './types.ts'

/** The directory name a decision uses when it scopes a clone. */
const CLONES_DIRNAME = 'plugins-src'

/** Everything the census needs, already read by the route. */
export interface CensusInputs {
  /** Timestamp shared by `ranAt` and `censusAt`. */
  censusAt: string
  workspaceDir: string
  profileManifestPath: string
  decisions: SourceReading
  intentMap: SourceReading
  intentField: SourceReading
  profileManifest: SourceReading
  embedderPs: SourceReading
}

/** A source reading plus the verdict on whether its payload has the needed shape. */
interface Slot {
  reading: SourceReading
  usable: boolean
  reason: string | null
  value: unknown
}

type Obj = Record<string, unknown>

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Build a slot: transport readability AND the shape the consuming check needs. */
function slotOf(reading: SourceReading, shapeProblem: (value: unknown) => string | null): Slot {
  if (!reading.readable) {
    return { reading, usable: false, reason: reading.reason ?? `${reading.name} is unreadable (no reason recorded)`, value: null }
  }
  const problem = shapeProblem(reading.value)
  if (problem !== null) {
    return { reading, usable: false, reason: problem, value: null }
  }
  return { reading, usable: true, reason: null, value: reading.value }
}

/** The summary the census publishes for a source, at the usability level. */
function summaryOf(slot: Slot): SourceSummary {
  return {
    name: slot.reading.name,
    location: slot.reading.location,
    readable: slot.usable,
    status: slot.reading.status,
    bytes: slot.reading.bytes,
    reason: slot.reason,
  }
}

// ---------------------------------------------------------------------------
// Path existence
// ---------------------------------------------------------------------------

type PathState =
  | { state: 'exists'; abs: string }
  | { state: 'missing' }
  | { state: 'unreadable'; reason: string }

/**
 * Probe one scope/evidence path against the roots the record may be relative to.
 *
 * Three roots are tried, in order, because this workspace's records mix three
 * conventions and a single-root probe is the `D-0072` failure: a check scoped to
 * the wrong root prints zero over a tree it never looked in. A path that exists
 * under ANY of them exists. A path that errors with something other than
 * `ENOENT`/`ENOTDIR` is UNREADABLE rather than missing — an absence of a reading
 * is not an absence of a value.
 */
function pathState(raw: string, roots: readonly string[]): PathState {
  const candidates: string[] = []
  if (raw === '~') candidates.push(homedir())
  else if (raw.startsWith('~/')) candidates.push(join(homedir(), raw.slice(2)))
  else if (isAbsolute(raw)) candidates.push(raw)
  else for (const root of roots) candidates.push(resolve(root, raw))

  let unreadableReason: string | null = null
  for (const candidate of candidates) {
    try {
      statSync(candidate)
      return { state: 'exists', abs: candidate }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') continue
      unreadableReason ??= `${candidate}: ${error instanceof Error ? `${error.name}${code === undefined ? '' : ` ${code}`}` : String(error)}`
    }
  }
  return unreadableReason === null ? { state: 'missing' } : { state: 'unreadable', reason: unreadableReason }
}

// ---------------------------------------------------------------------------
// Decision-log shape
// ---------------------------------------------------------------------------

interface DecisionRecord {
  id: string
  status: string
  /** Scope entries as written; non-string entries are kept so they can be reported. */
  scope: unknown[]
}

interface DecisionRead {
  records: DecisionRecord[]
  malformed: number
}

/** Narrow the decision-log payload; `null` means the log itself was unusable. */
function readDecisions(value: unknown): DecisionRead | null {
  if (!isObject(value) || !Array.isArray(value.decisions)) return null
  const records: DecisionRecord[] = []
  let malformed = 0
  for (const row of value.decisions) {
    if (!isObject(row) || !isNonEmptyString(row.id) || !isNonEmptyString(row.status) || !Array.isArray(row.scope)) {
      malformed++
      continue
    }
    records.push({ id: row.id, status: row.status, scope: row.scope })
  }
  return { records, malformed }
}

// ---------------------------------------------------------------------------
// (a) scope-missing-path
// ---------------------------------------------------------------------------

function buildScopeCheck(decisions: DecisionRead, roots: readonly string[]): ScopeMissingPathCheck {
  const population = decisions.records.filter((decision) => decision.status === 'active' && decision.scope.length > 0)
  const findings: Finding[] = []
  let scopeEntriesTotal = 0
  let scopeEntriesExamined = 0
  let missingPaths = 0
  let globPatternsSkipped = 0
  let unreadablePaths = 0
  let checked = 0
  const unreadableExamples: string[] = []

  for (const decision of population) {
    const missing: string[] = []
    let decisionUnreadable = false
    for (const entry of decision.scope) {
      scopeEntriesTotal++
      if (typeof entry !== 'string') {
        unreadablePaths++
        decisionUnreadable = true
        unreadableExamples.push(`${decision.id}: non-string scope entry`)
        continue
      }
      if (/[*?]/.test(entry)) {
        // A glob is a pattern, not a path; probing it as a path would manufacture
        // a missing-path finding for every wildcard in the log.
        globPatternsSkipped++
        continue
      }
      const state = pathState(entry, roots)
      if (state.state === 'unreadable') {
        unreadablePaths++
        decisionUnreadable = true
        if (unreadableExamples.length < 3) unreadableExamples.push(`${decision.id}: ${state.reason}`)
        continue
      }
      scopeEntriesExamined++
      if (state.state === 'missing') missing.push(entry)
    }
    if (!decisionUnreadable) checked++
    missingPaths += missing.length
    if (missing.length > 0) {
      findings.push({
        kind: 'scope-missing-path',
        id: decision.id,
        detail: `active decision scopes ${String(missing.length)} path(s) that exist nowhere the census looked (workspace, project root, profile root): ${missing.join(', ')}`,
      })
    }
  }

  const reason =
    unreadablePaths === 0
      ? decisions.malformed === 0
        ? null
        : `${String(decisions.malformed)} decision row(s) could not be classified (missing id/status/scope), so this denominator is a floor`
      : `${String(unreadablePaths)} scope entr(y/ies) could not be read: ${unreadableExamples.join('; ')}`

  return {
    kind: 'scope-missing-path',
    unit: 'active decision carrying a non-empty scope (one unit per decision; its paths are all probed)',
    of: population.length,
    checked,
    findings,
    reason,
    scopeEntriesTotal,
    scopeEntriesExamined,
    missingPaths,
    globPatternsSkipped,
    unreadablePaths,
  }
}

// ---------------------------------------------------------------------------
// (b) intent-plan-document-missing
// ---------------------------------------------------------------------------

interface PlanRow {
  id: string
  document: string
  sources: string[]
}

function readPlanRows(value: unknown): PlanRow[] | null {
  if (!isObject(value) || !Array.isArray(value.documents)) return null
  const rows: PlanRow[] = []
  for (const document of value.documents) {
    if (!isObject(document) || !isNonEmptyString(document.doc) || !Array.isArray(document.rows)) return null
    const documentRows = document.rows
    const documentPath = document.doc
    for (const [index, row] of documentRows.entries()) {
      if (!isObject(row)) return null
      if (String(row.value).toLowerCase() !== 'plan') continue
      const id = isNonEmptyString(row.id) ? row.id : `${documentPath}#row-${String(index)}`
      const sources: string[] = [documentPath]
      const evidence = isObject(row.evidence) ? row.evidence : null
      const pointers = evidence !== null && Array.isArray(evidence.pointers) ? evidence.pointers : []
      for (const pointer of pointers) {
        if (isObject(pointer) && isNonEmptyString(pointer.ref) && !sources.includes(pointer.ref)) sources.push(pointer.ref)
      }
      rows.push({ id, document: documentPath, sources })
    }
  }
  return rows
}

function buildIntentPlanCheck(slot: Slot, roots: readonly string[]): IntentPlanDocumentMissingCheck {
  const rows = slot.usable ? readPlanRows(slot.value) : null
  if (rows === null) {
    return {
      kind: 'intent-plan-document-missing',
      unit: 'intent row with value "plan" in plan/intent-field/field.json',
      of: null,
      checked: null,
      findings: [],
      reason: slot.usable
        ? 'plan/intent-field/field.json does not have the expected shape (documents[] with a rows[] per document)'
        : slot.reason,
      sourceDocumentsExamined: null,
      sourceDocumentsMissing: null,
      sourceDocumentsUnreadable: null,
    }
  }

  const findings: Finding[] = []
  let sourceDocumentsExamined = 0
  let sourceDocumentsMissing = 0
  let sourceDocumentsUnreadable = 0
  let checked = 0

  for (const row of rows) {
    const missing: string[] = []
    let unreadable = false
    for (const source of row.sources) {
      const state = pathState(source, roots)
      if (state.state === 'exists') {
        sourceDocumentsExamined++
      } else if (state.state === 'missing') {
        sourceDocumentsExamined++
        sourceDocumentsMissing++
        missing.push(source)
      } else {
        sourceDocumentsUnreadable++
        unreadable = true
      }
    }
    if (!unreadable) checked++
    if (missing.length > 0) {
      findings.push({
        kind: 'intent-plan-document-missing',
        id: row.id,
        detail: `intent row says the stage is "plan" but its source document(s) do not exist on disk: ${missing.join(', ')} (row declared in ${row.document})`,
      })
    }
  }

  return {
    kind: 'intent-plan-document-missing',
    unit: 'intent row whose value is "plan" in plan/intent-field/field.json',
    of: rows.length,
    checked,
    findings,
    reason:
      sourceDocumentsUnreadable === 0
        ? null
        : `${String(sourceDocumentsUnreadable)} source document(s) could not be read, so that row was not checked`,
    sourceDocumentsExamined,
    sourceDocumentsMissing,
    sourceDocumentsUnreadable,
  }
}

// ---------------------------------------------------------------------------
// (c) authorised-clone-not-linked
// ---------------------------------------------------------------------------

interface CloneOnDisk {
  /** Absolute paths of this clone in the roots that hold it (a name can exist twice). */
  dirs: string[]
  /** Package names read from the clones' package.json files, when readable. */
  packageNames: string[]
  /** True when no package.json could be read, so a bundle match is inconclusive. */
  packageUnreadable: boolean
}

function readPackageName(dir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return isObject(parsed) && isNonEmptyString(parsed.name) ? parsed.name : null
  } catch {
    return null
  }
}

function scanCloneRoots(roots: readonly string[]): { clones: Map<string, CloneOnDisk>; unreadableRoots: string[] } {
  const clones = new Map<string, CloneOnDisk>()
  const unreadableRoots: string[] = []
  for (const root of roots) {
    let entries
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') unreadableRoots.push(`${root} (${code ?? 'unreadable'})`)
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(root, entry.name)
      const existing = clones.get(entry.name) ?? { dirs: [], packageNames: [], packageUnreadable: false }
      existing.dirs.push(dir)
      const packageName = readPackageName(dir)
      if (packageName === null) existing.packageUnreadable = true
      else existing.packageNames.push(packageName)
      clones.set(entry.name, existing)
    }
  }
  return { clones, unreadableRoots }
}

interface ManifestFacts {
  bundles: Set<string>
  /** Absolute, normalised `link:` dependency targets. */
  linkTargets: Set<string>
  /** Basenames of `link:` targets, so a scope name can match a directory. */
  linkTargetNames: Set<string>
}

function normalise(path: string): string {
  return resolve(path).replaceAll('\\', '/').toLowerCase()
}

function readManifestFacts(value: unknown, manifestPath: string): ManifestFacts | null {
  if (!isObject(value) || !isObject(value.dsh) || !isObject(value.dsh.profile)) return null
  const profile = value.dsh.profile
  if (!Array.isArray(profile.bundles) || profile.bundles.some((bundle) => typeof bundle !== 'string')) return null
  if (!isObject(value.dependencies)) return null
  const profileDir = dirname(manifestPath)
  const bundles = new Set(profile.bundles as string[])
  const linkTargets = new Set<string>()
  const linkTargetNames = new Set<string>()
  for (const target of Object.values(value.dependencies)) {
    if (typeof target !== 'string' || !target.startsWith('link:')) continue
    const resolved = resolve(profileDir, target.slice('link:'.length))
    linkTargets.add(normalise(resolved))
    linkTargetNames.add(basename(resolved))
  }
  return { bundles, linkTargets, linkTargetNames }
}

function buildCloneCheck(
  decisions: DecisionRead,
  manifestSlot: Slot,
  manifestPath: string,
  workspaceDir: string,
): AuthorisedCloneNotLinkedCheck {
  const manifest = manifestSlot.usable ? readManifestFacts(manifestSlot.value, manifestPath) : null
  if (manifest === null) {
    return {
      kind: 'authorised-clone-not-linked',
      unit: 'active decision naming plugins-src/<name>',
      of: null,
      checked: null,
      findings: [],
      reason: manifestSlot.usable
        ? `${manifestPath} does not have the expected shape (dsh.profile.bundles[] and dependencies)`
        : manifestSlot.reason,
      cloneNamesExamined: null,
      clonesOnDisk: null,
      unlinkedClones: null,
      unreadableClones: null,
    }
  }

  const scopedNames = new Map<string, string[]>()
  const scopedDecisions = new Set<string>()
  for (const decision of decisions.records) {
    if (decision.status !== 'active') continue
    for (const entry of decision.scope) {
      if (typeof entry !== 'string') continue
      const match = /^plugins-src\/([^/]+?)\/?$/.exec(entry)
      if (match === null || match[1] === undefined) continue
      scopedDecisions.add(decision.id)
      const ids = scopedNames.get(match[1]) ?? []
      ids.push(decision.id)
      scopedNames.set(match[1], ids)
    }
  }

  const projectRoot = resolve(workspaceDir, '../../..')
  const { clones, unreadableRoots } = scanCloneRoots([join(workspaceDir, CLONES_DIRNAME), join(projectRoot, CLONES_DIRNAME)])

  const findings: Finding[] = []
  const inconclusive = new Set<string>()
  let cloneNamesExamined = 0
  let unlinkedClones = 0
  let unreadableClones = 0
  // decision id -> unlinked clone descriptions it scopes
  const unlinkedByDecision = new Map<string, string[]>()

  for (const [name, decisionIds] of scopedNames) {
    const clone = clones.get(name)
    if (clone === undefined) continue
    cloneNamesExamined++

    const linkedByBundle = manifest.bundles.has(name) || clone.packageNames.some((packageName) => manifest.bundles.has(packageName))
    const linkedByLink =
      manifest.linkTargetNames.has(name) || clone.dirs.some((dir) => manifest.linkTargets.has(normalise(dir)))
    const linked = linkedByBundle || linkedByLink

    if (!linked && clone.packageUnreadable) {
      // Cannot prove "not linked" when the package name that a bundle entry might
      // use could not be read. An unreadable field is not a clean negative.
      unreadableClones++
      for (const decisionId of decisionIds) inconclusive.add(decisionId)
      continue
    }
    if (linked) continue

    unlinkedClones++
    const detail = `active decision scopes ${CLONES_DIRNAME}/${name}, which exists on disk at ${clone.dirs.join(' and ')} but is neither in dsh.profile.bundles (${manifestPath}) nor reachable through any link: dependency`
    for (const decisionId of decisionIds) {
      const list = unlinkedByDecision.get(decisionId) ?? []
      list.push(detail)
      unlinkedByDecision.set(decisionId, list)
    }
  }

  for (const [decisionId, details] of unlinkedByDecision) {
    findings.push({
      kind: 'authorised-clone-not-linked',
      id: decisionId,
      detail: details.join(' | '),
    })
  }

  const reasons: string[] = []
  if (inconclusive.size > 0) {
    reasons.push(`${String(unreadableClones)} clone(s) had an unreadable package.json and ${String(inconclusive.size)} decision(s) could not be decided`)
  }
  if (unreadableRoots.length > 0) reasons.push(`clone root(s) unreadable: ${unreadableRoots.join(', ')}`)
  if (decisions.malformed > 0) reasons.push(`${String(decisions.malformed)} malformed decision row(s) excluded`)

  return {
    kind: 'authorised-clone-not-linked',
    unit: 'active decision naming a plugins-src/<name> clone (one unit per decision)',
    of: scopedDecisions.size,
    checked: scopedDecisions.size - inconclusive.size,
    findings,
    reason: reasons.length === 0 ? null : reasons.join('; '),
    cloneNamesExamined,
    clonesOnDisk: clones.size,
    unlinkedClones,
    unreadableClones,
  }
}

// ---------------------------------------------------------------------------
// (d) intent-map-stale
// ---------------------------------------------------------------------------

function readIndexModel(value: unknown): string | null {
  if (!isObject(value) || !isObject(value.index) || !isObject(value.index.identity)) return null
  const model = value.index.identity.model
  return isNonEmptyString(model) ? model : null
}

function readResidentModels(value: unknown): string[] | null {
  if (!isObject(value) || !Array.isArray(value.models)) return null
  const names: string[] = []
  for (const model of value.models) {
    if (isObject(model) && isNonEmptyString(model.name)) names.push(model.name)
  }
  return names
}

function buildIntentMapCheck(intentMapSlot: Slot, psSlot: Slot): IntentMapStaleCheck {
  const indexModel = intentMapSlot.usable ? readIndexModel(intentMapSlot.value) : null
  const staleReason = (reason: string): IntentMapStaleCheck => ({
    kind: 'intent-map-stale',
    unit: 'model-name comparison: intent-map index.identity.model vs the running embedder',
    of: null,
    checked: null,
    findings: [],
    reason,
    indexModel,
    residentModels: psSlot.usable ? readResidentModels(psSlot.value) : null,
  })

  if (!intentMapSlot.usable) return staleReason(intentMapSlot.reason ?? 'intent map is unreadable')
  if (indexModel === null) return staleReason('intent-map/api/map carries no index.identity.model to compare')
  if (!psSlot.usable) return staleReason(`${psSlot.reason ?? 'embedder residency is unreadable'}; an unreadable embedder is not zero drift`)

  const residentModels = readResidentModels(psSlot.value)
  if (residentModels === null) return staleReason(`${psSlot.reading.location} carries no models[] array; an absent reading is not a clean one`)
  if (residentModels.length === 0) {
    // A 200 with no resident model is a real reading of "nothing is loaded". It is
    // NOT evidence that the index model is wrong, so this is an incomparable
    // moment rather than drift.
    //
    // CORRECTED IN PLACE 2026-10-18: this comment and the reason string beneath it
    // attributed the idle unload to `D-0006`, AND `D-0006` DOES NOT SAY THAT — it
    // is the ruling that the Laya encoder is not viable as this program's embedding
    // model and that the default stays `qwen3-embedding:0.6b` (scope
    // `tmp/plan-rag-index.json`, `research/plan-rag.md`). A citation to a decision
    // that does not contain the claim is worse than no citation, because a reader
    // who checks it learns the opposite of what the comment needs them to know.
    // The unload is an OBSERVED deployment behaviour with no decision behind it:
    // this program pins the model with `keep_alive: -1` precisely because an
    // unpinned ollama evicts it, and `runner/laya-gpu-watchdog.ps1` logs the
    // re-pin as `the embedder is not resident (ollama unloads after idle)`.
    return staleReason(`${psSlot.reading.location} reports no resident model, so the index model cannot be compared — ollama evicts an unpinned model after an idle window (observed; no decision records it), which makes this an incomparable moment rather than drift`)
  }

  const findings: Finding[] = []
  if (!residentModels.includes(indexModel)) {
    findings.push({
      kind: 'intent-map-stale',
      id: indexModel,
      detail: `intent-map index was built with model "${indexModel}" but the running embedder reports resident model(s): ${residentModels.join(', ')}`,
    })
  }

  return {
    kind: 'intent-map-stale',
    unit: 'model-name comparison: intent-map index.identity.model vs the running embedder',
    of: 1,
    checked: 1,
    findings,
    reason: null,
    indexModel,
    residentModels,
  }
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** Build the complete census from already-read sources. */
export function buildCensus(inputs: CensusInputs): Census {
  const workspaceDir = inputs.workspaceDir
  const profileDir = dirname(inputs.profileManifestPath)
  const projectRoot = resolve(workspaceDir, '../../..')
  // Order matters: the workspace is the canonical root for plan/, research/,
  // runner/ and tmp/ scopes; the project root is where plugins-src/ clones live;
  // the profile root is where the profile's own files live.
  const roots = [workspaceDir, projectRoot, profileDir]

  const decisionsSlot = slotOf(inputs.decisions, (value) =>
    isObject(value) && Array.isArray(value.decisions) ? null : `${inputs.decisions.location} carries no decisions[] array`,
  )
  const intentMapSlot = slotOf(inputs.intentMap, (value) =>
    isObject(value) ? null : `${inputs.intentMap.location} did not return a JSON object`,
  )
  const intentFieldSlot = slotOf(inputs.intentField, (value) =>
    isObject(value) && Array.isArray(value.documents) ? null : `${inputs.intentField.location} carries no documents[] array`,
  )
  const manifestSlot = slotOf(inputs.profileManifest, (value) => {
    if (!isObject(value) || !isObject(value.dsh) || !isObject(value.dsh.profile)) {
      return `${inputs.profileManifest.location} does not look like a profile manifest (dsh.profile missing)`
    }
    const profile = value.dsh.profile
    if (!Array.isArray(profile.bundles)) {
      return `${inputs.profileManifest.location} does not look like a profile manifest (dsh.profile.bundles missing)`
    }
    if (!isObject(value.dependencies)) {
      return `${inputs.profileManifest.location} carries no dependencies object, so link: dependencies cannot be checked`
    }
    return null
  })
  const psSlot = slotOf(inputs.embedderPs, (value) =>
    isObject(value) && Array.isArray(value.models) ? null : `${inputs.embedderPs.location} carries no models[] array`,
  )

  const decisionRead = decisionsSlot.usable ? readDecisions(decisionsSlot.value) : null

  const scopeCheck: ScopeMissingPathCheck =
    decisionRead === null
      ? {
          kind: 'scope-missing-path',
          unit: 'active decision carrying a non-empty scope (one unit per decision; its paths are all probed)',
          of: null,
          checked: null,
          findings: [],
          reason: decisionsSlot.reason ?? 'the decision log is unreadable',
          scopeEntriesTotal: null,
          scopeEntriesExamined: null,
          missingPaths: null,
          globPatternsSkipped: null,
          unreadablePaths: null,
        }
      : buildScopeCheck(decisionRead, roots)

  const intentPlanCheck = buildIntentPlanCheck(intentFieldSlot, roots)

  const cloneCheck: AuthorisedCloneNotLinkedCheck =
    decisionRead === null
      ? {
          kind: 'authorised-clone-not-linked',
          unit: 'active decision naming plugins-src/<name>',
          of: null,
          checked: null,
          findings: [],
          reason: decisionsSlot.reason ?? 'the decision log is unreadable',
          cloneNamesExamined: null,
          clonesOnDisk: null,
          unlinkedClones: null,
          unreadableClones: null,
        }
      : buildCloneCheck(decisionRead, manifestSlot, inputs.profileManifestPath, workspaceDir)

  const intentMapCheck = buildIntentMapCheck(intentMapSlot, psSlot)

  const checks: CensusChecks = [scopeCheck, intentPlanCheck, cloneCheck, intentMapCheck]
  const findings = checks.flatMap((check) => check.findings)
  const unitsExamined = checks.reduce((sum, check) => sum + (check.of ?? 0), 0)
  const evaluated = checks.filter((check) => check.of !== null).length
  const complete = evaluated === CHECK_ORDER.length

  const byKind = Object.fromEntries(
    FINDING_KINDS.map((kind) => {
      const count = findings.filter((finding) => finding.kind === kind).length
      return [kind, { count, of: findings.length }]
    }),
  ) as Census['totals']['byKind']

  return {
    censusAt: inputs.censusAt,
    complete,
    checksEvaluated: { count: evaluated, of: CHECK_ORDER.length },
    sources: [decisionsSlot, intentMapSlot, intentFieldSlot, manifestSlot, psSlot].map(summaryOf),
    checks,
    totals: {
      unitsExamined: { count: unitsExamined, of: complete ? unitsExamined : null },
      findings: { count: findings.length, of: unitsExamined },
      byKind,
      checksNotEvaluated: { count: CHECK_ORDER.length - evaluated, of: CHECK_ORDER.length },
    },
  }
}
