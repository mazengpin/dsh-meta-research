window.__ModuleLoader__.load({
	id: "dsh-meta-research",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/client/locales.ts
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
		const LOCALE_NS = "meta-research";
		/** English dictionary; every key the renderer asks for must be here. */
		const en = {
			row: "Research",
			title: "Meta research",
			subtitle: "Drift findings for the dsh-meta-evolve program, read from the plugin’s own routes — no logs required.",
			readHeading: "Route read",
			readLabel: "read",
			fetchedAtLabel: "read at",
			noteLabel: "note",
			stateLabel: "state",
			lastHeading: "Last research run",
			atLabel: "at",
			checksHeading: "Drift checks",
			checksHint: "each check reports findings of its denominator — a numerator without its denominator is a caption",
			checksEmpty: "the run recorded 0 check(s)",
			unnamedCheck: "UNNAMED CHECK",
			noReason: "no reason given",
			coverageHeading: "Coverage",
			completeLabel: "census",
			checksEvaluatedLabel: "checks evaluated",
			unitsExaminedLabel: "units examined",
			findingsTotalLabel: "findings total",
			checksNotEvaluatedLabel: "checks not evaluated",
			findingsHeading: "Findings",
			kindLabel: "kind",
			idLabel: "id",
			detailLabel: "detail",
			emptyFindings: "0 finding(s) — the run WAS recorded; an empty list here is a reading, not an absence",
			notRunHint: "No run has ever been recorded on this host. This is a different fact from a run that ran and found nothing, so no findings table is shown.",
			noRunFieldHint: "The route answered but carried no “last” field, so this host does not serve the run contract yet.",
			unreadHint: "The last run could not be read at all, so it is NOT MEASURED rather than empty.",
			controlHeading: "Run the research pass",
			controlHint: "Run POSTs /meta-research/api/run and then re-reads /meta-research/api/last. It starts a run; it does not read a value back. The route answers only after the census is written, so the re-read always sees the new record.",
			runButton: "Run",
			refreshButton: "Refresh",
			noView: "Reading the research route…"
		};
		//#endregion
		//#region src/client/api.ts
		/** Placeholder origin for the non-DOM case (specs, SSR): resolution needs a base. */
		const PLACEHOLDER_ORIGIN = "http://dsh.invalid/";
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
		function pageBase() {
			const href = globalThis.location?.href;
			return typeof href === "string" ? href : PLACEHOLDER_ORIGIN;
		}
		/** The two routes this panel uses: the read, and the one control it POSTs. */
		const ROUTES = {
			last: "/meta-research/api/last",
			run: "/meta-research/api/run"
		};
		/** A typed failure from this plugin's route. */
		var ResearchError = class extends Error {
			failure;
			constructor(failure, message) {
				super(message);
				this.failure = failure;
				this.name = "ResearchError";
			}
		};
		/**
		* Resolve one route against the page base, without a query and without a hash.
		* @param path - the route path, e.g. `/meta-research/api/last`.
		* @returns the absolute URL to fetch.
		*/
		function routeUrl(path) {
			const url = new URL(path, pageBase());
			url.search = "";
			url.hash = "";
			return url.toString();
		}
		/** Fetch one JSON payload, throwing a typed failure. */
		async function requestJson(path, init) {
			let response;
			try {
				response = await fetch(routeUrl(path), {
					cache: "no-store",
					...init,
					headers: {
						accept: "application/json",
						...init?.headers ?? {}
					}
				});
			} catch (error) {
				throw new ResearchError("unreachable", error instanceof Error ? error.message : String(error));
			}
			if (response.status === 404) throw new ResearchError("not-mounted", `${path} is not registered on this host`);
			if (response.status === 403) throw new ResearchError("refused", `${path} refused this request`);
			if (!response.ok) {
				const detail = await response.text().catch(() => "");
				throw new ResearchError("rejected", `HTTP ${response.status}${detail === "" ? "" : `: ${detail.slice(0, 300)}`}`);
			}
			try {
				return await response.json();
			} catch (error) {
				throw new ResearchError("malformed", error instanceof Error ? error.message : String(error));
			}
		}
		/** Map a failure onto the read state the view model speaks. */
		function readFailure(error) {
			if (error instanceof ResearchError) return {
				state: error.failure === "rejected" ? "refused" : error.failure,
				note: error.message
			};
			return {
				state: "malformed",
				note: error instanceof Error ? error.message : String(error)
			};
		}
		/** Narrow an unknown to a record. */
		function asRecord(value) {
			return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
		}
		/** Read a string-or-null field without coercing an absent field into a value. */
		function str(value) {
			return typeof value === "string" ? value : null;
		}
		/** Read a number-or-null field; a non-number is `null` (unread), never `0`. */
		function num(value) {
			return typeof value === "number" && Number.isFinite(value) ? value : null;
		}
		/** Read a boolean-or-null field. */
		function bool(value) {
			return typeof value === "boolean" ? value : null;
		}
		/** Read one `{count, of}` pair, or `null` when the pair itself was not sent. */
		function ratioOf(raw) {
			const record = asRecord(raw);
			if (record === null) return null;
			return {
				count: num(record["count"]),
				of: num(record["of"])
			};
		}
		/** A last-run slice that was never read. */
		function unreadLast(note) {
			return {
				state: "unread",
				at: null,
				checks: null,
				findings: null,
				coverage: null,
				note
			};
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
		function toLast(raw) {
			if (raw === null || raw === void 0) return {
				state: "not-run",
				at: null,
				checks: null,
				findings: null,
				coverage: null,
				note: null
			};
			const record = asRecord(raw);
			if (record === null) return {
				state: "contract-missing",
				at: null,
				checks: null,
				findings: null,
				coverage: null,
				note: `"last" is neither null nor an object (it is ${Array.isArray(raw) ? "an array" : typeof raw}); this host does not serve the run contract`
			};
			const censusRaw = asRecord(record["census"]);
			const checksRaw = censusRaw === null ? null : censusRaw["checks"];
			let checks = null;
			if (Array.isArray(checksRaw)) checks = checksRaw.map((entry) => {
				const row = asRecord(entry);
				const findingsField = row?.["findings"];
				const findings = Array.isArray(findingsField) ? findingsField.length : num(findingsField);
				return {
					name: str(row?.["kind"]) ?? str(row?.["name"]) ?? str(row?.["id"]),
					unit: str(row?.["unit"]),
					findings,
					checked: num(row?.["checked"]),
					of: num(row?.["of"]),
					reason: str(row?.["reason"])
				};
			});
			const findingsRaw = record["findings"];
			let findings = null;
			if (Array.isArray(findingsRaw)) findings = findingsRaw.map((entry) => {
				const row = asRecord(entry);
				return {
					kind: str(row?.["kind"]) ?? str(row?.["type"]),
					id: str(row?.["id"]),
					detail: str(row?.["detail"]) ?? str(row?.["message"])
				};
			});
			const totals = censusRaw === null ? null : asRecord(censusRaw["totals"]);
			const coverage = censusRaw === null ? null : {
				complete: bool(censusRaw["complete"]),
				checksEvaluated: ratioOf(censusRaw["checksEvaluated"]),
				unitsExamined: totals === null ? null : ratioOf(totals["unitsExamined"]),
				findings: totals === null ? null : ratioOf(totals["findings"]),
				checksNotEvaluated: totals === null ? null : ratioOf(totals["checksNotEvaluated"])
			};
			const notes = [];
			if (censusRaw === null) notes.push("the run object carries no census object");
			if (checks === null) notes.push("the census carries no checks[] array");
			else if (checks.length !== 4) notes.push(`the census reported ${checks.length} check(s); the program expects 4`);
			if (findings === null) notes.push("the run object carries no findings[] array");
			return {
				state: "run",
				at: str(record["ranAt"]) ?? str(record["at"]),
				checks,
				findings,
				coverage,
				note: notes.length === 0 ? null : notes.join("; ")
			};
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
		function toResearchView(raw) {
			const fetchedAt = (/* @__PURE__ */ new Date()).toISOString();
			const body = asRecord(raw);
			if (body === null) return {
				fetchedAt,
				read: "malformed",
				note: "the /last payload was not a JSON object",
				last: unreadLast("the payload was not a JSON object, so no run record was read")
			};
			if (body["ok"] === false) return {
				fetchedAt,
				read: "refused",
				note: str(body["error"]) ?? "the route refused the read",
				last: unreadLast("the route refused the read, so no run record was read")
			};
			if (!Object.prototype.hasOwnProperty.call(body, "last")) {
				const keys = Object.keys(body);
				return {
					fetchedAt,
					read: "loaded",
					note: null,
					last: {
						state: "contract-missing",
						at: null,
						checks: null,
						findings: null,
						coverage: null,
						note: `the payload has no "last" field (keys: ${keys.length === 0 ? "none" : keys.join(", ")}); this host does not serve the run contract`
					}
				};
			}
			return {
				fetchedAt,
				read: "loaded",
				note: str(body["note"]),
				last: toLast(body["last"])
			};
		}
		/**
		* One read of the last run, never rejecting: a failed read is a STATE of the view.
		* @returns the normalised view.
		*/
		async function fetchLast() {
			try {
				return toResearchView(await requestJson(ROUTES.last));
			} catch (error) {
				const failure = readFailure(error);
				return {
					fetchedAt: null,
					read: failure.state,
					note: failure.note,
					last: unreadLast(failure.note)
				};
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
		async function runResearch() {
			let response;
			try {
				response = await fetch(routeUrl(ROUTES.run), {
					method: "POST",
					cache: "no-store",
					headers: { accept: "application/json" }
				});
			} catch (error) {
				throw new ResearchError("unreachable", error instanceof Error ? error.message : String(error));
			}
			if (response.status === 404) throw new ResearchError("not-mounted", `${ROUTES.run} is not registered on this host`);
			if (!response.ok) {
				const detail = await response.text().catch(() => "");
				throw new ResearchError("rejected", `HTTP ${response.status}${detail === "" ? "" : `: ${detail.slice(0, 300)}`}`);
			}
			return `HTTP ${response.status}`;
		}
		//#endregion
		//#region src/client/view.ts
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
		/** The token an unread value renders. A literal, so it is greppable in the bundle. */
		const NOT_MEASURED = "NOT MEASURED";
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
		function lastLabel(last) {
			if (last.state === "not-run") return "NOT RUN";
			if (last.state === "contract-missing") return "NO RUN FIELD";
			if (last.state === "unread") return NOT_MEASURED;
			return "RUN RECORDED";
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
		function lastTone(last) {
			if (last.state === "contract-missing") return "warn";
			if (last.state !== "run") return "unknown";
			if (last.findings === null) return "unknown";
			if (last.coverage !== null && last.coverage.complete === false) return "warn";
			if (last.coverage === null || last.coverage.complete === null) return last.findings.length === 0 ? "unknown" : "warn";
			return last.findings.length === 0 ? "ok" : "warn";
		}
		/** Format one nullable reading: `null` is NOT MEASURED, never a value. */
		function fmt(value) {
			if (value === null || value === void 0) return NOT_MEASURED;
			return String(value);
		}
		/** Format a numerator/denominator pair. An absent denominator is NOT MEASURED, never 0. */
		function ratioText(count, of) {
			if (count === null) return NOT_MEASURED;
			if (of === null) return `${count} of ${NOT_MEASURED}`;
			return `${count} of ${of}`;
		}
		/** Format a census ratio, or NOT MEASURED when the whole pair was unread. */
		function coverageRatio(ratio) {
			if (ratio === null) return NOT_MEASURED;
			return ratioText(ratio.count, ratio.of);
		}
		/** One label/value line in a section. */
		function line(label, value, testId) {
			return (0, react.createElement)("div", {
				key: `${label}:${testId ?? ""}`,
				style: {
					display: "flex",
					gap: "8px",
					alignItems: "baseline",
					padding: "2px 0"
				},
				...testId === void 0 ? {} : { "data-testid": testId }
			}, (0, react.createElement)("span", { style: {
				minWidth: "132px",
				color: "var(--dsh-text-2, #8b949e)",
				fontSize: "12px"
			} }, label), (0, react.createElement)("span", { style: {
				fontFamily: "ui-monospace, monospace",
				fontSize: "12px",
				overflowWrap: "anywhere"
			} }, value));
		}
		/** A titled section with a stable `data-testid`. */
		function section(testId, title, children) {
			return (0, react.createElement)("section", {
				key: testId,
				"data-testid": testId,
				style: {
					border: "1px solid var(--dsh-border, #30363d)",
					borderRadius: "8px",
					padding: "10px 12px",
					marginBottom: "10px"
				}
			}, (0, react.createElement)("h3", { style: {
				margin: "0 0 6px",
				fontSize: "13px"
			} }, title), ...children.filter((child) => child !== null));
		}
		/** The badge's colours, derived from its tone and nothing else. */
		function badgeStyle(tone) {
			return {
				display: "inline-block",
				padding: "2px 8px",
				borderRadius: "999px",
				fontSize: "11px",
				fontWeight: 600,
				letterSpacing: "0.04em",
				border: "1px solid",
				...tone === "ok" ? {
					color: "#1a7f37",
					borderColor: "#1a7f37",
					background: "rgba(26,127,55,0.10)"
				} : tone === "warn" ? {
					color: "#9a6700",
					borderColor: "#9a6700",
					background: "rgba(154,103,0,0.10)"
				} : {
					color: "var(--dsh-text-2, #8b949e)",
					borderColor: "var(--dsh-border, #30363d)",
					background: "transparent"
				}
			};
		}
		/** The route-read section: did the read itself succeed, and when. */
		function readSection(view, t) {
			const rows = [line(t("readLabel"), view.read, "read-state"), line(t("fetchedAtLabel"), fmt(view.fetchedAt), "read-fetched-at")];
			if (view.note !== null) rows.push(line(t("noteLabel"), view.note, "read-note"));
			return section("read", t("readHeading"), rows);
		}
		/** The last-run section: the state badge and the one hint that tells states apart. */
		function lastSection(last, t) {
			const tone = lastTone(last);
			const badge = (0, react.createElement)("span", {
				"data-testid": "last-state",
				"data-state": last.state,
				"data-tone": tone,
				style: badgeStyle(tone)
			}, lastLabel(last));
			const rows = [(0, react.createElement)("div", {
				key: "badge",
				style: {
					display: "flex",
					gap: "8px",
					alignItems: "center",
					padding: "2px 0"
				}
			}, badge)];
			if (last.state === "not-run") rows.push(line(t("stateLabel"), t("notRunHint"), "last-hint"));
			else if (last.state === "contract-missing") rows.push(line(t("stateLabel"), last.note ?? t("noRunFieldHint"), "last-hint"));
			else if (last.state === "unread") rows.push(line(t("stateLabel"), last.note ?? t("unreadHint"), "last-hint"));
			else {
				rows.push(line(t("atLabel"), fmt(last.at), "last-at"));
				if (last.note !== null) rows.push(line(t("noteLabel"), last.note, "last-note"));
			}
			return section("last", t("lastHeading"), rows);
		}
		/**
		* One drift check's rendered ratio: numerator and denominator, or NOT MEASURED.
		*
		* `check.findings` is an ARRAY in the host contract, so the numerator was taken as
		* its length by the normaliser. `check.of` is the denominator and `check.checked` is
		* the examined count; both are exposed as data attributes so a check can read the
		* numbers the row was built from rather than the text it produced.
		*/
		function checkRow(check, index, t) {
			const name = check.name ?? t("unnamedCheck");
			const measured = check.findings !== null && check.of !== null;
			const value = measured ? `${check.findings} of ${check.of}` : NOT_MEASURED;
			const unit = check.unit === null ? "" : ` ${check.unit}`;
			return (0, react.createElement)("div", {
				key: `check-${index}-${name}`,
				"data-testid": "check-row",
				"data-check": check.name ?? "",
				"data-measured": measured ? "true" : "false",
				style: {
					display: "flex",
					gap: "8px",
					alignItems: "baseline",
					flexWrap: "wrap",
					padding: "2px 0"
				}
			}, (0, react.createElement)("span", { style: {
				minWidth: "210px",
				fontSize: "12px"
			} }, name), (0, react.createElement)("span", {
				style: {
					fontFamily: "ui-monospace, monospace",
					fontSize: "12px"
				},
				...measured ? {
					"data-findings": check.findings,
					"data-of": check.of
				} : {},
				...check.checked === null ? {} : { "data-checked": check.checked }
			}, `${value}${measured ? unit : ""}`), measured ? null : (0, react.createElement)("span", {
				"data-testid": "check-reason",
				style: {
					flex: "1 1 220px",
					fontSize: "11px",
					color: "var(--dsh-text-2, #8b949e)"
				}
			}, check.reason === null ? t("noReason") : check.reason));
		}
		/**
		* The four drift checks, each with findings of its denominator.
		*
		* A check whose `of` is `null` was NOT EVALUATED by the host. It renders NOT
		* MEASURED plus the host's reason, and the row carries `data-measured="false"`, so
		* neither the text nor the structure can read as a clean result.
		*/
		function checksSection(last, t) {
			const checks = last.checks;
			const rows = [(0, react.createElement)("p", {
				key: "hint",
				style: {
					fontSize: "11px",
					color: "var(--dsh-text-2, #8b949e)",
					margin: "0 0 4px"
				}
			}, t("checksHint"))];
			if (checks === null) rows.push(line(t("checksHeading"), NOT_MEASURED, "checks-unread"));
			else if (checks.length === 0) rows.push(line(t("checksHeading"), t("checksEmpty"), "checks-empty"));
			else for (const [index, check] of checks.entries()) rows.push(checkRow(check, index, t));
			return section("checks", t("checksHeading"), rows);
		}
		/**
		* The coverage section: the census's own completeness and totals.
		*
		* Rendered only for a RUN, and every line is a numerator/denominator pair or an
		* explicit NOT MEASURED. `unitsExamined.of` is `null` whenever a check was not
		* evaluated — the host documents that as honest partial coverage, so it renders
		* `count of NOT MEASURED` rather than a zero.
		*/
		function coverageSection(last, t) {
			const coverage = last.coverage;
			if (coverage === null) return section("coverage", t("coverageHeading"), [line(t("coverageHeading"), NOT_MEASURED, "coverage-unread")]);
			const complete = coverage.complete === null ? NOT_MEASURED : coverage.complete ? "COMPLETE" : "INCOMPLETE";
			return section("coverage", t("coverageHeading"), [
				line(t("completeLabel"), complete, "coverage-complete"),
				line(t("checksEvaluatedLabel"), coverageRatio(coverage.checksEvaluated), "coverage-checks"),
				line(t("unitsExaminedLabel"), coverageRatio(coverage.unitsExamined), "coverage-units"),
				line(t("findingsTotalLabel"), coverageRatio(coverage.findings), "coverage-findings"),
				line(t("checksNotEvaluatedLabel"), coverageRatio(coverage.checksNotEvaluated), "coverage-not-evaluated")
			]);
		}
		/** One finding row: kind, id, and a monospace detail column. */
		function findingRow(finding, index) {
			return (0, react.createElement)("div", {
				key: `finding-${index}`,
				"data-testid": "finding",
				"data-kind": finding.kind ?? "",
				"data-id": finding.id ?? "",
				style: {
					display: "flex",
					gap: "8px",
					alignItems: "baseline",
					padding: "2px 0",
					borderTop: "1px solid var(--dsh-border, #30363d)"
				}
			}, (0, react.createElement)("span", { style: {
				minWidth: "110px",
				fontSize: "12px"
			} }, fmt(finding.kind)), (0, react.createElement)("span", { style: {
				minWidth: "96px",
				fontFamily: "ui-monospace, monospace",
				fontSize: "12px"
			} }, fmt(finding.id)), (0, react.createElement)("span", { style: {
				flex: "1 1 240px",
				fontFamily: "ui-monospace, monospace",
				fontSize: "12px",
				overflowWrap: "anywhere"
			} }, fmt(finding.detail)));
		}
		/**
		* The findings list.
		*
		* An EMPTY list renders the `emptyFindings` line and is still a RUN — the token
		* says a run was recorded, which is what keeps it distinguishable from NOT RUN.
		* An unread list renders NOT MEASURED instead.
		*/
		function findingsSection(last, t) {
			const findings = last.findings;
			const rows = [(0, react.createElement)("p", {
				key: "count",
				"data-testid": "findings-count",
				style: {
					fontSize: "12px",
					margin: "0 0 4px"
				}
			}, findings === null ? NOT_MEASURED : `${findings.length} finding(s)`)];
			if (findings === null) rows.push(line(t("findingsHeading"), NOT_MEASURED, "findings-unread"));
			else if (findings.length === 0) rows.push((0, react.createElement)("p", {
				key: "empty",
				"data-testid": "findings-empty",
				style: {
					fontSize: "12px",
					margin: "0"
				}
			}, t("emptyFindings")));
			else {
				rows.push((0, react.createElement)("div", {
					key: "header",
					"data-testid": "findings-header",
					style: {
						display: "flex",
						gap: "8px",
						fontSize: "11px",
						color: "var(--dsh-text-2, #8b949e)",
						borderTop: "1px solid var(--dsh-border, #30363d)",
						paddingTop: "4px"
					}
				}, (0, react.createElement)("span", { style: { minWidth: "110px" } }, t("kindLabel")), (0, react.createElement)("span", { style: { minWidth: "96px" } }, t("idLabel")), (0, react.createElement)("span", { style: { flex: "1 1 240px" } }, t("detailLabel"))));
				for (const [index, finding] of findings.entries()) rows.push(findingRow(finding, index));
			}
			return section("findings", t("findingsHeading"), rows);
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
			display: "flex",
			flexDirection: "column",
			height: "100%",
			minHeight: 0,
			flex: "1 1 auto",
			overflow: "hidden",
			boxSizing: "border-box"
		};
		const HEADER_STYLE = {
			flex: "0 0 auto",
			padding: "12px 12px 0",
			boxSizing: "border-box"
		};
		const SCROLL_STYLE = {
			flex: "1 1 auto",
			minHeight: 0,
			overflowY: "auto",
			overflowX: "hidden",
			boxSizing: "border-box",
			padding: "0 12px 12px"
		};
		/**
		* The panel header — the fixed band. Title and subtitle live here, and the page
		* passes its controls (Run / Refresh / hint / note) in as `controls`, so the one
		* control that CHANGES the system stays reachable while the body scrolls.
		* @param t - translator.
		* @param controls - the page's control bar element, or `null` when driven directly.
		* @returns the header children.
		*/
		function renderPanelHeader(t, controls) {
			return [
				(0, react.createElement)("h2", {
					key: "title",
					style: {
						margin: "0 0 4px",
						fontSize: "15px"
					}
				}, t("title")),
				(0, react.createElement)("p", {
					key: "subtitle",
					style: {
						margin: "0 0 10px",
						fontSize: "12px",
						color: "var(--dsh-text-2, #8b949e)"
					}
				}, t("subtitle")),
				controls
			].filter((child) => child !== null);
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
		function renderPanelFrame(header, body) {
			return (0, react.createElement)("div", {
				"data-testid": "meta-research",
				"data-dsh-observer": "meta-research",
				style: FRAME_STYLE
			}, (0, react.createElement)("header", {
				key: "header",
				"data-testid": "meta-research-header",
				style: HEADER_STYLE
			}, ...header), (0, react.createElement)("div", {
				key: "scroll",
				"data-testid": "meta-research-scroll",
				style: SCROLL_STYLE
			}, ...body));
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
		function renderResearch(view, t, controls = null) {
			const body = [readSection(view, t), lastSection(view.last, t)];
			if (view.last.state === "run") body.push(checksSection(view.last, t), coverageSection(view.last, t), findingsSection(view.last, t));
			return renderPanelFrame(renderPanelHeader(t, controls), body);
		}
		//#endregion
		//#region src/client/ObserverPage.ts
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
		/**
		* The meta-research observer panel.
		* @param props - the shell's page properties (the translator only).
		* @returns the panel, or a loading line before the first read lands.
		*/
		function ObserverPage(props) {
			const [view, setView] = (0, react.useState)(null);
			const [note, setNote] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			/** Read the route and replace the view. */
			const reload = (0, react.useCallback)(async () => {
				setBusy(true);
				try {
					setView(await fetchLast());
					setNote(null);
				} catch (error) {
					setNote(error instanceof Error ? error.message : String(error));
				} finally {
					setBusy(false);
				}
			}, []);
			(0, react.useEffect)(() => {
				reload();
			}, [reload]);
			/** Drive the control, then re-read so the change is OBSERVED. */
			const onRun = (0, react.useCallback)(async () => {
				setBusy(true);
				try {
					const outcome = await runResearch();
					setNote(`run → ${outcome}`);
					setView(await fetchLast());
				} catch (error) {
					setNote(`run failed: ${error instanceof Error ? error.message : String(error)}`);
				} finally {
					setBusy(false);
				}
			}, []);
			const bar = (0, react.createElement)("div", {
				key: "control",
				"data-testid": "research-control",
				style: {
					display: "flex",
					gap: "8px",
					alignItems: "center",
					flexWrap: "wrap",
					marginBottom: "6px"
				}
			}, (0, react.createElement)("button", {
				type: "button",
				onClick: () => {
					onRun();
				},
				disabled: busy,
				"data-testid": "research-run"
			}, props.t("runButton")), (0, react.createElement)("button", {
				type: "button",
				onClick: () => {
					reload();
				},
				disabled: busy,
				"data-testid": "research-refresh"
			}, props.t("refreshButton")));
			const chrome = [(0, react.createElement)("p", {
				key: "hint",
				style: {
					fontSize: "11px",
					color: "var(--dsh-text-2, #8b949e)",
					margin: "0 0 6px"
				}
			}, props.t("controlHint")), note === null ? null : (0, react.createElement)("p", {
				key: "note",
				"data-testid": "research-note"
			}, note)];
			const controls = (0, react.createElement)("div", {
				key: "controls",
				"data-testid": "research-controls"
			}, chrome[0], bar, chrome[1]);
			if (view === null) return renderPanelFrame(renderPanelHeader(props.t, controls), [(0, react.createElement)("p", { key: "loading" }, props.t("noView"))]);
			return renderResearch(view, props.t, controls);
		}
		//#endregion
		//#region src/client/index.ts
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
		/** Loader row name; the Client bundle registers itself under this same id. */
		const name = "dsh-meta-research";
		/** The two Client services this half reads. */
		const inject = ["slots", "locale"];
		/**
		* The observer's identity, declared once per spelling.
		*
		* {@link PANEL_ROW_ID} is the `sidebar.panellist` row's `id` and
		* {@link PANEL_MAIN_KEY} is the `main` panel's `key`. They hold the same string ON
		* PURPOSE — see the module header — and both are namespaced so they cannot collide
		* with a shipped panel id.
		*/
		const PANEL_ROW_ID = "dsh-meta-research:observer";
		/** The `main` key the row selects. MUST equal {@link PANEL_ROW_ID}. */
		const PANEL_MAIN_KEY = "dsh-meta-research:observer";
		/** Position among the global panel rows, ascending. Sits after the siblings' rows. */
		const PANEL_ROW_ORDER = 6.56;
		/**
		* The row's glyph, drawn inline so the bundle needs no asset fetch.
		* @returns the svg element.
		*/
		function ResearchRowIcon() {
			return (0, react.createElement)("svg", {
				width: 16,
				height: 16,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.4,
				strokeLinecap: "round",
				strokeLinejoin: "round"
			}, (0, react.createElement)("circle", {
				cx: 7,
				cy: 7,
				r: 4.2
			}), (0, react.createElement)("path", { d: "M10.2 10.2 14 14" }), (0, react.createElement)("path", { d: "M4.6 7h1.6M5.4 5.4v3.2M8.2 5.8h1.4M8.2 8h1.8" }));
		}
		/**
		* Register the dictionary, the nav row and the keyed main panel.
		* @param ctx - the Client plugin context (`slots`, `locale`, `effect`, `logger`).
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(LOCALE_NS, "en", en), "dsh-meta-research: en dictionary");
			const t = ctx.locale.bind(LOCALE_NS);
			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_MAIN_KEY,
				locale: LOCALE_NS,
				registrant: "dsh-meta-research",
				inject: () => ({ t })
			}, ObserverPage));
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ROW_ID,
				order: PANEL_ROW_ORDER,
				label: () => t("row"),
				locale: LOCALE_NS,
				registrant: "dsh-meta-research",
				inject: () => ({ t })
			}, ResearchRowIcon));
			ctx.logger.info(`dsh-meta-research: observer client active; nav row ${PANEL_ROW_ID}@${PANEL_ROW_ORDER} with keyed main twin ${PANEL_MAIN_KEY}, plus the en dictionary`);
		}
		/**
		* The declared identity, exported so the render check can compare the two spellings
		* against each other and against what `apply` actually registers.
		*/
		const __identity = Object.freeze({
			rowId: PANEL_ROW_ID,
			mainKey: PANEL_MAIN_KEY
		});
		/** The pure renderer, exported so the render check can drive the SAME function. */
		const __renderResearch = renderResearch;
		/** The state-token rule, exported so it can be driven against the built bundle. */
		const __lastLabel = lastLabel;
		/** The tone rule, exported for the same reason. */
		const __lastTone = lastTone;
		/** The normalizer, exported so the check drives real payloads through the real reader. */
		const __viewOf = toResearchView;
		/** The one-pass read, exported so the panel can be driven against a LIVE route. */
		const __fetchLast = fetchLast;
		/** The control's POST, exported so its presence is a driven seam rather than a grep. */
		const __runResearch = runResearch;
		//#endregion
		exports.__fetchLast = __fetchLast;
		exports.__identity = __identity;
		exports.__lastLabel = __lastLabel;
		exports.__lastTone = __lastTone;
		exports.__renderResearch = __renderResearch;
		exports.__runResearch = __runResearch;
		exports.__viewOf = __viewOf;
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
