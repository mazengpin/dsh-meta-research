/**
 * Client half of `dsh-meta-research` — the panel a person actually sees.
 *
 * A human must be able to tell, WITHOUT reading a log, whether a research run has
 * ever happened, what each of the four drift checks found (numerator AND
 * denominator), and which findings it produced — and must be able to start a run
 * from the panel. That is this package's whole browser surface: it renders and it
 * drives one control; it never decides anything.
 *
 * THREE registrations, and the pairing is the point:
 *
 *  1. this plugin's dictionary in the shared locale service (en);
 *  2. **one nav row** in `sidebar.panellist`;
 *  3. **one keyed `main` panel** behind that row, because a row whose panel does not
 *     exist renders and then throws on the user's first click.
 *
 * THE TRAP THIS FILE IS WRITTEN AROUND — a property of the SEAM, not of this plugin,
 * and the sibling `dsh-lvl1-gate` records it at length:
 *
 *   **the row's `id` in `sidebar.panellist` must equal the panel's `key` in `main`.**
 *
 * The two slots spell identity differently: `sidebar.panellist` is a LIST and builds
 * rows from `options.id`, while `main` is `kind: 'keyed'` and `ui-layout` matches
 * `entry.options.key`. The shell hands the row's `id` to `selectPanel`, and
 * `layout.selectPanel: main panel "<id>" is not registered` throws when no `main`
 * entry carries that key. Registering `{ id: X }` in BOTH slots looks correct and
 * still throws, so the two constants below are two declarations of one value and
 * `verify/observer-render.mjs` asserts the equality against the BUILT bundle — then
 * drives a recording Client context with a row whose id has been mutated, so the
 * assertion is shown able to fail.
 *
 * THE TEST SEAM IS DELIBERATE. The pure renderer and the normalizer are exported so
 * the built bundle can be DRIVEN without a browser: `verify/observer-render.mjs`
 * calls the SAME functions the page uses, not copies, so "NOT RUN is its own state,
 * not an empty findings table" is asserted about the artifact a user would receive.
 *
 * @module dsh-meta-research/client
 */

import { createElement as h, type ReactElement } from 'react'
import { LOCALE_NS, en } from './locales.ts'
import { ObserverPage } from './ObserverPage.ts'
import { fetchLast, runResearch, toResearchView } from './api.ts'
import { lastLabel, lastTone, renderResearch } from './view.ts'
import type { ClientContext, Translator } from './types.ts'

/** Loader row name; the Client bundle registers itself under this same id. */
export const name = 'dsh-meta-research'

/** The two Client services this half reads. */
export const inject = ['slots', 'locale']

/**
 * The observer's identity, declared once per spelling.
 *
 * {@link PANEL_ROW_ID} is the `sidebar.panellist` row's `id` and
 * {@link PANEL_MAIN_KEY} is the `main` panel's `key`. They hold the same string ON
 * PURPOSE — see the module header — and both are namespaced so they cannot collide
 * with a shipped panel id.
 */
const PANEL_ROW_ID = 'dsh-meta-research:observer'
/** The `main` key the row selects. MUST equal {@link PANEL_ROW_ID}. */
const PANEL_MAIN_KEY = 'dsh-meta-research:observer'

/** Position among the global panel rows, ascending. Sits after the siblings' rows. */
const PANEL_ROW_ORDER = 6.56

/**
 * The row's glyph, drawn inline so the bundle needs no asset fetch.
 * @returns the svg element.
 */
function ResearchRowIcon(): ReactElement {
  return h('svg', {
    width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
  },
  h('circle', { cx: 7, cy: 7, r: 4.2 }),
  h('path', { d: 'M10.2 10.2 14 14' }),
  h('path', { d: 'M4.6 7h1.6M5.4 5.4v3.2M8.2 5.8h1.4M8.2 8h1.8' }))
}

/**
 * Register the dictionary, the nav row and the keyed main panel.
 * @param ctx - the Client plugin context (`slots`, `locale`, `effect`, `logger`).
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, 'en', en as unknown as Record<string, string>), 'dsh-meta-research: en dictionary')

  const t: Translator = ctx.locale.bind(LOCALE_NS)

  // The `main` panel. A ROOT-scope KEYED panel: identity is `key`, and the page
  // receives no session seat. Registered FIRST so the row below can never select a
  // key that does not exist yet.
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_MAIN_KEY,
    locale: LOCALE_NS,
    registrant: 'dsh-meta-research',
    inject: () => ({ t }),
  }, ObserverPage as unknown as (props: Record<string, unknown>) => ReactElement | null))

  // The `sidebar.panellist` row. A LIST row, so the identity is `id` — and it must
  // equal the `main` key above or the click throws.
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ROW_ID,
    order: PANEL_ROW_ORDER,
    label: () => t('row'),
    locale: LOCALE_NS,
    registrant: 'dsh-meta-research',
    inject: () => ({ t }),
  }, ResearchRowIcon))

  ctx.logger.info(
    `dsh-meta-research: observer client active; nav row ${PANEL_ROW_ID}@${PANEL_ROW_ORDER} with keyed main twin ${PANEL_MAIN_KEY}, plus the en dictionary`,
  )
}

/**
 * The declared identity, exported so the render check can compare the two spellings
 * against each other and against what `apply` actually registers.
 */
export const __identity = Object.freeze({ rowId: PANEL_ROW_ID, mainKey: PANEL_MAIN_KEY })

/** The pure renderer, exported so the render check can drive the SAME function. */
export const __renderResearch = renderResearch

/** The state-token rule, exported so it can be driven against the built bundle. */
export const __lastLabel = lastLabel

/** The tone rule, exported for the same reason. */
export const __lastTone = lastTone

/** The normalizer, exported so the check drives real payloads through the real reader. */
export const __viewOf = toResearchView

/** The one-pass read, exported so the panel can be driven against a LIVE route. */
export const __fetchLast = fetchLast

/** The control's POST, exported so its presence is a driven seam rather than a grep. */
export const __runResearch = runResearch
