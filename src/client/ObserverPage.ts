/**
 * The stateful observer page: fetch, then delegate every pixel to the pure renderer
 * in `view.ts`.
 *
 * The split exists so the panel can be CHECKED. A component that both fetches and
 * renders can only run under a hook dispatcher, so a build-level check could not
 * drive it without a browser; the pure renderer is driven instead, and this file
 * holds only the two things a pure renderer cannot express — WHEN to fetch and WHAT
 * the operator did.
 *
 * TWO CONTROLS, and they are different in kind:
 *
 *  · **Run** changes the system. It POSTs `/meta-research/api/run` and then
 *    RE-READS `/meta-research/api/last`, so the state the operator sees change is
 *    the one the route recorded, not one this component invented. A control that
 *    only read a value back would not be a control.
 *  · **Refresh** re-reads the same route. It changes nothing and is labelled as a
 *    read, so the two are never confused.
 *
 * @module dsh-meta-research/client/ObserverPage
 */

import { createElement as h, useCallback, useEffect, useState, type ReactElement } from 'react'
import { fetchLast, runResearch } from './api.ts'
import { renderPanelFrame, renderPanelHeader, renderResearch, type ResearchView } from './view.ts'
import type { PageProps } from './types.ts'

/**
 * The meta-research observer panel.
 * @param props - the shell's page properties (the translator only).
 * @returns the panel, or a loading line before the first read lands.
 */
export function ObserverPage(props: PageProps): ReactElement {
  const [view, setView] = useState<ResearchView | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /** Read the route and replace the view. */
  const reload = useCallback(async () => {
    setBusy(true)
    try {
      setView(await fetchLast())
      setNote(null)
    } catch (error) {
      // `fetchLast` never rejects by construction; this branch exists so a future
      // refactor cannot turn a failed read into a blank panel.
      setNote(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  /** Drive the control, then re-read so the change is OBSERVED. */
  const onRun = useCallback(async () => {
    setBusy(true)
    try {
      const outcome = await runResearch()
      setNote(`run → ${outcome}`)
      setView(await fetchLast())
    } catch (error) {
      setNote(`run failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }, [])

  const bar = h('div', {
    key: 'control',
    'data-testid': 'research-control',
    style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginBottom: '6px' },
  },
  h('button', { type: 'button', onClick: () => { void onRun() }, disabled: busy, 'data-testid': 'research-run' }, props.t('runButton')),
  h('button', { type: 'button', onClick: () => { void reload() }, disabled: busy, 'data-testid': 'research-refresh' }, props.t('refreshButton')))

  const chrome = [
    h('p', { key: 'hint', style: { fontSize: '11px', color: 'var(--dsh-text-2, #8b949e)', margin: '0 0 6px' } }, props.t('controlHint')),
    note === null ? null : h('p', { key: 'note', 'data-testid': 'research-note' }, note),
  ]

  // The FIXED band: hint, the Run/Refresh controls and the run note. It is built
  // here because it owns state, and handed to the pure frame so the header cannot
  // scroll away from the button that changes the system.
  const controls = h('div', { key: 'controls', 'data-testid': 'research-controls' },
    chrome[0],
    bar,
    chrome[1])

  if (view === null) {
    return renderPanelFrame(
      renderPanelHeader(props.t, controls),
      [h('p', { key: 'loading' }, props.t('noView'))])
  }

  return renderResearch(view, props.t, controls)
}
