/**
 * This plugin's Client dictionary (en).
 *
 * English only at this stage, and that is a reading rather than an omission: the
 * build brief asks for locale registration (en), and a half-translated second
 * dictionary is the defect the sibling `dsh-lvl1-gate` guards against by asserting
 * that its two dictionaries carry IDENTICAL key sets. There is no second key set
 * here, so there is nothing that can disagree with itself.
 *
 * THE VERDICT TOKENS ARE DELIBERATELY NOT HERE. `NOT RUN`, `NO RUN FIELD`,
 * `RUN RECORDED` and `NOT MEASURED` are diagnostics rather than prose, so they live
 * as literals in the renderer: a translated diagnostic is one a reviewer cannot
 * grep for, and `verify/observer-render.mjs` asserts those exact strings against the
 * BUILT bundle. A heading is allowed to be translated; a verdict token is not.
 *
 * @module dsh-meta-research/client/locales
 */

/** The namespace every dictionary here is registered under. */
export const LOCALE_NS = 'meta-research'

/** English dictionary; every key the renderer asks for must be here. */
export const en = {
  row: 'Research',
  title: 'Meta research',
  subtitle: 'Drift findings for the dsh-meta-evolve program, read from the plugin’s own routes — no logs required.',
  readHeading: 'Route read',
  readLabel: 'read',
  fetchedAtLabel: 'read at',
  noteLabel: 'note',
  stateLabel: 'state',
  lastHeading: 'Last research run',
  atLabel: 'at',
  checksHeading: 'Drift checks',
  checksHint: 'each check reports findings of its denominator — a numerator without its denominator is a caption',
  checksEmpty: 'the run recorded 0 check(s)',
  unnamedCheck: 'UNNAMED CHECK',
  noReason: 'no reason given',
  coverageHeading: 'Coverage',
  completeLabel: 'census',
  checksEvaluatedLabel: 'checks evaluated',
  unitsExaminedLabel: 'units examined',
  findingsTotalLabel: 'findings total',
  checksNotEvaluatedLabel: 'checks not evaluated',
  findingsHeading: 'Findings',
  kindLabel: 'kind',
  idLabel: 'id',
  detailLabel: 'detail',
  emptyFindings: '0 finding(s) — the run WAS recorded; an empty list here is a reading, not an absence',
  notRunHint: 'No run has ever been recorded on this host. This is a different fact from a run that ran and found nothing, so no findings table is shown.',
  noRunFieldHint: 'The route answered but carried no “last” field, so this host does not serve the run contract yet.',
  unreadHint: 'The last run could not be read at all, so it is NOT MEASURED rather than empty.',
  controlHeading: 'Run the research pass',
  controlHint: 'Run POSTs /meta-research/api/run and then re-reads /meta-research/api/last. It starts a run; it does not read a value back. The route answers only after the census is written, so the re-read always sees the new record.',
  runButton: 'Run',
  refreshButton: 'Refresh',
  noView: 'Reading the research route…',
} as const
