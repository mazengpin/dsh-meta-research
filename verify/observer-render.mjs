/**
 * observer-render.mjs — the meta-research PANEL, checked at the ARTIFACT level.
 *
 * This reads the BUILT browser bundle (`lib/client.js`), not the source. That is this
 * program's own rule: a check that reads `src/` passes over an artifact nobody built,
 * and the failure it misses is the one that reaches the user. The bundle is loaded
 * exactly as the page loads it — `window.__ModuleLoader__.load` is defined, the
 * factory is called with a stub `require` standing in for the frozen module table —
 * and the panel is then DRIVEN, not grepped.
 *
 * WHAT THIS FILE ASSERTS, and why each one exists:
 *
 *   1. the loader contract: bundle id `dsh-meta-research`, exports `name`, `inject`,
 *      `apply`, and every module id the factory asks for is one the shell shares;
 *   2. the PANEL IDENTITY: exactly one `sidebar.panellist` row and one keyed `main`
 *      panel, with the row's `id` EQUAL to the panel's `key`. A row without its twin
 *      renders and then throws on the user's first click. The declared `__identity`
 *      export is compared against BOTH registrations, so the two encodings of the one
 *      fact cannot disagree;
 *   3. every route the panel uses appears as a COMPLETE quoted literal — a prefix
 *      match is not a path — and the NOT RUN token appears in a RETURN position, so a
 *      comment mentioning it cannot satisfy the check;
 *   4. THE RENDER DIFFERENCE the deliverable names: the pure renderer is driven with
 *      (a) `last: null` and (b) a run with findings, and the two renderings must
 *      DIFFER. It also drives an empty FINDINGS list inside a real run, because
 *      "NOT RUN" and "a run that found nothing" are different facts and the panel
 *      must not collapse them;
 *   5. ABSENT IS NOT ZERO, and `of: null` is NOT a clean check. A check the host did
 *      not evaluate renders NOT MEASURED with the host's reason; an absent field
 *      never becomes `0`, while a field that really was `0` renders `0 of 0`;
 *   6. TWO MUTATIONS, because a green total says only "nothing that ran disagreed".
 *      (i) the difference assertion is fed two IDENTICAL renderings and must refuse;
 *      (ii) a COPY of the built bundle has `return "NOT RUN"` renamed, is loaded, and
 *      the NOT RUN assertion must then refuse. Neither mutation changes the real
 *      bundle, and each proves an assertion can fail rather than describing it;
 *   7. the client opens no model and no device: the bundle reaches exactly the two
 *      plugin routes, no socket/WebSocket/XHR, no model endpoint, no Node builtin.
 *
 * Every assertion is counted and the total is printed; a green run states its own
 * denominator. Exit code is non-zero on any failure.
 *
 * Usage: node verify/observer-render.mjs [lib/client.js]
 */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve as resolvePath, join } from 'node:path'
import { tmpdir } from 'node:os'

const BUNDLE = process.argv[2] ?? 'lib/client.js'
const resolved = resolvePath(BUNDLE)

let assertCount = 0
let failed = 0
/**
 * One assertion, counted.
 * @param {string} label - what is being asserted, printed on success.
 * @param {() => void} body - throws to fail.
 */
function check(label, body) {
  assertCount += 1
  try {
    body()
  } catch (error) {
    failed += 1
    console.error(`FAIL  ${label}\n      ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  console.log(`PASS  ${label}`)
}

/**
 * Assert two renderings are different. Shared by the real check and by its
 * mutation, so the mutation exercises THE SAME comparison the real check uses.
 * @param {string} label - the pair being compared.
 * @param {string} a - canonical form of the first rendering.
 * @param {string} b - canonical form of the second rendering.
 */
function differentOrThrow(label, a, b) {
  if (a === b) throw new Error(`${label}: the two renderings are IDENTICAL — the panel cannot tell these states apart`)
}

// ---- 0: the artifact exists at all ---------------------------------------
// Assertion #1 rather than a thrown usage error: an absent build must be a RED RUN
// with a counted failure, not a stack trace a reader could mistake for a broken
// harness.
check(`bundle exists and is non-empty: ${BUNDLE}`, () => {
  if (!existsSync(resolved)) throw new Error(`no built browser bundle at ${resolved} — the client half is not built`)
  const bytes = statSync(resolved).size
  if (bytes === 0) throw new Error('the bundle is 0 bytes, which is a failed build rather than an empty panel')
})
if (failed > 0) {
  console.error('')
  console.error(`OBSERVER RENDER: FAIL — ${failed} of ${assertCount} assertion(s) failed (RED, as required before the panel exists)`)
  process.exit(1)
}

const bundleBytes = statSync(resolved).size
const bundleRaw = readFileSync(resolved)
const bundleText = bundleRaw.toString('utf8')
const sha256 = createHash('sha256').update(bundleRaw).digest('hex')

// ---- the frozen module table --------------------------------------------
// `react` is stubbed with a createElement that RECORDS the element tree, so the
// panel's renderer can be driven without a DOM and without a hook dispatcher.
/** @param {unknown} type @param {Record<string, unknown>|null} props @param {...unknown} children */
function h(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(Infinity) }
}
const reactStub = {
  createElement: h,
  Fragment: Symbol('Fragment'),
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
}
/** Module ids the shell shares into the frozen table (harness `PLATFORM_MODULES`). */
const PLATFORM_WHITELIST = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
  '@deepseek-ai/dsh-client-locale',
])
const TABLE = {
  react: reactStub,
  'react/jsx-runtime': { jsx: h, jsxs: h, Fragment: reactStub.Fragment },
}
const asked = new Set()
/** @param {string} id */
function requireStub(id) {
  asked.add(id)
  if (Object.prototype.hasOwnProperty.call(TABLE, id)) return TABLE[id]
  if (PLATFORM_WHITELIST.has(id)) return { __platform: id }
  throw new Error(`UNRESOLVABLE module id in the client bundle: ${id}`)
}

/**
 * Load one client bundle the way the page does and return the module it registers.
 * @param {string} code - the bundle source.
 * @param {string} tag - a unique tag for `window.__ModuleLoader__` capture.
 * @returns {Record<string, unknown>} the module exports.
 */
function loadBundle(code, tag) {
  const target = join(tmpdir(), `dsh-meta-research-${tag}-${process.pid}.cjs`)
  writeFileSync(target, code, 'utf8')
  let loaded = null
  globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }
  const require = createRequire(import.meta.url)
  try {
    require(target)
  } finally {
    try { unlinkSync(target) } catch { /* best effort */ }
  }
  if (loaded === null) throw new Error('the bundle never called window.__ModuleLoader__.load')
  if (typeof loaded.factory !== 'function') throw new Error('the factory is not a function')
  return loaded.factory(requireStub)
}

// ---- 1: the loader contract ---------------------------------------------
let loadedSpec = null
globalThis.window = { __ModuleLoader__: { load: (spec) => { loadedSpec = spec } } }
const require = createRequire(import.meta.url)
require(resolved)

let mod = null
check('the bundle registers itself through window.__ModuleLoader__.load', () => {
  if (loadedSpec === null) throw new Error('the bundle never called window.__ModuleLoader__.load')
})
check('bundle id is the package name dsh-meta-research', () => {
  if (loadedSpec.id !== 'dsh-meta-research') throw new Error(`wrong bundle id: ${JSON.stringify(loadedSpec.id)}`)
})
check('the factory is a function and returns the module', () => {
  mod = loadedSpec.factory(requireStub)
  if (mod === null || typeof mod !== 'object') throw new Error('the factory returned no module object')
})
check('exports name=dsh-meta-research, a callable apply, and inject', () => {
  if (mod.name !== 'dsh-meta-research') throw new Error(`wrong plugin name export: ${JSON.stringify(mod.name)}`)
  if (typeof mod.apply !== 'function') throw new Error('no apply export')
  if (!Array.isArray(mod.inject)) throw new Error(`inject is not an array: ${JSON.stringify(mod.inject)}`)
})
check('inject names the two Client services this half reads', () => {
  const want = ['slots', 'locale']
  const missing = want.filter((s) => !mod.inject.includes(s))
  if (missing.length > 0) throw new Error(`inject is missing ${JSON.stringify(missing)}; got ${JSON.stringify(mod.inject)}`)
})

// ---- the recording fake Client context ----------------------------------
const registrations = []
const dictionaries = []
const injectedSlots = new Set()
const fakeCtx = {
  slots: {
    inject: (key, cb) => { injectedSlots.add(key); cb(); return () => {} },
    register: (options, component) => { registrations.push({ options, component }); return () => {} },
  },
  locale: {
    register: (ns, lang, dict) => { dictionaries.push({ ns, lang, dict }); return () => {} },
    bind: (ns) => (key) => {
      const dict = dictionaries.find((d) => d.ns === ns && d.lang === 'en')
      return dict?.dict?.[key] ?? key
    },
  },
  effect: (fn) => { const off = fn(); return () => { if (off) off() } },
  logger: { info: () => {}, warn: () => {} },
}
check('apply() runs against a recording Client context and registers something', () => {
  mod.apply(fakeCtx)
  if (registrations.length === 0) throw new Error('apply registered no slots')
})
check('every module id the bundle asked for is one the shell shares', () => {
  const bad = [...asked].filter((id) => !Object.prototype.hasOwnProperty.call(TABLE, id) && !PLATFORM_WHITELIST.has(id))
  if (bad.length > 0) throw new Error(`asked for ids the shell does not share: ${JSON.stringify(bad)}`)
})

// ---- 2: THE PANEL IDENTITY ----------------------------------------------
const navRows = registrations.filter((r) => r.options.name === 'sidebar.panellist')
const mainPanels = registrations.filter((r) => r.options.name === 'main')
const mainKeys = mainPanels.map((r) => r.options.key)

check('exactly one observer nav row in sidebar.panellist', () => {
  if (navRows.length !== 1) throw new Error(`expected 1 sidebar.panellist row, found ${navRows.length}: ${JSON.stringify(navRows.map((r) => r.options.id))}`)
})
check('exactly one keyed main panel behind it', () => {
  if (mainPanels.length !== 1) throw new Error(`expected 1 main panel, found ${mainPanels.length}: ${JSON.stringify(mainKeys)}`)
})
check('the row id is the stable selector dsh-meta-research:observer', () => {
  const ids = navRows.map((r) => r.options.id)
  if (!ids.includes('dsh-meta-research:observer')) throw new Error(`the row id is not the documented selector: ${JSON.stringify(ids)}`)
})
check('the row id EQUALS the main key (a row without its twin throws on first click)', () => {
  const orphans = navRows.filter((r) => !mainKeys.includes(r.options.id))
  if (orphans.length > 0) throw new Error(`orphan row(s), clicking one throws: ${JSON.stringify(orphans.map((r) => r.options.id))}`)
})
check('both slots were declared via slots.inject, not a bare register', () => {
  for (const slot of ['main', 'sidebar.panellist']) {
    if (!injectedSlots.has(slot)) throw new Error(`${slot} was not registered through slots.inject`)
  }
})
check('the DECLARED identity agrees with what apply registered (two encodings of one fact)', () => {
  const identity = mod.__identity
  if (identity === null || typeof identity !== 'object') throw new Error('__identity is not exported')
  if (identity.rowId !== navRows[0]?.options.id) throw new Error(`__identity.rowId ${JSON.stringify(identity.rowId)} !== registered row id ${JSON.stringify(navRows[0]?.options.id)}`)
  if (identity.mainKey !== mainKeys[0]) throw new Error(`__identity.mainKey ${JSON.stringify(identity.mainKey)} !== registered main key ${JSON.stringify(mainKeys[0])}`)
  if (identity.rowId !== identity.mainKey) throw new Error('the two declared spellings disagree with each other')
})
check('the en dictionary is registered under the meta-research namespace with every key the renderer uses', () => {
  const en = dictionaries.find((d) => d.ns === 'meta-research' && d.lang === 'en')
  if (en === undefined) throw new Error(`no en dictionary under "meta-research"; got ${JSON.stringify(dictionaries.map((d) => `${d.ns}/${d.lang}`))}`)
  const required = [
    'row', 'title', 'subtitle', 'readHeading', 'readLabel', 'fetchedAtLabel', 'noteLabel',
    'stateLabel', 'lastHeading', 'atLabel', 'checksHeading', 'checksHint', 'checksEmpty',
    'unnamedCheck', 'noReason', 'coverageHeading', 'completeLabel', 'checksEvaluatedLabel',
    'unitsExaminedLabel', 'findingsTotalLabel', 'checksNotEvaluatedLabel', 'findingsHeading',
    'kindLabel', 'idLabel', 'detailLabel', 'emptyFindings', 'notRunHint', 'noRunFieldHint',
    'unreadHint', 'runButton', 'refreshButton', 'noView',
  ]
  const missing = required.filter((k) => typeof en.dict[k] !== 'string' || en.dict[k].length === 0)
  if (missing.length > 0) throw new Error(`the en dictionary is missing/empty for ${JSON.stringify(missing)}`)
})

// ---- 3: route literals + the NOT RUN return position --------------------
/** Does the bundle contain this exact string as a quoted literal? */
function quotedLiteral(value) {
  return bundleText.includes(`"${value}"`) || bundleText.includes(`'${value}'`)
}
check('both route paths appear as COMPLETE quoted literals in the bundle', () => {
  const missing = ['/meta-research/api/last', '/meta-research/api/run'].filter((p) => !quotedLiteral(p))
  if (missing.length > 0) throw new Error(`the bundle has no complete literal for ${JSON.stringify(missing)} — the panel cannot reach the route (a prefix match is not a path)`)
})
check('the token "NOT RUN" is RETURNED by code, not merely mentioned in a comment', () => {
  if (!/return\s+["']NOT RUN["']/.test(bundleText)) {
    throw new Error('NOT RUN appears only in prose: the badge would never emit it, and a mere presence check would still pass')
  }
})
check('the token "NOT MEASURED" is RETURNED by code, not merely mentioned in a comment', () => {
  if (!/return\s+NOT_MEASURED\b/.test(bundleText) && !/return\s+["']NOT MEASURED["']/.test(bundleText)) {
    throw new Error('NOT MEASURED is never returned, so an unread value cannot render as unread')
  }
})
check('the bundle distinguishes a 404 from a refusal (it tests response.status)', () => {
  if (!/status\s*===\s*404|404\s*===?\s*[a-zA-Z.]*status|\.status\s*===?\s*404/.test(bundleText)) {
    throw new Error('no 404 test in the bundle, so "not mounted" cannot be told apart from "the route refused"')
  }
})

// ---- 4/5: DRIVE THE RENDERER -------------------------------------------
const render = mod.__renderResearch
const viewOf = mod.__viewOf
const labelOf = mod.__lastLabel
const toneOf = mod.__lastTone
check('the panel exports its pure renderer, normalizer and state rules for driving', () => {
  if (typeof render !== 'function') throw new Error('__renderResearch is not exported — the panel cannot be driven')
  if (typeof viewOf !== 'function') throw new Error('__viewOf is not exported — a payload cannot be normalised')
  if (typeof labelOf !== 'function') throw new Error('__lastLabel is not exported')
  if (typeof toneOf !== 'function') throw new Error('__lastTone is not exported')
})
check('the control\'s POST is exported as a driven seam, not only a string', () => {
  if (typeof mod.__runResearch !== 'function') throw new Error('__runResearch is not exported')
})

/** The translator the panel receives, bound to the registered dictionary. */
const t = (key) => {
  const dict = dictionaries.find((d) => d.ns === 'meta-research' && d.lang === 'en')?.dict
  return dict?.[key] ?? key
}
/** Every text node in a recorded element tree, flattened. */
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'object' && 'type' in node) return textOf(node.children)
  return ''
}
/** Find the first element whose props carry a given data-testid. */
function findTestId(node, id) {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findTestId(child, id)
      if (hit !== null) return hit
    }
    return null
  }
  if (node.props?.['data-testid'] === id) return node
  return findTestId(node.children, id)
}
/** All elements carrying a given data-testid. */
function findAllTestId(node, id, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAllTestId(child, id, out)
    return out
  }
  if (node.props?.['data-testid'] === id) out.push(node)
  findAllTestId(node.children, id, out)
  return out
}
/** A canonical string of the whole recorded tree; the difference assertion's subject. */
function canon(tree) {
  return JSON.stringify(tree)
}

/**
 * A payload exactly as the host lane committed to serve.
 * @param {unknown} last - the `last` field.
 * @param {string} [note] - the route's always-present note.
 */
function lastPayload(last, note = 'no run recorded in this process') {
  return { ok: true, last, note }
}

/** One CHECK as the host serves it: `findings` is an ARRAY, `of` the denominator. */
function check4(kind, unit, of, checked, findings, reason = null) {
  return { kind, unit, of, checked, findings, reason }
}
/** One FINDING as the host serves it. */
function finding(kind, id, detail) {
  return { kind, id, detail }
}

/** The full run the host will serve once the census is in. */
const RUN = {
  ranAt: '2026-10-18T09:30:00.000Z',
  census: {
    censusAt: '2026-10-18T09:30:00.000Z',
    complete: false,
    checksEvaluated: { count: 3, of: 4 },
    sources: [{ name: 'intentMap', location: '127.0.0.1:11434/api/ps', readable: false, status: null, bytes: null, reason: 'connection refused' }],
    checks: [
      check4('scope-missing-path', 'scope entries', 48, 48, [finding('scope-missing-path', 'T24', 'plan/24-meta-research.md is missing')]),
      check4('intent-plan-document-missing', 'plan documents', 12, 12, []),
      check4('authorised-clone-not-linked', 'clones', 4, 4, []),
      check4('intent-map-stale', 'models', null, null, [], '127.0.0.1:11434/api/ps is refusing connections'),
    ],
    totals: {
      unitsExamined: { count: 306, of: null },
      findings: { count: 1, of: 306 },
      byKind: {},
      checksNotEvaluated: { count: 1, of: 4 },
    },
  },
  findings: [finding('scope-missing-path', 'T24', 'plan/24-meta-research.md is missing')],
}

/** A run that WAS recorded and found nothing, with complete coverage (a clean run). */
const CLEAN_RUN = {
  ranAt: '2026-10-18T09:31:00.000Z',
  census: {
    censusAt: '2026-10-18T09:31:00.000Z',
    complete: true,
    checksEvaluated: { count: 4, of: 4 },
    sources: [],
    checks: [
      check4('scope-missing-path', 'scope entries', 48, 48, []),
      check4('intent-plan-document-missing', 'plan documents', 12, 12, []),
      check4('authorised-clone-not-linked', 'clones', 4, 4, []),
      check4('intent-map-stale', 'models', 8, 8, []),
    ],
    totals: { unitsExamined: { count: 72, of: 72 }, findings: { count: 0, of: 72 }, byKind: {}, checksNotEvaluated: { count: 0, of: 4 } },
  },
  findings: [],
}

const notRunTree = render(viewOf(lastPayload(null)), t)
const runTree = render(viewOf(lastPayload(RUN, 'last run recorded at 2026-10-18T09:30:00.000Z')), t)
const cleanRunTree = render(viewOf(lastPayload(CLEAN_RUN, 'last run recorded at 2026-10-18T09:31:00.000Z')), t)

/** THE NOT RUN SUBJECT, shared by the real check and its artifact mutation. */
function assertNotNullRun(mod2, tree) {
  const text = textOf(tree)
  if (!text.includes('NOT RUN')) throw new Error(`the never-run panel did not render "NOT RUN"; it rendered: ${JSON.stringify(text.slice(0, 300))}`)
  for (const gone of ['checks', 'coverage', 'findings']) {
    if (findTestId(tree, gone) !== null) throw new Error(`a NOT RUN panel mounted the "${gone}" section — an empty table is a different fact from no run at all`)
  }
  const badge = findTestId(tree, 'last-state')
  if (badge === null) throw new Error('no element carries data-testid="last-state"')
  if (badge.props['data-state'] !== 'not-run') throw new Error(`the badge data-state is ${JSON.stringify(badge.props['data-state'])}`)
  if (badge.props['data-tone'] === 'ok') throw new Error('a never-run panel rendered tone=ok')
  if (mod2.__lastLabel(mod2.__viewOf({ ok: true, last: null }).last) !== 'NOT RUN') {
    throw new Error('__lastLabel does not return NOT RUN for a null last')
  }
}

check('last:null renders NOT RUN as its own state, mounts no checks/coverage/findings section, and is not green', () => {
  assertNotNullRun(mod, notRunTree)
})
check('a run with findings renders RUN RECORDED, not NOT RUN', () => {
  const text = textOf(runTree)
  if (!text.includes('RUN RECORDED')) throw new Error(`the run panel did not render "RUN RECORDED": ${JSON.stringify(text.slice(0, 300))}`)
  if (text.includes('NOT RUN')) throw new Error('a recorded run rendered the NOT RUN token — the two states collapsed')
  const badge = findTestId(runTree, 'last-state')
  if (badge === null || badge.props['data-state'] !== 'run') throw new Error('the badge does not carry data-state="run"')
})
check('a run with findings is NOT rendered green (findings are not a pass)', () => {
  if (toneOf(viewOf(lastPayload(RUN)).last) === 'ok') throw new Error('a run that found a drift rendered tone=ok')
  if (findTestId(runTree, 'last-state').props['data-tone'] === 'ok') throw new Error('the badge rendered tone=ok over findings')
})
check('POSITIVE CONTROL: a COMPLETE run that found nothing renders tone=ok (so "never green" is not vacuous)', () => {
  const clean = viewOf(lastPayload(CLEAN_RUN))
  if (toneOf(clean.last) !== 'ok') throw new Error(`a complete, finding-free run rendered tone=${JSON.stringify(toneOf(clean.last))}`)
  const badge = findTestId(cleanRunTree, 'last-state')
  if (badge === null || badge.props['data-tone'] !== 'ok') throw new Error('the badge did not render tone=ok for a complete clean run')
})
check('an INCOMPLETE census with zero findings renders neither ok nor a fabricated pass', () => {
  const partial = { ...CLEAN_RUN, census: { ...CLEAN_RUN.census, complete: false } }
  const tone = toneOf(viewOf(lastPayload(partial)).last)
  if (tone === 'ok') throw new Error('an INCOMPLETE census rendered tone=ok — partial coverage is not a clean result')
})
check('THE DELIVERABLE: the last:null rendering and the run-with-findings rendering DIFFER', () => {
  differentOrThrow('last:null vs run-with-findings', canon(notRunTree), canon(runTree))
})
check('a run that found NOTHING also differs from NOT RUN (an empty findings list is a reading, not an absence)', () => {
  differentOrThrow('last:null vs run-found-nothing', canon(notRunTree), canon(cleanRunTree))
  const text = textOf(cleanRunTree)
  if (!text.includes('RUN RECORDED')) throw new Error('a recorded run with no findings did not render RUN RECORDED')
  if (!text.includes('0 finding(s)')) throw new Error(`a recorded run with no findings did not render its zero count; it rendered: ${JSON.stringify(text.slice(0, 400))}`)
  if (findTestId(cleanRunTree, 'findings-empty') === null) throw new Error('no findings-empty element: an empty list must say it is a reading')
})
check('the four drift checks render in order, each with its name', () => {
  const rows = findAllTestId(runTree, 'check-row')
  if (rows.length !== 4) throw new Error(`expected exactly 4 check rows, found ${rows.length}`)
  const names = rows.map((r) => r.props['data-check'])
  const want = ['scope-missing-path', 'intent-plan-document-missing', 'authorised-clone-not-linked', 'intent-map-stale']
  if (JSON.stringify(names) !== JSON.stringify(want)) throw new Error(`check rows are ${JSON.stringify(names)}, expected ${JSON.stringify(want)}`)
})
check('a measured check renders findings OF its denominator (numerator and denominator together)', () => {
  const rows = findAllTestId(runTree, 'check-row')
  const row = rows.find((r) => r.props['data-check'] === 'scope-missing-path')
  if (row === undefined) throw new Error('no scope-missing-path row')
  if (row.props['data-measured'] !== 'true') throw new Error('a fully checked row rendered data-measured=false')
  const text = textOf(row)
  if (!text.includes('1 of 48')) throw new Error(`the check row reads ${JSON.stringify(text)} — a numerator without its denominator is a caption`)
  const value = row.children.find((child) => child?.props?.['data-findings'] !== undefined)
  if (value === undefined || value.props['data-findings'] !== 1 || value.props['data-of'] !== 48) {
    throw new Error(`the row data attributes are ${JSON.stringify(value?.props)}, expected data-findings=1 data-of=48`)
  }
})
check('a check the host could NOT evaluate renders NOT MEASURED with the host reason, never 0 and never clean', () => {
  const rows = findAllTestId(runTree, 'check-row')
  const row = rows.find((r) => r.props['data-check'] === 'intent-map-stale')
  if (row === undefined) throw new Error('no intent-map-stale row')
  if (row.props['data-measured'] !== 'false') throw new Error('an unevaluated check rendered data-measured=true')
  const text = textOf(row)
  if (!text.includes('NOT MEASURED')) throw new Error(`the unevaluated row reads ${JSON.stringify(text)} — it must say NOT MEASURED`)
  if (!text.includes('127.0.0.1:11434/api/ps is refusing connections')) throw new Error('the host\'s reason for the unevaluated check was dropped')
  if (/\b0 of\b|\bof 0\b/.test(text)) throw new Error(`the unevaluated row invented a zero: ${JSON.stringify(text)}`)
})
check('ABSENT is not ZERO, and a real zero IS rendered: absent `of` is NOT MEASURED, `of:0` renders 0 of 0', () => {
  const absent = viewOf(lastPayload({
    ranAt: '2026-10-18T09:32:00.000Z',
    census: { complete: false, checksEvaluated: { count: 0, of: 1 }, checks: [{ kind: 'k', unit: 'u', checked: null, findings: [], reason: 'unreadable source' }], totals: {} },
    findings: [],
  }))
  const absentRow = findAllTestId(render(absent, t), 'check-row')[0]
  if (absentRow === undefined) throw new Error('the absent-`of` payload rendered no check row')
  if (absentRow.props['data-measured'] !== 'false') throw new Error('an ABSENT `of` was read as measured')
  if (!textOf(absentRow).includes('NOT MEASURED')) throw new Error('an ABSENT `of` did not render NOT MEASURED')

  const zero = viewOf(lastPayload({
    ranAt: '2026-10-18T09:33:00.000Z',
    census: { complete: true, checksEvaluated: { count: 1, of: 1 }, checks: [{ kind: 'k', unit: 'u', of: 0, checked: 0, findings: [] }], totals: {} },
    findings: [],
  }))
  const zeroRow = findAllTestId(render(zero, t), 'check-row')[0]
  if (zeroRow === undefined) throw new Error('the zero-`of` payload rendered no check row')
  if (zeroRow.props['data-measured'] !== 'true') throw new Error('a REAL zero was folded into unread')
  if (!textOf(zeroRow).includes('0 of 0')) throw new Error(`a real zero rendered as ${JSON.stringify(textOf(zeroRow))}`)
})
check('the findings list renders kind, id and a monospace detail for each finding', () => {
  const rows = findAllTestId(runTree, 'finding')
  if (rows.length !== 1) throw new Error(`expected 1 finding row, found ${rows.length}`)
  const row = rows[0]
  if (row.props['data-kind'] !== 'scope-missing-path') throw new Error(`finding kind is ${JSON.stringify(row.props['data-kind'])}`)
  if (row.props['data-id'] !== 'T24') throw new Error(`finding id is ${JSON.stringify(row.props['data-id'])}`)
  const text = textOf(row)
  for (const token of ['scope-missing-path', 'T24', 'plan/24-meta-research.md is missing']) {
    if (!text.includes(token)) throw new Error(`the finding row never rendered ${JSON.stringify(token)}; it rendered ${JSON.stringify(text)}`)
  }
  const detail = row.children[row.children.length - 1]
  if (String(detail?.props?.style?.fontFamily ?? '').indexOf('monospace') === -1) throw new Error('the detail column is not monospace')
  if (!findAllTestId(runTree, 'findings-count')[0]?.children?.length) throw new Error('no findings count element')
})
check('the coverage section carries every count with its denominator, and of:null as NOT MEASURED', () => {
  const units = findTestId(runTree, 'coverage-units')
  if (units === null) throw new Error('no coverage-units element')
  if (!textOf(units).includes('306 of NOT MEASURED')) {
    throw new Error(`the units line reads ${JSON.stringify(textOf(units))} — an absent denominator must render NOT MEASURED, not 0`)
  }
  const complete = findTestId(runTree, 'coverage-complete')
  if (complete === null || !textOf(complete).includes('INCOMPLETE')) throw new Error('the completeness line does not say INCOMPLETE')
  const checks = findTestId(runTree, 'coverage-checks')
  if (checks === null || !textOf(checks).includes('3 of 4')) throw new Error('the checks-evaluated line lost its denominator')
})
check('an unread route renders NOT MEASURED rather than an empty panel', () => {
  const view = { fetchedAt: null, read: 'unreachable', note: 'network error', last: { state: 'unread', at: null, checks: null, findings: null, coverage: null, note: 'network error' } }
  const text = textOf(render(view, t))
  if (!text.includes('NOT MEASURED')) throw new Error('an unread route did not render NOT MEASURED')
  if (text.includes('NOT RUN')) throw new Error('an unread route rendered NOT RUN — "could not read" is not "no run yet"')
})
check('a payload with NO `last` field renders NO RUN FIELD, distinct from last:null', () => {
  const tree = render(viewOf({ ok: true, built: true, note: 'scaffold' }), t)
  const text = textOf(tree)
  if (!text.includes('NO RUN FIELD')) throw new Error(`a scaffold payload did not render NO RUN FIELD: ${JSON.stringify(text.slice(0, 300))}`)
  if (text.includes('NOT RUN')) throw new Error('a missing `last` field was folded into NOT RUN — absent is not null')
})

// ---- 6: THE SCROLL FRAME (the owner's "unscrollable output") ------------
/**
 * Assert the panel frame is a BOUNDED COLUMN. Shared by the real check and by its
 * mutations, so a mutation exercises THE SAME function the real check uses.
 * @param {unknown} tree - a recorded element tree.
 */
function assertFrameBounded(tree) {
  const frame = findTestId(tree, 'meta-research')
  if (frame === null) throw new Error('no data-testid="meta-research" frame')
  const style = frame.props.style ?? {}
  if (style.display !== 'flex' || style.flexDirection !== 'column') throw new Error(`the frame is not a flex column: ${JSON.stringify({ display: style.display, flexDirection: style.flexDirection })}`)
  if (style.height !== '100%') throw new Error(`the frame height is ${JSON.stringify(style.height)}; it must be bounded to the centre column`)
  if (style.minHeight !== 0) throw new Error(`the frame minHeight is ${JSON.stringify(style.minHeight)}; a flex item without minHeight 0 grows past its parent and pushes the overflow out`)
  if (style.flex !== '1 1 auto') throw new Error(`the frame flex is ${JSON.stringify(style.flex)}; it must fill the centre column`)
  if (style.overflow !== 'hidden') throw new Error(`the frame overflow is ${JSON.stringify(style.overflow)}; it must clip what escapes the frame`)
}

/**
 * Assert the HEADER is fixed and the BODY is the scroll container — the exact
 * property the owner reported missing.
 * @param {unknown} tree - a recorded element tree.
 * @param {(key: string) => string} translator - bound en translator.
 * @param {readonly string[]} sections - the section test ids this state MUST mount in the body.
 */
function assertScroller(tree, translator, sections) {
  const header = findTestId(tree, 'meta-research-header')
  const scroll = findTestId(tree, 'meta-research-scroll')
  if (header === null) throw new Error('no data-testid="meta-research-header"')
  if (scroll === null) throw new Error('no data-testid="meta-research-scroll"')
  const hs = header.props.style ?? {}
  const ss = scroll.props.style ?? {}
  if (hs.flex !== '0 0 auto') throw new Error(`the header flex is ${JSON.stringify(hs.flex)}; a fixed header must not grow or shrink`)
  if (ss.flex !== '1 1 auto') throw new Error(`the scroller flex is ${JSON.stringify(ss.flex)}; the body must take the remaining height`)
  if (ss.overflowY !== 'auto') throw new Error(`the scroller overflowY is ${JSON.stringify(ss.overflowY)}; THIS is the element the scrollbar belongs to, and the ancestor with overflow hidden is NOT`)
  if (ss.minHeight !== 0) throw new Error(`the scroller minHeight is ${JSON.stringify(ss.minHeight)}; without 0 a flex child refuses to shrink and the page cannot scroll`)
  for (const id of sections) {
    if (findTestId(scroll, id) === null) throw new Error(`section "${id}" is not inside the scroller — it would never scroll`)
    if (findTestId(header, id) !== null) throw new Error(`section "${id}" is inside the FIXED header — scrolling would move content that must stay fixed`)
  }
  if (!textOf(header).includes(translator('title'))) throw new Error('the panel title is not in the fixed header')
}

/** A deep copy of a recorded element tree, so a mutation cannot touch the real one. */
function cloneTree(tree) {
  return JSON.parse(JSON.stringify(tree))
}

check('the panel frame is a BOUNDED flex column (height 100%, minHeight 0, flex 1 1 auto, overflow hidden)', () => {
  assertFrameBounded(runTree)
})
check('the header is FIXED (flex 0 0 auto) and the BODY is the SCROLLER (overflowY auto, minHeight 0)', () => {
  assertScroller(runTree, t, ['read', 'last', 'checks', 'coverage', 'findings'])
})
check('the never-run state uses the SAME bounded frame (loading and loaded cannot diverge)', () => {
  assertFrameBounded(notRunTree)
  assertScroller(notRunTree, t, ['read', 'last'])
})
check('MUTATION (input): making the scroller overflowY visible makes the scroll assertion REFUSE', () => {
  const mutated = cloneTree(runTree)
  const scroll = findTestId(mutated, 'meta-research-scroll')
  if (scroll === null) throw new Error('no scroller in the cloned tree')
  scroll.props.style.overflowY = 'visible'
  let refused = false
  try {
    assertScroller(mutated, t, ['read', 'last', 'checks', 'coverage', 'findings'])
  } catch {
    refused = true
  }
  if (!refused) throw new Error('the scroll assertion accepted overflowY:visible — it cannot fail, so the real check proves nothing')
})

// ---- 7: MUTATIONS -------------------------------------------------------
check('MUTATION (input): the difference assertion REFUSES two identical renderings, so it can fail', () => {
  const same = canon(runTree)
  let refused = false
  try {
    differentOrThrow('mutation', same, same)
  } catch {
    refused = true
  }
  if (!refused) throw new Error('the difference assertion accepted identical renderings — it cannot fail, so the real check proves nothing')
})
check('MUTATION (artifact): renaming `return "NOT RUN"` in a COPY of the bundle makes the NOT RUN assertion refuse', () => {
  const mutatedText = bundleText.replace(/return\s+(["'])NOT RUN\1/g, 'return "RUN RECORDED"')
  if (mutatedText === bundleText) throw new Error('the mutation did not apply — the bundle carries no `return "NOT RUN"` to rename')
  const mutated = loadBundle(mutatedText, 'mutated')
  let refused = false
  try {
    const tree = mutated.__renderResearch(mutated.__viewOf(lastPayload(null)), t)
    assertNotNullRun(mutated, tree)
  } catch {
    refused = true
  }
  if (!refused) throw new Error('the mutated bundle still passed the NOT RUN assertion — the check reads a caption, not the artifact')
})
check('MUTATION (artifact): making the BUILT scroller overflowY visible makes the scroll assertion refuse', () => {
  const mutatedText = bundleText.replace(/overflowY:\s*(["'])auto\1/g, 'overflowY: "visible"')
  if (mutatedText === bundleText) throw new Error('the mutation did not apply — the built bundle carries no `overflowY: "auto"` to change')
  const mutated = loadBundle(mutatedText, 'mutated-scroll')
  let refused = false
  try {
    const tree = mutated.__renderResearch(mutated.__viewOf(lastPayload(RUN)), t)
    assertScroller(tree, t, ['read', 'last', 'checks', 'coverage', 'findings'])
  } catch {
    refused = true
  }
  if (!refused) throw new Error('the mutated artifact still passed the scroll assertion — the check reads the source comment, not the built element')
})

// ---- 8: no model, no device, no socket ----------------------------------
check('the client reaches no model and opens no device/socket', () => {
  const forbidden = [
    ['WebSocket', /\bnew\s+WebSocket\b/],
    ['XMLHttpRequest', /\bXMLHttpRequest\b/],
    ['node builtin import', /require\(\s*["']node:/],
    ['a model endpoint', /127\.0\.0\.1:11434|localhost:11434|api\/ps|ollama|llama\.cpp|openai\.com|anthropic\.com/i],
    ['a serial device', /navigator\.serial|\/dev\/tty|COM[0-9]/],
  ]
  const hits = forbidden.filter(([, re]) => re.test(bundleText)).map(([name]) => name)
  if (hits.length > 0) throw new Error(`the bundle reaches ${JSON.stringify(hits)} — the client may not call a model or open a device`)
})
check('the bundle routes ONLY to the two plugin paths it owns', () => {
  const paths = [...bundleText.matchAll(/["'](\/[A-Za-z0-9_./-]+)["']/g)].map((m) => m[1])
  const routed = [...new Set(paths.filter((p) => p.startsWith('/') && (p.includes('/api/') || p.startsWith('/meta-'))))]
  if (routed.length !== 2) throw new Error(`expected exactly the 2 plugin API paths, found ${JSON.stringify(routed)}`)
  const want = ['/meta-research/api/last', '/meta-research/api/run'].sort()
  if (JSON.stringify(routed.sort()) !== JSON.stringify(want)) throw new Error(`unexpected route literals: ${JSON.stringify(routed)}`)
})

// ---- the verdict ---------------------------------------------------------
console.log('')
console.log(`bundle:  ${resolved}`)
console.log(`bytes:   ${bundleBytes}`)
console.log(`sha256:  ${sha256}`)
console.log(`asserts: ${assertCount - failed}/${assertCount} passed`)
if (failed > 0) {
  console.error(`OBSERVER RENDER: FAIL — ${failed} of ${assertCount} assertion(s) failed`)
  process.exit(1)
}
console.log('ALL META-RESEARCH OBSERVER RENDER CHECKS PASSED')
