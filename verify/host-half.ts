#!/usr/bin/env node
/**
 * verify/host-half.ts — drives the REAL host half, then proves the checker can refuse.
 *
 * WHAT THIS IS
 * ------------
 * The plugin's own modules are imported with Node's type stripping
 * (`node verify/host-half.ts`), `apply(ctx, config)` is called with a mock
 * context that captures the route registrations, and the captured handlers are
 * driven with fake `(req, res)` pairs. So the assertion is about the code that
 * ships, not about a copy of its logic.
 *
 * The run is produced by `POST /meta-research/api/run`, which writes the real
 * artifact at `<workspace>/research/meta-research-last.json`; the harness reads
 * that file back and compares it with the served body. Running this script is
 * therefore also how the deliverable artifact is produced.
 *
 * WHY IT CANNOT BE A GREEN PRINT
 * ------------------------------
 * A green total says "nothing that ran disagreed with its expectation". It says
 * nothing about whether anything COULD disagree. So after the positive checks,
 * a mutation battery feeds deliberately broken records to the plugin's own
 * `validateRunRecord` and requires it to REFUSE each one — including a fabricated
 * finding, a fabricated finding with an empty detail, an unevaluated check that
 * carries findings, a total that does not close, and `checked > of`. The
 * unmutated record is validated first as a POSITIVE CONTROL, so a validator that
 * always refuses cannot pass by refusing everything.
 *
 * Exit code: 0 only when every check passed AND every mutation was refused.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ARTIFACT_RELATIVE_PATH,
  DEFAULT_WORKSPACE,
  FINDING_KINDS,
  LAST_PATH,
  PREFIX,
  RUN_PATH,
  apply,
  validateRunRecord,
} from '../src/index.ts'
import type { AnyCheck, Census, RunRecord, SourceSummary } from '../src/host/types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = resolve(HERE, '..')
const ARTIFACT_PATH = resolve(DEFAULT_WORKSPACE, ARTIFACT_RELATIVE_PATH)

// ---------------------------------------------------------------------------
// Harness plumbing
// ---------------------------------------------------------------------------

interface Registration {
  path: string
  kind: string
  handler: (req: unknown, res: unknown) => void | Promise<void>
}

const registrations: Registration[] = []
const effectLabels: string[] = []

const ctx = {
  webServer: {
    register(route: Registration): () => void {
      registrations.push(route)
      return () => {}
    },
  },
  logger: { info(): void {}, warn(): void {} },
  effect(callback: () => () => void, label?: string): void {
    effectLabels.push(label ?? '(unlabelled)')
    const dispose = callback()
    if (typeof dispose !== 'function') throw new Error(`effect ${label ?? ''} callback did not return a disposer`)
  },
}

apply(ctx, {})

interface Reply {
  status: number
  headers: Record<string, string>
  body: any
}

function routeFor(path: string): Registration {
  const matches = registrations.filter((registration) => registration.path === path)
  if (matches.length !== 1) throw new Error(`expected exactly one handler for ${path}, found ${matches.length}`)
  return matches[0]
}

async function call(path: string, method: string): Promise<Reply> {
  const state = { status: 0, headers: {} as Record<string, string>, body: '' }
  const res = {
    writeHead(status: number, headers: Record<string, string>): void {
      state.status = status
      state.headers = { ...state.headers, ...headers }
    },
    setHeader(key: string, value: string): void {
      state.headers[key] = value
    },
    end(text?: string): void {
      state.body = text ?? ''
    },
  }
  const req = { method, url: path, headers: {} }
  await routeFor(path).handler(req, res)
  let parsed: any = null
  try {
    parsed = state.body.length === 0 ? null : JSON.parse(state.body)
  } catch {
    throw new Error(`handler for ${path} did not return JSON: ${state.body.slice(0, 200)}`)
  }
  return { status: state.status, headers: state.headers, body: parsed }
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const results: Array<{ name: string; ok: boolean; detail: string }> = []
let failures = 0

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

async function check(name: string, body: () => void | Promise<void>): Promise<void> {
  try {
    await body()
    results.push({ name, ok: true, detail: '' })
  } catch (error) {
    failures++
    const detail = error instanceof Error ? error.message : String(error)
    results.push({ name, ok: false, detail })
    console.log(`FAIL ${name}: ${detail}`)
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const EXPECTED_KINDS = [
  'scope-missing-path',
  'intent-plan-document-missing',
  'authorised-clone-not-linked',
  'intent-map-stale',
]

let run: RunRecord | null = null
let recordedBytes = 0

await check('the plugin registers exactly the two advertised routes, once each', () => {
  assert(registrations.length === 2, `expected 2 route registrations, got ${registrations.length}`)
  const paths = registrations.map((registration) => registration.path)
  assert(new Set(paths).size === 2, `duplicate route path among ${paths.join(', ')}`)
  assert(paths.includes(LAST_PATH), `missing ${LAST_PATH}`)
  assert(paths.includes(RUN_PATH), `missing ${RUN_PATH}`)
  assert(LAST_PATH === `${PREFIX}/last`, `LAST_PATH must be ${PREFIX}/last, got ${LAST_PATH}`)
  assert(RUN_PATH === `${PREFIX}/run`, `RUN_PATH must be ${PREFIX}/run, got ${RUN_PATH}`)
  assert(effectLabels.length === 2, `expected 2 ctx.effect registrations, got ${effectLabels.length}`)
})

await check('GET /last before any run returns last:null with the NOT-RUN note (never an empty findings array)', async () => {
  const reply = await call(LAST_PATH, 'GET')
  assert(reply.status === 200, `status ${reply.status}`)
  assert(reply.body.ok === true, 'ok must be true')
  assert(reply.body.last === null, `last must be null before a run, got ${JSON.stringify(reply.body.last).slice(0, 120)}`)
  assert(!Array.isArray(reply.body.last), 'last must not be an empty array: absent is not zero')
  assert(reply.body.note === 'no run recorded in this process', `note was ${JSON.stringify(reply.body.note)}`)
})

await check('wrong methods are 405 with an Allow header, not a success body', async () => {
  const postLast = await call(LAST_PATH, 'POST')
  assert(postLast.status === 405, `POST /last status ${postLast.status}`)
  assert(postLast.headers.Allow === 'GET', `POST /last Allow was ${String(postLast.headers.Allow)}`)
  const getRun = await call(RUN_PATH, 'GET')
  assert(getRun.status === 405, `GET /run status ${getRun.status}`)
  assert(getRun.headers.Allow === 'POST', `GET /run Allow was ${String(getRun.headers.Allow)}`)
})

await check('POST /run computes and records the census, and returns {ok:true, run}', async () => {
  const fetched: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = ((input: any, init?: any) => {
    fetched.push(String(input))
    return realFetch(input, init)
  }) as typeof fetch
  let reply: Reply
  try {
    reply = await call(RUN_PATH, 'POST')
  } finally {
    globalThis.fetch = realFetch
  }
  assert(reply.status === 200, `POST /run status ${reply.status}: ${JSON.stringify(reply.body).slice(0, 300)}`)
  assert(reply.body.ok === true, 'ok must be true')
  assert(reply.body.run !== null && typeof reply.body.run === 'object', 'run must be an object')
  run = reply.body.run as RunRecord

  // TWO, because the embedder meter has NO DEFAULT any more: it named ollama's
  // `/api/ps` on :11434, which answers `000`, so the run fetched a dead port on
  // every call and check (d) could only ever say ECONNREFUSED. A meter that is
  // not configured must not be fetched at all, and the census must SAY so — both
  // halves are asserted here, because "fetched 2 and stayed quiet" would be the
  // same defect in a new place.
  const expectedUrls = [
    'http://127.0.0.1:3083/decision-log/api/list',
    'http://127.0.0.1:3083/intent-map/api/map',
  ]
    .map((url) => url.toLowerCase())
    .sort()
  const seen = [...new Set(fetched.map((url) => url.toLowerCase()))].sort()
  assert(deepEqual(seen, expectedUrls), `the run must read exactly the two configured local sources; fetched ${JSON.stringify(seen)}`)
  const psSource = (run as any).census.sources.find((source: any) => source.name === 'embedder-ps')
  assert(psSource !== undefined, 'the census must still report the embedder-ps source, even when it is unconfigured — an unreported absence reads as a zero')
  assert(psSource.readable === false, `an unconfigured embedder meter must be unreadable, got readable=${psSource.readable}`)
  assert(typeof psSource.reason === 'string' && psSource.reason.length > 0, 'an unreadable meter must carry a reason')
  assert(psSource.reason.includes('no embedder residency meter is configured'), `the reason must say the meter is unconfigured, got ${JSON.stringify(psSource.reason).slice(0, 160)}`)
  assert(!JSON.stringify(seen).includes('11434'), 'the run must not fetch the dead ollama port 11434')
  for (const url of seen) {
    for (const forbidden of ['/api/embed', '/api/generate', '/api/chat']) {
      assert(!url.includes(forbidden), `the plugin must not call the model route ${forbidden} (fetched ${url})`)
    }
  }
})

function checkOf(kind: string): AnyCheck {
  const checks = run === null ? [] : (run.census.checks as AnyCheck[])
  const value = checks.find((candidate) => candidate.kind === kind)
  assert(value !== undefined, `missing check ${kind}`)
  return value as AnyCheck
}

await check('the record has exactly the three top-level keys the artifact contract names', () => {
  assert(run !== null, 'no run captured')
  const keys = Object.keys(run as object).sort().join(',')
  assert(keys === 'census,findings,ranAt', `top-level keys were ${keys}`)
  assert(typeof run.ranAt === 'string' && !Number.isNaN(Date.parse(run.ranAt)), 'ranAt must be ISO')
})

await check('the census carries exactly the four checks, in order, each with a denominator', () => {
  const checks = run!.census.checks
  assert(Array.isArray(checks) && checks.length === 4, `expected 4 checks, got ${Array.isArray(checks) ? checks.length : typeof checks}`)
  assert(deepEqual(checks.map((check) => check.kind), EXPECTED_KINDS), `check kinds were ${checks.map((check) => check.kind).join(',')}`)
  for (const check of checks) {
    assert(typeof check.unit === 'string' && check.unit.length > 0, `${check.kind}: unit must say what one unit is`)
    assert('of' in check, `${check.kind}: missing of`)
    assert('checked' in check, `${check.kind}: missing checked`)
    assert(Array.isArray(check.findings), `${check.kind}: findings must be an array`)
    if (check.of === null) {
      assert(check.checked === null, `${check.kind}: checked must be null when of is null`)
      assert(typeof check.reason === 'string' && check.reason.length > 0, `${check.kind}: an unevaluated check must state a reason`)
      assert(check.findings.length === 0, `${check.kind}: an unevaluated check must not carry findings`)
    } else {
      assert(typeof check.of === 'number' && check.of >= 0, `${check.kind}: of must be a number`)
      assert(typeof check.checked === 'number' && check.checked >= 0 && check.checked <= check.of, `${check.kind}: bad checked/of`)
      assert(check.findings.length <= check.checked, `${check.kind}: findings exceed checked`)
    }
  }
})

await check('the decision log was readable, so checks (a) and (c) have real denominators', () => {
  assert(checkOf('scope-missing-path').of !== null, 'scope-missing-path: of is null — the decision log was not read')
  assert(checkOf('authorised-clone-not-linked').of !== null, 'authorised-clone-not-linked: of is null — the decision log was not read')
  assert((checkOf('scope-missing-path').of as number) > 0, 'scope-missing-path: denominator is 0')
  assert((checkOf('authorised-clone-not-linked').of as number) > 0, 'authorised-clone-not-linked: denominator is 0')
  assert(checkOf('intent-plan-document-missing').of !== null, 'intent-plan-document-missing: of is null — field.json was not read')
})

await check('check (d) treats an unreadable embedder as NOT MEASURED, never as zero drift', () => {
  const check = checkOf('intent-map-stale')
  if (check.of === null) {
    assert(typeof check.reason === 'string' && check.reason.length > 0, 'of:null must carry a reason')
    assert(check.checked === null, 'of:null must have checked:null')
    assert(check.findings.length === 0, 'of:null must not carry findings')
    console.log(`  note: intent-map-stale is NOT MEASURED — ${check.reason}`)
  } else {
    assert(check.of === 1, `a comparison denominator should be 1, got ${check.of}`)
    assert(typeof (check as any).indexModel === 'string', 'indexModel must be recorded when the comparison ran')
  }
})

await check('every finding cites a real id: decision ids for (a)/(c), plan-row ids for (b)', async () => {
  const findings = run!.findings
  assert(Array.isArray(findings), 'findings must be an array')
  for (const finding of findings) {
    assert((FINDING_KINDS as readonly string[]).includes(finding.kind), `unknown finding kind ${String(finding.kind)}`)
    assert(typeof finding.id === 'string' && finding.id.length > 0, `${finding.kind}: finding id must be non-empty`)
    assert(typeof finding.detail === 'string' && finding.detail.length > 0, `${finding.kind}: finding detail must be non-empty`)
  }
  const decisions = (await (await fetch('http://127.0.0.1:3083/decision-log/api/list')).json()) as any
  const decisionIds = new Set((decisions.decisions ?? []).map((decision: any) => String(decision.id)))
  const field = JSON.parse(readFileSync(resolve(DEFAULT_WORKSPACE, 'plan/intent-field/field.json'), 'utf8')) as any
  const planRowIds = new Set<string>()
  for (const document of field.documents ?? []) {
    for (const row of document.rows ?? []) {
      if (String(row.value).toLowerCase() === 'plan') planRowIds.add(String(row.id))
    }
  }
  for (const finding of findings) {
    if (finding.kind === 'scope-missing-path' || finding.kind === 'authorised-clone-not-linked') {
      assert(decisionIds.has(finding.id), `${finding.kind} cites unknown decision id ${finding.id}`)
    }
    if (finding.kind === 'intent-plan-document-missing') {
      assert(planRowIds.has(finding.id), `intent-plan-document-missing cites unknown plan row id ${finding.id}`)
    }
  }
  console.log(
    `  findings: ${String(findings.length)} over ${String(
      run!.census.checks.reduce((sum, check) => sum + (check.of ?? 0), 0),
    )} examined units — ${run!.census.checks.map((check) => `${check.kind}:${String(check.findings.length)}/${String(check.of)}`).join(', ')}`,
  )
})

await check('the top-level findings are exactly the flattening of the four checks', () => {
  const checks = run!.census.checks
  const flattened = checks.flatMap((check) => check.findings)
  assert(deepEqual(run!.findings, flattened), 'top-level findings disagree with the per-check findings')
})

await check('the totals close against the checks (counts carry their denominators)', () => {
  const census: Census = run!.census
  const checks = census.checks
  const evaluated = checks.filter((check) => check.of !== null).length
  const units = checks.reduce((sum, check) => sum + (check.of ?? 0), 0)
  assert(census.checksEvaluated.count === evaluated, `checksEvaluated ${census.checksEvaluated.count} != ${evaluated}`)
  assert(census.checksEvaluated.of === 4, `checksEvaluated.of ${census.checksEvaluated.of} != 4`)
  assert(census.complete === (evaluated === 4), 'complete must mean all four checks were evaluated')
  assert(census.totals.findings.count === run!.findings.length, 'totals.findings.count disagrees with findings.length')
  assert(census.totals.findings.of === units, 'totals.findings.of is not the examined-unit denominator')
  assert(census.totals.unitsExamined.count === units, 'totals.unitsExamined.count disagrees with the check denominators')
  assert(census.totals.unitsExamined.of === (census.complete ? units : null), 'unitsExamined.of must be null when a check was not evaluated')
  assert(census.totals.checksNotEvaluated.count === 4 - evaluated, 'checksNotEvaluated.count disagrees')
  for (const kind of FINDING_KINDS) {
    const actual = run!.findings.filter((finding) => finding.kind === kind).length
    assert(census.totals.byKind[kind].count === actual, `byKind.${kind} expected ${actual}`)
    assert(census.totals.byKind[kind].of === run!.findings.length, `byKind.${kind}.of must be the findings total`)
  }
})

await check('all five sources are accounted for, and every unreadable one states why', () => {
  const sources: SourceSummary[] = run!.census.sources
  assert(Array.isArray(sources) && sources.length === 5, `expected 5 sources, got ${Array.isArray(sources) ? sources.length : typeof sources}`)
  const names = sources.map((source) => source.name)
  assert(
    deepEqual(names, ['decision-log', 'intent-map', 'intent-field', 'profile-manifest', 'embedder-ps']),
    `source order/names were ${names.join(', ')}`,
  )
  for (const source of sources) {
    assert(typeof source.readable === 'boolean', `${source.name}: readable must be boolean`)
    assert(typeof source.location === 'string' && source.location.length > 0, `${source.name}: location missing`)
    if (!source.readable) assert(typeof source.reason === 'string' && source.reason.length > 0, `${source.name}: unreadable with no reason`)
  }
})

await check('the plugin\'s own validator accepts the real record (positive control)', () => {
  const problems = validateRunRecord(run)
  assert(problems.length === 0, `validator refused the real record: ${JSON.stringify(problems.slice(0, 3))}`)
})

await check('the durable artifact exists, is LF-only, ends with one newline, and equals the served body', () => {
  const text = readFileSync(ARTIFACT_PATH, 'utf8')
  recordedBytes = Buffer.byteLength(text, 'utf8')
  assert(recordedBytes > 0, 'artifact is empty')
  assert(statSync(ARTIFACT_PATH).size === recordedBytes, 'stored byte size disagrees with the UTF-8 length')
  assert(!text.includes('\r'), 'artifact contains CR bytes; the writing rule is LF')
  assert(text.endsWith('\n'), 'artifact must end with one trailing newline')
  assert(!text.endsWith('\n\n'), 'artifact must end with EXACTLY one trailing newline')
  const parsed = JSON.parse(text) as RunRecord
  assert(deepEqual(parsed, run), 'artifact content disagrees with the served run')
  assert(deepEqual(JSON.parse(JSON.stringify(run)), run), 'the serialised structure differs from the in-memory record')
})

await check('GET /last after the run returns the same record, with a note naming the run time', async () => {
  const reply = await call(LAST_PATH, 'GET')
  assert(reply.status === 200, `status ${reply.status}`)
  assert(reply.body.last !== null, 'last must not be null after a recorded run')
  assert(deepEqual(reply.body.last, run), 'GET /last disagrees with the run POST returned')
  assert(typeof reply.body.note === 'string' && reply.body.note.includes(run!.ranAt), `note was ${JSON.stringify(reply.body.note)}`)
})

// ---------------------------------------------------------------------------
// Mutation battery: the validator must be able to REFUSE
// ---------------------------------------------------------------------------

await check('the source contains no device or process escape hatch', () => {
  const files: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.mjs')) files.push(path)
    }
  }
  walk(join(PACKAGE_DIR, 'src'))
  assert(files.length >= 6, `expected the source tree to hold its modules, found ${files.length} files`)
  const text = files.map((file) => readFileSync(file, 'utf8')).join('\n')
  for (const forbidden of ['child_process', 'nvidia-smi', "from 'node:net'", 'from "node:net"']) {
    assert(!text.includes(forbidden), `src must not contain ${forbidden}`)
  }
  // Positive control: the scan must be able to see its subject.
  assert(text.includes('/api/ps'), 'the /api/ps residency read should be present; the scan may be looking at the wrong tree')
  assert(text.includes('meta-research'), 'the scan must see the plugin\'s own source')
})

const mutations: Array<{ name: string; refused: boolean; changed: boolean; problems: number }> = []

function mutation(name: string, mutate: (clone: RunRecord) => void): void {
  if (run === null) throw new Error('no run captured')
  const clone = structuredClone(run) as RunRecord
  mutate(clone)
  const problems = validateRunRecord(clone)
  mutations.push({
    name,
    refused: problems.length > 0,
    changed: JSON.stringify(clone) !== JSON.stringify(run),
    problems: problems.length,
  })
}

mutation('fabricated top-level finding', (clone) => {
  clone.findings.push({ kind: 'scope-missing-path', id: 'D-FABRICATED', detail: 'invented drift that no source reports' })
})

mutation('fabricated finding inside a check, with an empty detail', (clone) => {
  clone.census.checks[0].findings.push({ kind: 'scope-missing-path', id: 'D-FABRICATED', detail: '' })
})

mutation('an unevaluated check that carries findings and no reason', (clone) => {
  const check = clone.census.checks[3]
  check.of = null
  check.checked = null
  check.reason = null
  check.findings = [{ kind: 'intent-map-stale', id: 'x', detail: 'y' }]
})

mutation('a total that does not close against the findings', (clone) => {
  clone.census.totals.findings.count += 1
})

mutation('checked > of', (clone) => {
  const check = clone.census.checks[0]
  if (typeof check.of !== 'number') throw new Error('check (a) had no denominator to exceed')
  check.checked = check.of + 1
})

await check('every mutation of the record is REFUSED by the plugin\'s validator', () => {
  assert(mutations.length === 5, `expected 5 mutations, ran ${mutations.length}`)
  for (const entry of mutations) {
    assert(entry.changed, `mutation "${entry.name}" did not change the record, so it proves nothing`)
    assert(entry.refused, `mutation "${entry.name}" was NOT refused by validateRunRecord`)
  }
})

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

const passed = results.filter((result) => result.ok).length
const mutationsRefused = mutations.filter((entry) => entry.refused && entry.changed).length

console.log('')
console.log(`CHECKS: ${String(passed)}/${String(results.length)} passed`)
console.log(`MUTATIONS: ${String(mutationsRefused)}/${String(mutations.length)} changed the record AND were refused`)
for (const entry of mutations) console.log(`  - ${entry.name}: ${entry.refused ? 'REFUSED' : 'NOT REFUSED'} (${String(entry.problems)} problem(s))`)
console.log(`ARTIFACT: ${ARTIFACT_PATH} (${String(recordedBytes)} B)`)
console.log(`VERDICT: ${failures === 0 && mutationsRefused === mutations.length ? 'PASS' : 'FAIL'}`)

process.exitCode = failures === 0 && mutationsRefused === mutations.length ? 0 : 1
