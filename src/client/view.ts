/**
 * The research observer's VIEW MODEL and its PURE RENDERER.
 *
 * WHY THE RENDERER IS SEPARATE FROM THE COMPONENT. A React function component only
 * runs under a hook dispatcher, so a check that wanted to drive what a human sees
 * would need a browser or a re-implementation — and a re-implementation is not a
 * check. `renderResearch` is a plain function of (view, translator), so the BUILT
 * browser bundle can be loaded and the panel DRIVEN with a stubbed `createElement`
 * that records the element tree. `verify/observer-render.mjs` does exactly that.
 *
 * THE ROUTE CONTRACT THIS FILE RENDERS, as the host lane finalised it (not as a
 * shorthand): `last` is `null` when no run exists, otherwise
 * `{ ranAt, census: { complete, checksEvaluated, checks: CHECK[], totals }, findings:
 * [{kind,id,detail}] }`, where each CHECK is `{ kind, unit, of, checked,
 * findings: FINDING[], reason }`. The four drift checks are `census.checks` — an
 * ARRAY, iterated in order — and a check's numerator is `findings.length` while its
 * denominator is `of`. Reading the lead brief's shorthand instead of the host's
 * contract would have read a missing `last.checks` and rendered "NOT MEASURED"
 * everywhere, which looks like a broken observer rather than a broken reader.
 *
 * FOUR RULES THIS FILE ENFORCES, all of them this program's own:
 *
 *  1. **NOT RUN IS ITS OWN STATE, NOT AN EMPTY TABLE.** A `last` of `null` means no
 *     run has ever been recorded; a run whose `findings` is `[]` means a run WAS
 *     recorded and found nothing. Those are different facts, so they render as
 *     different states with different tokens — and the never-run state renders no
 *     checks, coverage or findings sections at all, so an empty table cannot be
 *     mistaken for one. `lastLabel` is the ONE place a state token is chosen.
 *  2. **A MISSING READING IS NOT A ZERO, AND A PARTIAL RUN IS NOT CLEAN.** Every
 *     numeric field is `null` when it was not read, and `null` renders `NOT
 *     MEASURED`. A check whose denominator (`of`) is `null` was NOT EVALUATED: it
 *     renders NOT MEASURED with the host's own `reason`, never `0 of null` and never
 *     a clean row. `lastTone` earns `ok` only when the census says it is COMPLETE and
 *     the findings list was read and came back empty.
 *  3. **EVERY COUNT CARRIES ITS DENOMINATOR.** A drift check renders `findings of
 *     of` (plus the check's own unit), and the census totals render as numerator/
 *     denominator pairs. A bare `3` is a caption, and this program has paid for that
 *     distinction repeatedly.
 *  4. **`of: null` IS HONEST PARTIAL COVERAGE, NOT ZERO.** When a check could not be
 *     evaluated the host sends `of: null` and a non-empty `reason`; the panel prints
 *     `count of NOT MEASURED` and the reason beside it.
 *
 * @module dsh-meta-research/client/view
 */

import { createElement as h, type ReactElement } from 'react'
import type { Translator } from './types.ts'

/** How the top-level read ended, as far as the panel needs to distinguish. */
export type ReadState = 'loaded' | 'not-mounted' | 'unreachable' | 'refused' | 'malformed'

/** The states a FAILED read can be in — everything except a successful read. */
export type FailureState = Exclude<ReadState, 'loaded'>

/**
 * The four states of the `last` slot.
 *
 * `not-run` is a literal `last: null`. `contract-missing` is the ABSENT field — a
 * route that answered without a `last` key at all — and it is deliberately NOT
 * folded into `not-run`, because "no run yet" and "this host does not serve the run
 * contract" are different instructions to a human. `unread` means the read itself
 * failed, so nothing about the last run is known.
 */
export type LastState = 'not-run' | 'run' | 'contract-missing' | 'unread'

/** One drift check: numerator, denominator, examined rows, and why it may be unmeasured. */
export interface CheckView {
  /** The check's identifier (`check.kind`), or `null` when the route gave none. */
  readonly name: string | null
  /** What the denominator counts (`check.unit`), e.g. "paths" — or `null`. */
  readonly unit: string | null
  /** Findings for this check — the NUMERATOR, from `findings.length`. `null` is unread. */
  readonly findings: number | null
  /** Rows examined (`check.checked`); `null` when the check was not evaluated. */
  readonly checked: number | null
  /** The denominator (`check.of`); `null` means NOT EVALUATED, never zero. */
  readonly of: number | null
  /** The host's own reason for a check it could not evaluate. */
  readonly reason: string | null
}

/** One finding row: `kind`, `id`, `detail`. */
export interface FindingView {
  readonly kind: string | null
  readonly id: string | null
  readonly detail: string | null
}

/** One numerator/denominator pair from the census. */
export interface RatioView {
  readonly count: number | null
  readonly of: number | null
}

/** The census's coverage readings, each kept as a pair so it cannot lose its denominator. */
export interface CoverageView {
  /** The host's own completeness flag. `null` is unread; `false` can never render clean. */
  readonly complete: boolean | null
  readonly checksEvaluated: RatioView | null
  readonly unitsExamined: RatioView | null
  readonly findings: RatioView | null
  readonly checksNotEvaluated: RatioView | null
}

/** The `last` slice of `/meta-research/api/last`, normalised. */
export interface LastView {
  readonly state: LastState
  readonly at: string | null
  readonly checks: readonly CheckView[] | null
  readonly findings: readonly FindingView[] | null
  readonly coverage: CoverageView | null
  readonly note: string | null
}

/** One read of the whole surface. */
export interface ResearchView {
  readonly fetchedAt: string | null
  readonly read: ReadState
  readonly note: string | null
  readonly last: LastView
}

/** The tones a badge may carry. `ok` is earned; it is never a default. */
export type Tone = 'ok' | 'warn' | 'unknown'

/** The token an unread value renders. A literal, so it is greppable in the bundle. */
const NOT_MEASURED = 'NOT MEASURED'

/**
 * The `last` state's text — the ONE place a state token is chosen.
 *
 * The tokens are literals on purpose: they are diagnostics, not prose, so they are
 * not translated, and `verify/observer-render.mjs` asserts `return "NOT RUN"`
 * against the built bundle in a RETURN position. A comment mentioning the token
 * cannot satisfy that check.
 * @param last - the last-run slice of the view.
 * @returns the badge text.
 */
export function lastLabel(last: LastView): string {
  if (last.state === 'not-run') return 'NOT RUN'
  if (last.state === 'contract-missing') return 'NO RUN FIELD'
  if (last.state === 'unread') return NOT_MEASURED
  return 'RUN RECORDED'
}

/**
 * The `last` state's tone — a closed map with no accidental green.
 *
 * A run earns `ok` ONLY when the census says COMPLETE and the findings list was
 * actually read and came back empty. A run that FOUND something is `warn`; an
 * INCOMPLETE census is `warn` even with zero findings, because partial coverage is
 * not a clean result; a run whose findings or completeness could not be read is
 * `unknown`; a never-run surface is `unknown` (not a failure, not a pass).
 * @param last - the last-run slice of the view.
 * @returns the tone the badge must carry.
 */
export function lastTone(last: LastView): Tone {
  if (last.state === 'contract-missing') return 'warn'
  if (last.state !== 'run') return 'unknown'
  if (last.findings === null) return 'unknown'
  if (last.coverage !== null && last.coverage.complete === false) return 'warn'
  if (last.coverage === null || last.coverage.complete === null) {
    return last.findings.length === 0 ? 'unknown' : 'warn'
  }
  return last.findings.length === 0 ? 'ok' : 'warn'
}

/** Format one nullable reading: `null` is NOT MEASURED, never a value. */
function fmt(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return NOT_MEASURED
  return String(value)
}

/** Format a numerator/denominator pair. An absent denominator is NOT MEASURED, never 0. */
function ratioText(count: number | null, of: number | null): string {
  if (count === null) return NOT_MEASURED
  if (of === null) return `${count} of ${NOT_MEASURED}`
  return `${count} of ${of}`
}

/** Format a census ratio, or NOT MEASURED when the whole pair was unread. */
function coverageRatio(ratio: RatioView | null): string {
  if (ratio === null) return NOT_MEASURED
  return ratioText(ratio.count, ratio.of)
}

/** One label/value line in a section. */
function line(label: string, value: string, testId?: string): ReactElement {
  return h('div', {
    key: `${label}:${testId ?? ''}`,
    style: { display: 'flex', gap: '8px', alignItems: 'baseline', padding: '2px 0' },
    ...(testId === undefined ? {} : { 'data-testid': testId }),
  },
  h('span', { style: { minWidth: '132px', color: 'var(--dsh-text-2, #8b949e)', fontSize: '12px' } }, label),
  h('span', { style: { fontFamily: 'ui-monospace, monospace', fontSize: '12px', overflowWrap: 'anywhere' } }, value))
}

/** A titled section with a stable `data-testid`. */
function section(testId: string, title: string, children: (ReactElement | null)[]): ReactElement {
  return h('section', {
    key: testId,
    'data-testid': testId,
    style: { border: '1px solid var(--dsh-border, #30363d)', borderRadius: '8px', padding: '10px 12px', marginBottom: '10px' },
  },
  h('h3', { style: { margin: '0 0 6px', fontSize: '13px' } }, title),
  ...children.filter((child): child is ReactElement => child !== null))
}

/** The badge's colours, derived from its tone and nothing else. */
function badgeStyle(tone: Tone): Record<string, string | number> {
  return {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: '999px',
    fontSize: '11px',
    fontWeight: 600,
    letterSpacing: '0.04em',
    border: '1px solid',
    ...(tone === 'ok'
      ? { color: '#1a7f37', borderColor: '#1a7f37', background: 'rgba(26,127,55,0.10)' }
      : tone === 'warn'
        ? { color: '#9a6700', borderColor: '#9a6700', background: 'rgba(154,103,0,0.10)' }
        : { color: 'var(--dsh-text-2, #8b949e)', borderColor: 'var(--dsh-border, #30363d)', background: 'transparent' }),
  }
}

/** The route-read section: did the read itself succeed, and when. */
function readSection(view: ResearchView, t: Translator): ReactElement {
  const rows: (ReactElement | null)[] = [
    line(t('readLabel'), view.read, 'read-state'),
    line(t('fetchedAtLabel'), fmt(view.fetchedAt), 'read-fetched-at'),
  ]
  if (view.note !== null) rows.push(line(t('noteLabel'), view.note, 'read-note'))
  return section('read', t('readHeading'), rows)
}

/** The last-run section: the state badge and the one hint that tells states apart. */
function lastSection(last: LastView, t: Translator): ReactElement {
  const tone = lastTone(last)
  const badge = h('span', {
    'data-testid': 'last-state',
    'data-state': last.state,
    'data-tone': tone,
    style: badgeStyle(tone),
  }, lastLabel(last))

  const rows: (ReactElement | null)[] = [
    h('div', { key: 'badge', style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '2px 0' } }, badge),
  ]
  if (last.state === 'not-run') {
    rows.push(line(t('stateLabel'), t('notRunHint'), 'last-hint'))
  } else if (last.state === 'contract-missing') {
    rows.push(line(t('stateLabel'), last.note ?? t('noRunFieldHint'), 'last-hint'))
  } else if (last.state === 'unread') {
    rows.push(line(t('stateLabel'), last.note ?? t('unreadHint'), 'last-hint'))
  } else {
    rows.push(line(t('atLabel'), fmt(last.at), 'last-at'))
    if (last.note !== null) rows.push(line(t('noteLabel'), last.note, 'last-note'))
  }
  return section('last', t('lastHeading'), rows)
}

/**
 * One drift check's rendered ratio: numerator and denominator, or NOT MEASURED.
 *
 * `check.findings` is an ARRAY in the host contract, so the numerator was taken as
 * its length by the normaliser. `check.of` is the denominator and `check.checked` is
 * the examined count; both are exposed as data attributes so a check can read the
 * numbers the row was built from rather than the text it produced.
 */
function checkRow(check: CheckView, index: number, t: Translator): ReactElement {
  const name = check.name ?? t('unnamedCheck')
  const measured = check.findings !== null && check.of !== null
  const value = measured ? `${check.findings} of ${check.of}` : NOT_MEASURED
  const unit = check.unit === null ? '' : ` ${check.unit}`
  return h('div', {
    key: `check-${index}-${name}`,
    'data-testid': 'check-row',
    'data-check': check.name ?? '',
    'data-measured': measured ? 'true' : 'false',
    style: { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap', padding: '2px 0' },
  },
  h('span', { style: { minWidth: '210px', fontSize: '12px' } }, name),
  h('span', {
    style: { fontFamily: 'ui-monospace, monospace', fontSize: '12px' },
    ...(measured ? { 'data-findings': check.findings, 'data-of': check.of } : {}),
    ...(check.checked === null ? {} : { 'data-checked': check.checked }),
  }, `${value}${measured ? unit : ''}`),
  measured
    ? null
    : h('span', {
      'data-testid': 'check-reason',
      style: { flex: '1 1 220px', fontSize: '11px', color: 'var(--dsh-text-2, #8b949e)' },
    }, check.reason === null ? t('noReason') : check.reason))
}

/**
 * The four drift checks, each with findings of its denominator.
 *
 * A check whose `of` is `null` was NOT EVALUATED by the host. It renders NOT
 * MEASURED plus the host's reason, and the row carries `data-measured="false"`, so
 * neither the text nor the structure can read as a clean result.
 */
function checksSection(last: LastView, t: Translator): ReactElement {
  const checks = last.checks
  const rows: (ReactElement | null)[] = [
    h('p', { key: 'hint', style: { fontSize: '11px', color: 'var(--dsh-text-2, #8b949e)', margin: '0 0 4px' } }, t('checksHint')),
  ]
  if (checks === null) {
    rows.push(line(t('checksHeading'), NOT_MEASURED, 'checks-unread'))
  } else if (checks.length === 0) {
    rows.push(line(t('checksHeading'), t('checksEmpty'), 'checks-empty'))
  } else {
    for (const [index, check] of checks.entries()) rows.push(checkRow(check, index, t))
  }
  return section('checks', t('checksHeading'), rows)
}

/**
 * The coverage section: the census's own completeness and totals.
 *
 * Rendered only for a RUN, and every line is a numerator/denominator pair or an
 * explicit NOT MEASURED. `unitsExamined.of` is `null` whenever a check was not
 * evaluated — the host documents that as honest partial coverage, so it renders
 * `count of NOT MEASURED` rather than a zero.
 */
function coverageSection(last: LastView, t: Translator): ReactElement {
  const coverage = last.coverage
  if (coverage === null) {
    return section('coverage', t('coverageHeading'), [line(t('coverageHeading'), NOT_MEASURED, 'coverage-unread')])
  }
  const complete = coverage.complete === null
    ? NOT_MEASURED
    : coverage.complete
      ? 'COMPLETE'
      : 'INCOMPLETE'
  return section('coverage', t('coverageHeading'), [
    line(t('completeLabel'), complete, 'coverage-complete'),
    line(t('checksEvaluatedLabel'), coverageRatio(coverage.checksEvaluated), 'coverage-checks'),
    line(t('unitsExaminedLabel'), coverageRatio(coverage.unitsExamined), 'coverage-units'),
    line(t('findingsTotalLabel'), coverageRatio(coverage.findings), 'coverage-findings'),
    line(t('checksNotEvaluatedLabel'), coverageRatio(coverage.checksNotEvaluated), 'coverage-not-evaluated'),
  ])
}

/** One finding row: kind, id, and a monospace detail column. */
function findingRow(finding: FindingView, index: number): ReactElement {
  return h('div', {
    key: `finding-${index}`,
    'data-testid': 'finding',
    'data-kind': finding.kind ?? '',
    'data-id': finding.id ?? '',
    style: { display: 'flex', gap: '8px', alignItems: 'baseline', padding: '2px 0', borderTop: '1px solid var(--dsh-border, #30363d)' },
  },
  h('span', { style: { minWidth: '110px', fontSize: '12px' } }, fmt(finding.kind)),
  h('span', { style: { minWidth: '96px', fontFamily: 'ui-monospace, monospace', fontSize: '12px' } }, fmt(finding.id)),
  h('span', { style: { flex: '1 1 240px', fontFamily: 'ui-monospace, monospace', fontSize: '12px', overflowWrap: 'anywhere' } }, fmt(finding.detail)))
}

/**
 * The findings list.
 *
 * An EMPTY list renders the `emptyFindings` line and is still a RUN — the token
 * says a run was recorded, which is what keeps it distinguishable from NOT RUN.
 * An unread list renders NOT MEASURED instead.
 */
function findingsSection(last: LastView, t: Translator): ReactElement {
  const findings = last.findings
  const rows: (ReactElement | null)[] = [
    h('p', {
      key: 'count',
      'data-testid': 'findings-count',
      style: { fontSize: '12px', margin: '0 0 4px' },
    }, findings === null ? NOT_MEASURED : `${findings.length} finding(s)`),
  ]
  if (findings === null) {
    rows.push(line(t('findingsHeading'), NOT_MEASURED, 'findings-unread'))
  } else if (findings.length === 0) {
    rows.push(h('p', {
      key: 'empty',
      'data-testid': 'findings-empty',
      style: { fontSize: '12px', margin: '0' },
    }, t('emptyFindings')))
  } else {
    rows.push(h('div', {
      key: 'header',
      'data-testid': 'findings-header',
      style: { display: 'flex', gap: '8px', fontSize: '11px', color: 'var(--dsh-text-2, #8b949e)', borderTop: '1px solid var(--dsh-border, #30363d)', paddingTop: '4px' },
    },
    h('span', { style: { minWidth: '110px' } }, t('kindLabel')),
    h('span', { style: { minWidth: '96px' } }, t('idLabel')),
    h('span', { style: { flex: '1 1 240px' } }, t('detailLabel'))))
    for (const [index, finding] of findings.entries()) rows.push(findingRow(finding, index))
  }
  return section('findings', t('findingsHeading'), rows)
}

/**
 * THE PANEL FRAME — and the owner's "unscrollable output" fix lives in these three
 * style objects.
 *
 * The shell's centre column is `.centerCol` in
 * `packages/client/ui-layout/src/client/AppFrame.module.css`:
 * `display: flex; flex-direction: column; overflow: hidden`. It CLIPS. Measured on
 * the running GUI (2026-10-18T23:20Z) from this panel's root outward:
 * `.centerCol` was **clientHeight 808 / scrollHeight 5133 / overflowY hidden**, and
 * every element between it and the page root was **content-sized with overflowY
 * visible** (root 5068/5068, wrapper 5133/5133). So there was NO scroller anywhere in
 * the chain: a page taller than the column was cut off with no scrollbar and no way
 * to reach the rest.
 *
 * The frame below makes the panel its own scroll container, with the header fixed and
 * only the body scrolling:
 *
 *  - `FRAME_STYLE` is a bounded flex COLUMN. `height: 100%` bounds it to the centre
 *    column; `flex: 1 1 auto` fills that column as its flex item; `minHeight: 0` is
 *    required because a flex item's automatic minimum size would otherwise refuse to
 *    shrink below its content and push the overflow back out; `overflow: hidden`
 *    clips anything that escapes the frame.
 *  - `HEADER_STYLE` is `flex: 0 0 auto` — the fixed band (title, hint, Run/Refresh)
 *    that must stay reachable while the body scrolls.
 *  - `SCROLL_STYLE` is `flex: 1 1 auto; minHeight: 0; overflowY: auto` — THIS is the
 *    element the scrollbar belongs to.
 */
const FRAME_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  flex: '1 1 auto',
  overflow: 'hidden',
  boxSizing: 'border-box',
} as const
const HEADER_STYLE = {
  flex: '0 0 auto',
  padding: '12px 12px 0',
  boxSizing: 'border-box',
} as const
const SCROLL_STYLE = {
  flex: '1 1 auto',
  minHeight: 0,
  overflowY: 'auto',
  overflowX: 'hidden',
  boxSizing: 'border-box',
  padding: '0 12px 12px',
} as const

/**
 * The panel header — the fixed band. Title and subtitle live here, and the page
 * passes its controls (Run / Refresh / hint / note) in as `controls`, so the one
 * control that CHANGES the system stays reachable while the body scrolls.
 * @param t - translator.
 * @param controls - the page's control bar element, or `null` when driven directly.
 * @returns the header children.
 */
export function renderPanelHeader(t: Translator, controls: ReactElement | null): ReactElement[] {
  const children: (ReactElement | null)[] = [
    h('h2', { key: 'title', style: { margin: '0 0 4px', fontSize: '15px' } }, t('title')),
    h('p', { key: 'subtitle', style: { margin: '0 0 10px', fontSize: '12px', color: 'var(--dsh-text-2, #8b949e)' } }, t('subtitle')),
    controls,
  ]
  return children.filter((child): child is ReactElement => child !== null)
}

/**
 * The panel frame: a bounded column whose HEADER is fixed and whose BODY scrolls.
 *
 * Exported so the page's loading state uses the SAME frame as the loaded state —
 * two copies of a scroll fix is one copy that gets forgotten.
 * @param header - the fixed header children.
 * @param body - the scrolling body children.
 * @returns the frame element.
 */
export function renderPanelFrame(header: readonly ReactElement[], body: readonly ReactElement[]): ReactElement {
  return h('div', {
    'data-testid': 'meta-research',
    'data-dsh-observer': 'meta-research',
    style: FRAME_STYLE,
  },
  h('header', {
    key: 'header',
    'data-testid': 'meta-research-header',
    style: HEADER_STYLE,
  }, ...header),
  h('div', {
    key: 'scroll',
    'data-testid': 'meta-research-scroll',
    style: SCROLL_STYLE,
  }, ...body))
}

/**
 * Render the whole observer from a view. PURE: no fetch, no hooks, no state.
 *
 * The checks, coverage and findings sections are mounted ONLY for the `run` state,
 * which is the structural half of rule 1: a never-run panel has no table that could
 * be confused with an empty one.
 * @param view - one complete read.
 * @param t - translator.
 * @param controls - the page's control bar, placed in the fixed header.
 * @returns the panel element.
 */
export function renderResearch(view: ResearchView, t: Translator, controls: ReactElement | null = null): ReactElement {
  const body: ReactElement[] = [readSection(view, t), lastSection(view.last, t)]
  if (view.last.state === 'run') {
    body.push(checksSection(view.last, t), coverageSection(view.last, t), findingsSection(view.last, t))
  }
  return renderPanelFrame(renderPanelHeader(t, controls), body)
}
