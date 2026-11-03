import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
//#region src/host/types.ts
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
const FINDING_KINDS = [
	"scope-missing-path",
	"intent-plan-document-missing",
	"authorised-clone-not-linked",
	"intent-map-stale"
];
/** The fixed order the census emits the four checks in. */
const CHECK_ORDER = FINDING_KINDS;
//#endregion
//#region src/host/census.ts
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
/** The directory name a decision uses when it scopes a clone. */
const CLONES_DIRNAME = "plugins-src";
function isObject$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString$1(value) {
	return typeof value === "string" && value.length > 0;
}
/** Build a slot: transport readability AND the shape the consuming check needs. */
function slotOf(reading, shapeProblem) {
	if (!reading.readable) return {
		reading,
		usable: false,
		reason: reading.reason ?? `${reading.name} is unreadable (no reason recorded)`,
		value: null
	};
	const problem = shapeProblem(reading.value);
	if (problem !== null) return {
		reading,
		usable: false,
		reason: problem,
		value: null
	};
	return {
		reading,
		usable: true,
		reason: null,
		value: reading.value
	};
}
/** The summary the census publishes for a source, at the usability level. */
function summaryOf(slot) {
	return {
		name: slot.reading.name,
		location: slot.reading.location,
		readable: slot.usable,
		status: slot.reading.status,
		bytes: slot.reading.bytes,
		reason: slot.reason
	};
}
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
function pathState(raw, roots) {
	const candidates = [];
	if (raw === "~") candidates.push(homedir());
	else if (raw.startsWith("~/")) candidates.push(join(homedir(), raw.slice(2)));
	else if (isAbsolute(raw)) candidates.push(raw);
	else for (const root of roots) candidates.push(resolve(root, raw));
	let unreadableReason = null;
	for (const candidate of candidates) try {
		statSync(candidate);
		return {
			state: "exists",
			abs: candidate
		};
	} catch (error) {
		const code = error.code;
		if (code === "ENOENT" || code === "ENOTDIR") continue;
		unreadableReason ??= `${candidate}: ${error instanceof Error ? `${error.name}${code === void 0 ? "" : ` ${code}`}` : String(error)}`;
	}
	return unreadableReason === null ? { state: "missing" } : {
		state: "unreadable",
		reason: unreadableReason
	};
}
/** Narrow the decision-log payload; `null` means the log itself was unusable. */
function readDecisions(value) {
	if (!isObject$1(value) || !Array.isArray(value.decisions)) return null;
	const records = [];
	let malformed = 0;
	for (const row of value.decisions) {
		if (!isObject$1(row) || !isNonEmptyString$1(row.id) || !isNonEmptyString$1(row.status) || !Array.isArray(row.scope)) {
			malformed++;
			continue;
		}
		records.push({
			id: row.id,
			status: row.status,
			scope: row.scope
		});
	}
	return {
		records,
		malformed
	};
}
function buildScopeCheck(decisions, roots) {
	const population = decisions.records.filter((decision) => decision.status === "active" && decision.scope.length > 0);
	const findings = [];
	let scopeEntriesTotal = 0;
	let scopeEntriesExamined = 0;
	let missingPaths = 0;
	let globPatternsSkipped = 0;
	let unreadablePaths = 0;
	let checked = 0;
	const unreadableExamples = [];
	for (const decision of population) {
		const missing = [];
		let decisionUnreadable = false;
		for (const entry of decision.scope) {
			scopeEntriesTotal++;
			if (typeof entry !== "string") {
				unreadablePaths++;
				decisionUnreadable = true;
				unreadableExamples.push(`${decision.id}: non-string scope entry`);
				continue;
			}
			if (/[*?]/.test(entry)) {
				globPatternsSkipped++;
				continue;
			}
			const state = pathState(entry, roots);
			if (state.state === "unreadable") {
				unreadablePaths++;
				decisionUnreadable = true;
				if (unreadableExamples.length < 3) unreadableExamples.push(`${decision.id}: ${state.reason}`);
				continue;
			}
			scopeEntriesExamined++;
			if (state.state === "missing") missing.push(entry);
		}
		if (!decisionUnreadable) checked++;
		missingPaths += missing.length;
		if (missing.length > 0) findings.push({
			kind: "scope-missing-path",
			id: decision.id,
			detail: `active decision scopes ${String(missing.length)} path(s) that exist nowhere the census looked (workspace, project root, profile root): ${missing.join(", ")}`
		});
	}
	const reason = unreadablePaths === 0 ? decisions.malformed === 0 ? null : `${String(decisions.malformed)} decision row(s) could not be classified (missing id/status/scope), so this denominator is a floor` : `${String(unreadablePaths)} scope entr(y/ies) could not be read: ${unreadableExamples.join("; ")}`;
	return {
		kind: "scope-missing-path",
		unit: "active decision carrying a non-empty scope (one unit per decision; its paths are all probed)",
		of: population.length,
		checked,
		findings,
		reason,
		scopeEntriesTotal,
		scopeEntriesExamined,
		missingPaths,
		globPatternsSkipped,
		unreadablePaths
	};
}
function readPlanRows(value) {
	if (!isObject$1(value) || !Array.isArray(value.documents)) return null;
	const rows = [];
	for (const document of value.documents) {
		if (!isObject$1(document) || !isNonEmptyString$1(document.doc) || !Array.isArray(document.rows)) return null;
		const documentRows = document.rows;
		const documentPath = document.doc;
		for (const [index, row] of documentRows.entries()) {
			if (!isObject$1(row)) return null;
			if (String(row.value).toLowerCase() !== "plan") continue;
			const id = isNonEmptyString$1(row.id) ? row.id : `${documentPath}#row-${String(index)}`;
			const sources = [documentPath];
			const evidence = isObject$1(row.evidence) ? row.evidence : null;
			const pointers = evidence !== null && Array.isArray(evidence.pointers) ? evidence.pointers : [];
			for (const pointer of pointers) if (isObject$1(pointer) && isNonEmptyString$1(pointer.ref) && !sources.includes(pointer.ref)) sources.push(pointer.ref);
			rows.push({
				id,
				document: documentPath,
				sources
			});
		}
	}
	return rows;
}
function buildIntentPlanCheck(slot, roots) {
	const rows = slot.usable ? readPlanRows(slot.value) : null;
	if (rows === null) return {
		kind: "intent-plan-document-missing",
		unit: "intent row with value \"plan\" in plan/intent-field/field.json",
		of: null,
		checked: null,
		findings: [],
		reason: slot.usable ? "plan/intent-field/field.json does not have the expected shape (documents[] with a rows[] per document)" : slot.reason,
		sourceDocumentsExamined: null,
		sourceDocumentsMissing: null,
		sourceDocumentsUnreadable: null
	};
	const findings = [];
	let sourceDocumentsExamined = 0;
	let sourceDocumentsMissing = 0;
	let sourceDocumentsUnreadable = 0;
	let checked = 0;
	for (const row of rows) {
		const missing = [];
		let unreadable = false;
		for (const source of row.sources) {
			const state = pathState(source, roots);
			if (state.state === "exists") sourceDocumentsExamined++;
			else if (state.state === "missing") {
				sourceDocumentsExamined++;
				sourceDocumentsMissing++;
				missing.push(source);
			} else {
				sourceDocumentsUnreadable++;
				unreadable = true;
			}
		}
		if (!unreadable) checked++;
		if (missing.length > 0) findings.push({
			kind: "intent-plan-document-missing",
			id: row.id,
			detail: `intent row says the stage is "plan" but its source document(s) do not exist on disk: ${missing.join(", ")} (row declared in ${row.document})`
		});
	}
	return {
		kind: "intent-plan-document-missing",
		unit: "intent row whose value is \"plan\" in plan/intent-field/field.json",
		of: rows.length,
		checked,
		findings,
		reason: sourceDocumentsUnreadable === 0 ? null : `${String(sourceDocumentsUnreadable)} source document(s) could not be read, so that row was not checked`,
		sourceDocumentsExamined,
		sourceDocumentsMissing,
		sourceDocumentsUnreadable
	};
}
function readPackageName(dir) {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		return isObject$1(parsed) && isNonEmptyString$1(parsed.name) ? parsed.name : null;
	} catch {
		return null;
	}
}
function scanCloneRoots(roots) {
	const clones = /* @__PURE__ */ new Map();
	const unreadableRoots = [];
	for (const root of roots) {
		let entries;
		try {
			entries = readdirSync(root, { withFileTypes: true });
		} catch (error) {
			const code = error.code;
			if (code !== "ENOENT" && code !== "ENOTDIR") unreadableRoots.push(`${root} (${code ?? "unreadable"})`);
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const dir = join(root, entry.name);
			const existing = clones.get(entry.name) ?? {
				dirs: [],
				packageNames: [],
				packageUnreadable: false
			};
			existing.dirs.push(dir);
			const packageName = readPackageName(dir);
			if (packageName === null) existing.packageUnreadable = true;
			else existing.packageNames.push(packageName);
			clones.set(entry.name, existing);
		}
	}
	return {
		clones,
		unreadableRoots
	};
}
function normalise(path) {
	return resolve(path).replaceAll("\\", "/").toLowerCase();
}
function readManifestFacts(value, manifestPath) {
	if (!isObject$1(value) || !isObject$1(value.dsh) || !isObject$1(value.dsh.profile)) return null;
	const profile = value.dsh.profile;
	if (!Array.isArray(profile.bundles) || profile.bundles.some((bundle) => typeof bundle !== "string")) return null;
	if (!isObject$1(value.dependencies)) return null;
	const profileDir = dirname(manifestPath);
	const bundles = new Set(profile.bundles);
	const linkTargets = /* @__PURE__ */ new Set();
	const linkTargetNames = /* @__PURE__ */ new Set();
	for (const target of Object.values(value.dependencies)) {
		if (typeof target !== "string" || !target.startsWith("link:")) continue;
		const resolved = resolve(profileDir, target.slice(5));
		linkTargets.add(normalise(resolved));
		linkTargetNames.add(basename(resolved));
	}
	return {
		bundles,
		linkTargets,
		linkTargetNames
	};
}
function buildCloneCheck(decisions, manifestSlot, manifestPath, workspaceDir) {
	const manifest = manifestSlot.usable ? readManifestFacts(manifestSlot.value, manifestPath) : null;
	if (manifest === null) return {
		kind: "authorised-clone-not-linked",
		unit: "active decision naming plugins-src/<name>",
		of: null,
		checked: null,
		findings: [],
		reason: manifestSlot.usable ? `${manifestPath} does not have the expected shape (dsh.profile.bundles[] and dependencies)` : manifestSlot.reason,
		cloneNamesExamined: null,
		clonesOnDisk: null,
		unlinkedClones: null,
		unreadableClones: null
	};
	const scopedNames = /* @__PURE__ */ new Map();
	const scopedDecisions = /* @__PURE__ */ new Set();
	for (const decision of decisions.records) {
		if (decision.status !== "active") continue;
		for (const entry of decision.scope) {
			if (typeof entry !== "string") continue;
			const match = /^plugins-src\/([^/]+?)\/?$/.exec(entry);
			if (match === null || match[1] === void 0) continue;
			scopedDecisions.add(decision.id);
			const ids = scopedNames.get(match[1]) ?? [];
			ids.push(decision.id);
			scopedNames.set(match[1], ids);
		}
	}
	const projectRoot = resolve(workspaceDir, "../../..");
	const { clones, unreadableRoots } = scanCloneRoots([join(workspaceDir, CLONES_DIRNAME), join(projectRoot, CLONES_DIRNAME)]);
	const findings = [];
	const inconclusive = /* @__PURE__ */ new Set();
	let cloneNamesExamined = 0;
	let unlinkedClones = 0;
	let unreadableClones = 0;
	const unlinkedByDecision = /* @__PURE__ */ new Map();
	for (const [name, decisionIds] of scopedNames) {
		const clone = clones.get(name);
		if (clone === void 0) continue;
		cloneNamesExamined++;
		const linkedByBundle = manifest.bundles.has(name) || clone.packageNames.some((packageName) => manifest.bundles.has(packageName));
		const linkedByLink = manifest.linkTargetNames.has(name) || clone.dirs.some((dir) => manifest.linkTargets.has(normalise(dir)));
		const linked = linkedByBundle || linkedByLink;
		if (!linked && clone.packageUnreadable) {
			unreadableClones++;
			for (const decisionId of decisionIds) inconclusive.add(decisionId);
			continue;
		}
		if (linked) continue;
		unlinkedClones++;
		const detail = `active decision scopes ${CLONES_DIRNAME}/${name}, which exists on disk at ${clone.dirs.join(" and ")} but is neither in dsh.profile.bundles (${manifestPath}) nor reachable through any link: dependency`;
		for (const decisionId of decisionIds) {
			const list = unlinkedByDecision.get(decisionId) ?? [];
			list.push(detail);
			unlinkedByDecision.set(decisionId, list);
		}
	}
	for (const [decisionId, details] of unlinkedByDecision) findings.push({
		kind: "authorised-clone-not-linked",
		id: decisionId,
		detail: details.join(" | ")
	});
	const reasons = [];
	if (inconclusive.size > 0) reasons.push(`${String(unreadableClones)} clone(s) had an unreadable package.json and ${String(inconclusive.size)} decision(s) could not be decided`);
	if (unreadableRoots.length > 0) reasons.push(`clone root(s) unreadable: ${unreadableRoots.join(", ")}`);
	if (decisions.malformed > 0) reasons.push(`${String(decisions.malformed)} malformed decision row(s) excluded`);
	return {
		kind: "authorised-clone-not-linked",
		unit: "active decision naming a plugins-src/<name> clone (one unit per decision)",
		of: scopedDecisions.size,
		checked: scopedDecisions.size - inconclusive.size,
		findings,
		reason: reasons.length === 0 ? null : reasons.join("; "),
		cloneNamesExamined,
		clonesOnDisk: clones.size,
		unlinkedClones,
		unreadableClones
	};
}
function readIndexModel(value) {
	if (!isObject$1(value) || !isObject$1(value.index) || !isObject$1(value.index.identity)) return null;
	const model = value.index.identity.model;
	return isNonEmptyString$1(model) ? model : null;
}
function readResidentModels(value) {
	if (!isObject$1(value) || !Array.isArray(value.models)) return null;
	const names = [];
	for (const model of value.models) if (isObject$1(model) && isNonEmptyString$1(model.name)) names.push(model.name);
	return names;
}
function buildIntentMapCheck(intentMapSlot, psSlot) {
	const indexModel = intentMapSlot.usable ? readIndexModel(intentMapSlot.value) : null;
	const staleReason = (reason) => ({
		kind: "intent-map-stale",
		unit: "model-name comparison: intent-map index.identity.model vs the running embedder",
		of: null,
		checked: null,
		findings: [],
		reason,
		indexModel,
		residentModels: psSlot.usable ? readResidentModels(psSlot.value) : null
	});
	if (!intentMapSlot.usable) return staleReason(intentMapSlot.reason ?? "intent map is unreadable");
	if (indexModel === null) return staleReason("intent-map/api/map carries no index.identity.model to compare");
	if (!psSlot.usable) return staleReason(`${psSlot.reason ?? "embedder residency is unreadable"}; an unreadable embedder is not zero drift`);
	const residentModels = readResidentModels(psSlot.value);
	if (residentModels === null) return staleReason(`${psSlot.reading.location} carries no models[] array; an absent reading is not a clean one`);
	if (residentModels.length === 0) return staleReason(`${psSlot.reading.location} reports no resident model, so the index model cannot be compared — ollama evicts an unpinned model after an idle window (observed; no decision records it), which makes this an incomparable moment rather than drift`);
	const findings = [];
	if (!residentModels.includes(indexModel)) findings.push({
		kind: "intent-map-stale",
		id: indexModel,
		detail: `intent-map index was built with model "${indexModel}" but the running embedder reports resident model(s): ${residentModels.join(", ")}`
	});
	return {
		kind: "intent-map-stale",
		unit: "model-name comparison: intent-map index.identity.model vs the running embedder",
		of: 1,
		checked: 1,
		findings,
		reason: null,
		indexModel,
		residentModels
	};
}
/** Build the complete census from already-read sources. */
function buildCensus(inputs) {
	const workspaceDir = inputs.workspaceDir;
	const profileDir = dirname(inputs.profileManifestPath);
	const roots = [
		workspaceDir,
		resolve(workspaceDir, "../../.."),
		profileDir
	];
	const decisionsSlot = slotOf(inputs.decisions, (value) => isObject$1(value) && Array.isArray(value.decisions) ? null : `${inputs.decisions.location} carries no decisions[] array`);
	const intentMapSlot = slotOf(inputs.intentMap, (value) => isObject$1(value) ? null : `${inputs.intentMap.location} did not return a JSON object`);
	const intentFieldSlot = slotOf(inputs.intentField, (value) => isObject$1(value) && Array.isArray(value.documents) ? null : `${inputs.intentField.location} carries no documents[] array`);
	const manifestSlot = slotOf(inputs.profileManifest, (value) => {
		if (!isObject$1(value) || !isObject$1(value.dsh) || !isObject$1(value.dsh.profile)) return `${inputs.profileManifest.location} does not look like a profile manifest (dsh.profile missing)`;
		const profile = value.dsh.profile;
		if (!Array.isArray(profile.bundles)) return `${inputs.profileManifest.location} does not look like a profile manifest (dsh.profile.bundles missing)`;
		if (!isObject$1(value.dependencies)) return `${inputs.profileManifest.location} carries no dependencies object, so link: dependencies cannot be checked`;
		return null;
	});
	const psSlot = slotOf(inputs.embedderPs, (value) => isObject$1(value) && Array.isArray(value.models) ? null : `${inputs.embedderPs.location} carries no models[] array`);
	const decisionRead = decisionsSlot.usable ? readDecisions(decisionsSlot.value) : null;
	const checks = [
		decisionRead === null ? {
			kind: "scope-missing-path",
			unit: "active decision carrying a non-empty scope (one unit per decision; its paths are all probed)",
			of: null,
			checked: null,
			findings: [],
			reason: decisionsSlot.reason ?? "the decision log is unreadable",
			scopeEntriesTotal: null,
			scopeEntriesExamined: null,
			missingPaths: null,
			globPatternsSkipped: null,
			unreadablePaths: null
		} : buildScopeCheck(decisionRead, roots),
		buildIntentPlanCheck(intentFieldSlot, roots),
		decisionRead === null ? {
			kind: "authorised-clone-not-linked",
			unit: "active decision naming plugins-src/<name>",
			of: null,
			checked: null,
			findings: [],
			reason: decisionsSlot.reason ?? "the decision log is unreadable",
			cloneNamesExamined: null,
			clonesOnDisk: null,
			unlinkedClones: null,
			unreadableClones: null
		} : buildCloneCheck(decisionRead, manifestSlot, inputs.profileManifestPath, workspaceDir),
		buildIntentMapCheck(intentMapSlot, psSlot)
	];
	const findings = checks.flatMap((check) => check.findings);
	const unitsExamined = checks.reduce((sum, check) => sum + (check.of ?? 0), 0);
	const evaluated = checks.filter((check) => check.of !== null).length;
	const complete = evaluated === CHECK_ORDER.length;
	const byKind = Object.fromEntries(FINDING_KINDS.map((kind) => {
		return [kind, {
			count: findings.filter((finding) => finding.kind === kind).length,
			of: findings.length
		}];
	}));
	return {
		censusAt: inputs.censusAt,
		complete,
		checksEvaluated: {
			count: evaluated,
			of: CHECK_ORDER.length
		},
		sources: [
			decisionsSlot,
			intentMapSlot,
			intentFieldSlot,
			manifestSlot,
			psSlot
		].map(summaryOf),
		checks,
		totals: {
			unitsExamined: {
				count: unitsExamined,
				of: complete ? unitsExamined : null
			},
			findings: {
				count: findings.length,
				of: unitsExamined
			},
			byKind,
			checksNotEvaluated: {
				count: CHECK_ORDER.length - evaluated,
				of: CHECK_ORDER.length
			}
		}
	};
}
//#endregion
//#region src/host/validate.ts
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
function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
	return typeof value === "string" && value.length > 0;
}
function isIsoDate(value) {
	return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
function isNullableCount(value) {
	return value === null || typeof value === "number" && Number.isInteger(value) && value >= 0;
}
/** Compare two findings by the three fields that make them findings. */
function sameFinding(a, b) {
	return a.kind === b.kind && a.id === b.id && a.detail === b.detail;
}
function validateFinding(value, path, expectedKind, problems) {
	if (!isObject(value)) {
		problems.push({
			path,
			problem: "finding is not an object"
		});
		return null;
	}
	if (value.kind !== expectedKind) problems.push({
		path: `${path}.kind`,
		problem: `expected ${expectedKind}, got ${String(value.kind)}`
	});
	if (!isNonEmptyString(value.id)) problems.push({
		path: `${path}.id`,
		problem: "id must be a non-empty string"
	});
	if (!isNonEmptyString(value.detail)) problems.push({
		path: `${path}.detail`,
		problem: "detail must be a non-empty string"
	});
	return {
		kind: value.kind,
		id: isNonEmptyString(value.id) ? value.id : "",
		detail: isNonEmptyString(value.detail) ? value.detail : ""
	};
}
/** Validate one check object against the kind the census defines for that slot. */
function validateCheck(value, path, kind, problems) {
	if (!isObject(value)) {
		problems.push({
			path,
			problem: "check is not an object"
		});
		return null;
	}
	if (value.kind !== kind) problems.push({
		path: `${path}.kind`,
		problem: `expected ${kind}, got ${String(value.kind)}`
	});
	if (!isNonEmptyString(value.unit)) problems.push({
		path: `${path}.unit`,
		problem: "unit must state what one unit of the denominator is"
	});
	const of = value.of;
	const checked = value.checked;
	if (!isNullableCount(of)) {
		problems.push({
			path: `${path}.of`,
			problem: "of must be a non-negative integer or null"
		});
		return null;
	}
	if (of === null) {
		if (!isNonEmptyString(value.reason)) problems.push({
			path: `${path}.reason`,
			problem: "an unevaluated check (of: null) must state a non-empty reason"
		});
		if (!Array.isArray(value.findings) || value.findings.length > 0) problems.push({
			path: `${path}.findings`,
			problem: "an unevaluated check (of: null) must carry an empty findings array"
		});
		if (checked !== null) problems.push({
			path: `${path}.checked`,
			problem: "checked must be null when of is null"
		});
		return null;
	}
	if (checked === null || !isNullableCount(checked) || typeof checked !== "number") {
		problems.push({
			path: `${path}.checked`,
			problem: "checked must be a non-negative integer when of is a number"
		});
		return of;
	}
	if (checked > of) problems.push({
		path: `${path}.checked`,
		problem: `checked (${checked}) exceeds of (${of})`
	});
	if (!Array.isArray(value.findings)) {
		problems.push({
			path: `${path}.findings`,
			problem: "findings must be an array"
		});
		return of;
	}
	if (value.findings.length > checked) problems.push({
		path: `${path}.findings`,
		problem: `findings (${value.findings.length}) exceed checked (${checked})`
	});
	for (const key of [
		"scopeEntriesTotal",
		"scopeEntriesExamined",
		"missingPaths",
		"globPatternsSkipped",
		"unreadablePaths",
		"sourceDocumentsExamined",
		"sourceDocumentsMissing",
		"sourceDocumentsUnreadable",
		"cloneNamesExamined",
		"clonesOnDisk",
		"unlinkedClones",
		"unreadableClones"
	]) if (key in value && !isNullableCount(value[key])) problems.push({
		path: `${path}.${key}`,
		problem: `${key} must be a non-negative integer or null`
	});
	if ("indexModel" in value && value.indexModel !== null && typeof value.indexModel !== "string") problems.push({
		path: `${path}.indexModel`,
		problem: "indexModel must be a string or null"
	});
	if ("residentModels" in value && value.residentModels !== null) {
		const models = value.residentModels;
		if (!Array.isArray(models) || models.some((model) => typeof model !== "string")) problems.push({
			path: `${path}.residentModels`,
			problem: "residentModels must be an array of strings or null"
		});
	}
	return of;
}
/**
* Validate a candidate run record.
*
* @param value - the object about to be written and served.
* @returns every problem found; an empty array means the record may be written.
*/
function validateRunRecord(value) {
	const problems = [];
	if (!isObject(value)) return [{
		path: "$",
		problem: "run record is not an object"
	}];
	const topKeys = Object.keys(value).sort();
	const expectedTopKeys = [
		"census",
		"findings",
		"ranAt"
	];
	if (topKeys.join(",") !== expectedTopKeys.join(",")) problems.push({
		path: "$",
		problem: `top-level keys must be exactly ${expectedTopKeys.join(", ")}; got ${topKeys.join(", ")}`
	});
	if (!isIsoDate(value.ranAt)) problems.push({
		path: "ranAt",
		problem: "ranAt must be an ISO-8601 date string"
	});
	if (!isObject(value.census)) return problems.concat({
		path: "census",
		problem: "census is not an object"
	});
	const census = value.census;
	if (!isIsoDate(census.censusAt)) problems.push({
		path: "census.censusAt",
		problem: "censusAt must be an ISO-8601 date string"
	});
	if (!Array.isArray(census.sources) || census.sources.length === 0) problems.push({
		path: "census.sources",
		problem: "sources must be a non-empty array"
	});
	else {
		const names = /* @__PURE__ */ new Set();
		census.sources.forEach((source, index) => {
			const path = `census.sources[${index}]`;
			if (!isObject(source)) {
				problems.push({
					path,
					problem: "source is not an object"
				});
				return;
			}
			if (!isNonEmptyString(source.name)) problems.push({
				path: `${path}.name`,
				problem: "name must be a non-empty string"
			});
			else if (names.has(source.name)) problems.push({
				path: `${path}.name`,
				problem: `duplicate source name ${source.name}`
			});
			else names.add(source.name);
			if (!isNonEmptyString(source.location)) problems.push({
				path: `${path}.location`,
				problem: "location must be a non-empty string"
			});
			if (typeof source.readable !== "boolean") problems.push({
				path: `${path}.readable`,
				problem: "readable must be a boolean"
			});
			if (!(source.status === null || typeof source.status === "number")) problems.push({
				path: `${path}.status`,
				problem: "status must be a number or null"
			});
			if (!isNullableCount(source.bytes)) problems.push({
				path: `${path}.bytes`,
				problem: "bytes must be a non-negative integer or null"
			});
			if (source.readable === false && !isNonEmptyString(source.reason)) problems.push({
				path: `${path}.reason`,
				problem: "an unreadable source must state a non-empty reason"
			});
		});
	}
	if (!Array.isArray(census.checks) || census.checks.length !== CHECK_ORDER.length) problems.push({
		path: "census.checks",
		problem: `checks must be an array of exactly ${String(CHECK_ORDER.length)} rows (one per finding kind); got ${Array.isArray(census.checks) ? String(census.checks.length) : typeof census.checks}`
	});
	const denominators = [];
	const checksFindings = [];
	if (Array.isArray(census.checks)) census.checks.forEach((check, index) => {
		const kind = CHECK_ORDER[index];
		if (kind === void 0) {
			problems.push({
				path: `census.checks[${index}]`,
				problem: "unexpected extra check"
			});
			return;
		}
		const of = validateCheck(check, `census.checks[${index}]`, kind, problems);
		denominators.push(of === null ? 0 : of);
		if (isObject(check) && Array.isArray(check.findings)) check.findings.forEach((finding, findingIndex) => {
			const validated = validateFinding(finding, `census.checks[${index}].findings[${findingIndex}]`, kind, problems);
			if (validated !== null) checksFindings.push(validated);
		});
	});
	if (!Array.isArray(value.findings)) problems.push({
		path: "findings",
		problem: "findings must be an array"
	});
	else if (value.findings.length !== checksFindings.length) problems.push({
		path: "findings",
		problem: `top-level findings (${String(value.findings.length)}) do not match the per-check flattening (${String(checksFindings.length)})`
	});
	else value.findings.forEach((finding, index) => {
		const expected = checksFindings[index];
		if (!isObject(finding)) {
			problems.push({
				path: `findings[${index}]`,
				problem: "finding is not an object"
			});
			return;
		}
		if (expected !== void 0 && !sameFinding(finding, expected)) problems.push({
			path: `findings[${index}]`,
			problem: "finding disagrees with the same row in its check"
		});
	});
	const checksEvaluated = Array.isArray(census.checks) ? census.checks.filter((check) => isObject(check) && check.of !== null).length : 0;
	const unitsExamined = denominators.reduce((sum, denominator) => sum + denominator, 0);
	const findingsCount = checksFindings.length;
	const notEvaluated = CHECK_ORDER.length - checksEvaluated;
	const complete = notEvaluated === 0;
	if (census.complete !== complete) problems.push({
		path: "census.complete",
		problem: `complete must be ${String(complete)} given ${String(checksEvaluated)} evaluated checks`
	});
	if (!isObject(census.totals)) {
		problems.push({
			path: "census.totals",
			problem: "totals is not an object"
		});
		return problems;
	}
	const totals = census.totals;
	const expectRatio = (path, ratio, count, of) => {
		if (!isObject(ratio)) {
			problems.push({
				path,
				problem: "ratio is not an object"
			});
			return;
		}
		if (ratio.count !== count) problems.push({
			path: `${path}.count`,
			problem: `expected ${String(count)}, got ${String(ratio.count)}`
		});
		if (ratio.of !== of) problems.push({
			path: `${path}.of`,
			problem: `expected ${String(of)}, got ${String(ratio.of)}`
		});
	};
	expectRatio("census.totals.findings", totals.findings, findingsCount, unitsExamined);
	expectRatio("census.totals.unitsExamined", totals.unitsExamined, unitsExamined, complete ? unitsExamined : null);
	expectRatio("census.totals.checksEvaluated", census.checksEvaluated, checksEvaluated, CHECK_ORDER.length);
	expectRatio("census.totals.checksNotEvaluated", totals.checksNotEvaluated, notEvaluated, CHECK_ORDER.length);
	if (!isObject(totals.byKind)) problems.push({
		path: "census.totals.byKind",
		problem: "byKind is not an object"
	});
	else for (const kind of CHECK_ORDER) {
		const ratio = totals.byKind[kind];
		const actual = checksFindings.filter((finding) => finding.kind === kind).length;
		expectRatio(`census.totals.byKind.${kind}`, ratio, actual, findingsCount);
	}
	return problems;
}
//#endregion
//#region src/host/record.ts
/**
* The run record: one artifact, one in-process pointer.
*
* The artifact is `research/meta-research-last.json` and it is the DURABLE
* evidence: a process restart clears the in-process pointer and does not clear
* the file, which is exactly why `GET /last` says "in this process" — it reports
* what this process has recorded, and the file is what survives.
*
* **THE WRITE IS VALIDATED BEFORE IT HAPPENS.** `validateRunRecord` either
* returns an empty problem list or throws here; the route then answers 500
* rather than serving a record it refused to persist. A record that cannot be
* written is not a run.
*
* The text is `JSON.stringify(run, null, 2)` plus exactly one `\n`, written with
* `writeFileSync` — Node does not translate `\n` on Windows, so the file is LF
* and ends with one trailing newline, which is this program's writing rule and
* is asserted by the verify harness rather than assumed.
*
* @module dsh-meta-research/host/record
*/
/** In-process pointer. `null` means NOT RUN in this process — not "ran, found nothing". */
let lastRun = null;
/** The last run recorded by this process, or null when none has been. */
function getLastRun() {
	return lastRun;
}
/** Record the last run in memory, after it has been persisted. */
function setLastRun(run) {
	lastRun = run;
}
/**
* Validate then persist a run record.
*
* @throws when the record is malformed (nothing is written) or the write fails.
*/
function writeRunRecord(recordPath, run) {
	const problems = validateRunRecord(run);
	if (problems.length > 0) {
		const shown = problems.slice(0, 5).map((problem) => `${problem.path}: ${problem.problem}`);
		const more = problems.length > shown.length ? ` (+${String(problems.length - shown.length)} more)` : "";
		throw new Error(`refusing to record a malformed run: ${shown.join("; ")}${more}`);
	}
	const text = `${JSON.stringify(run, null, 2)}\n`;
	mkdirSync(dirname(recordPath), { recursive: true });
	writeTextWithRetry(recordPath, text);
	return {
		path: recordPath,
		bytes: Buffer.byteLength(text, "utf8")
	};
}
/** Windows raises `UNKNOWN`/`EPERM`/`EBUSY` while another process holds the artifact. */
const TRANSIENT_WRITE_CODES = /* @__PURE__ */ new Set([
	"EPERM",
	"EBUSY",
	"EACCES",
	"UNKNOWN"
]);
/** Sleep synchronously, so a retry does not turn a route into a scheduler. */
function wait(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/**
* Write one file ATOMICALLY: a temp sibling then a rename, retried on the four
* transient Windows codes. A half-written artifact read by a second process is
* worse than a failed run, and a first run that fails because a reader held the
* file is a manual step the caller did not ask for.
*/
function writeTextWithRetry(path, text, attempts = 5) {
	const temp = `${path}.tmp-write`;
	let lastError = null;
	for (let attempt = 1; attempt <= attempts; attempt += 1) try {
		writeFileSync(temp, text, "utf8");
		renameSync(temp, path);
		return;
	} catch (error) {
		lastError = error;
		const code = error.code ?? "";
		if (!TRANSIENT_WRITE_CODES.has(code) || attempt === attempts) break;
		try {
			unlinkSync(temp);
		} catch {}
		wait(attempt * 25);
	}
	throw lastError;
}
//#endregion
//#region src/host/sources.ts
/**
* Source readers for the drift census.
*
* Every read returns a `SourceReading` whose `readable` flag is TRUE ONLY WHEN
* THE TRANSPORT SUCCEEDED AND THE PAYLOAD HAS THE SHAPE THE CHECK NEEDS. The
* distinction matters twice over in this program: a request that returns `404`
* on both sides has compared two non-answers, and a payload that parses but
* carries no `decisions` array is an unanswered request wearing a success code.
* Both are reported here as unreadable WITH A REASON, which is what lets each
* check report `of: null` instead of a confident zero.
*
* Nothing here writes. Nothing here spawns a process. Nothing here opens a
* device or asks a model to infer anything: the embedder read is RESIDENCY
* METADATA (`/api/ps` shaped), not an inference route, and the census never calls
* `/api/embed`, `/v1/embeddings`, `/api/generate` or `/api/chat`. An UNCONFIGURED
* meter is not fetched at all — see `readEmbedderResidency`.
*
* @module dsh-meta-research/host/sources
*/
/**
* Per-request budget. A hung source must degrade to `of: null`, not hang the route.
*
* RAISED 8_000 -> 60_000 on 2026-10-18, and the reason is that the OLD VALUE WAS
* SHORTER THAN TWO OF ITS OWN SUBJECTS' READ TIMES, so the fail-soft path fired
* on HEALTHY sources and the census reported a permanent `of: null` for checks it
* could have computed. Measured on the live host (POST /meta-research/api/run,
* 23:02:02Z, 8.2 s wall) — `checksEvaluated {count:1, of:4}` with `complete:false`,
* and the two unreadable sources carried these exact reasons:
*   decision-log: "http://127.0.0.1:3083/decision-log/api/list returned HTTP 200
*                  but its body could not be read: TimeoutError: The operation was
*                  aborted due to timeout"   <- the status ARRIVED; the BODY timed out
*   intent-map:   "http://127.0.0.1:3083/intent-map/api/map timed out after 8000 ms"
* Both endpoints answer 200 when probed directly and unbounded (decision-log/list
* 1,131,219 B, intent-map/map 47,632 B), so the transport was healthy and only the
* DEADLINE was wrong. The distinguishing signal is the first reason's shape: a 200
* with an unreadable body is NOT a 404 and must never be read as "absent".
*
* 60_000 is a bound, not an unbounded wait, so the fail-soft property the comment
* above states is preserved: a genuinely hung source still degrades to `of: null`,
* it just takes long enough to stop firing on a 1.1 MB live append-only log that
* only grows. Raising this cannot make a BROKEN source readable; it can only stop
* reporting a WORKING one as broken.
*/
const HTTP_TIMEOUT_MS = 6e4;
/** Reasons are persisted in the artifact, so keep them short enough to be read. */
const MAX_REASON_CHARS = 400;
function clip(text) {
	return text.length <= MAX_REASON_CHARS ? text : `${text.slice(0, MAX_REASON_CHARS)}…`;
}
/** Render an unknown thrown value as a reason a human can act on. */
function errorText$1(error) {
	if (error instanceof Error) {
		const cause = error.cause;
		if (cause !== null && typeof cause === "object") {
			const code = cause.code;
			if (typeof code === "string") return `${error.name}: ${code}`;
		}
		return `${error.name}: ${error.message}`;
	}
	return String(error);
}
/**
* Read the embedder's residency metadata, or STATE THAT NO METER IS CONFIGURED.
*
* An empty URL is not a fetch of `''` and it is not a silence: it is a source
* that cannot be read for a reason the operator can act on. The reason says why
* no llama.cpp default exists, so the next reader does not "fix" this by
* pointing it at a route that answers with a blob path and manufactures drift.
*/
function readEmbedderResidency(url) {
	if (url.trim() === "") return Promise.resolve({
		name: "embedder-ps",
		location: "config:embedderPsUrl",
		readable: false,
		value: null,
		status: null,
		bytes: null,
		reason: clip("no embedder residency meter is configured, so check (d) cannot compare the index model with a running one — ollama's /api/ps on :11434 answers 000 (ollama is stopped) and llama.cpp publishes the loaded blob path rather than a model name, so this meter is REQUIRED: set the plugin's `embedderPsUrl` (or a non-empty embedder origin) at a service that publishes a `models[]` of model NAMES")
	});
	return readHttpJson("embedder-ps", url);
}
/** Read a JSON document over HTTP, with status and body size recorded. */
async function readHttpJson(name, url) {
	let response;
	try {
		response = await fetch(url, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
		});
	} catch (error) {
		return {
			name,
			location: url,
			readable: false,
			value: null,
			status: null,
			bytes: null,
			reason: clip(error instanceof Error && error.name === "TimeoutError" ? `${url} timed out after ${HTTP_TIMEOUT_MS} ms` : `${url} unreadable: ${errorText$1(error)}`)
		};
	}
	let text;
	try {
		text = await response.text();
	} catch (error) {
		return {
			name,
			location: url,
			readable: false,
			value: null,
			status: response.status,
			bytes: null,
			reason: clip(`${url} returned HTTP ${response.status} but its body could not be read: ${errorText$1(error)}`)
		};
	}
	const bytes = Buffer.byteLength(text, "utf8");
	if (!response.ok) return {
		name,
		location: url,
		readable: false,
		value: null,
		status: response.status,
		bytes,
		reason: clip(`HTTP ${response.status} from ${url}`)
	};
	try {
		return {
			name,
			location: url,
			readable: true,
			value: JSON.parse(text),
			status: response.status,
			bytes,
			reason: null
		};
	} catch (error) {
		return {
			name,
			location: url,
			readable: false,
			value: null,
			status: response.status,
			bytes,
			reason: clip(`${url} returned HTTP ${response.status} but the body is not JSON: ${errorText$1(error)}`)
		};
	}
}
/**
* Read a JSON document from disk.
*
* `readable` says the BYTES were read and parsed. Whether the document has the
* shape a check needs is decided by that check and reported as its own reason —
* a file that is present but carries no `documents` array is not a clean zero.
*/
function readDiskJson(name, location) {
	let text;
	try {
		text = readFileSync(location, "utf8");
	} catch (error) {
		return {
			name,
			location,
			readable: false,
			value: null,
			status: null,
			bytes: null,
			reason: clip(`${location} unreadable: ${errorText$1(error)}`)
		};
	}
	const bytes = Buffer.byteLength(text, "utf8");
	try {
		return {
			name,
			location,
			readable: true,
			value: JSON.parse(text),
			status: null,
			bytes,
			reason: null
		};
	} catch (error) {
		return {
			name,
			location,
			readable: false,
			value: null,
			status: null,
			bytes,
			reason: clip(`${location} is not JSON: ${errorText$1(error)}`)
		};
	}
}
//#endregion
//#region src/host/routes.ts
/** The route prefix this plugin owns. */
const PREFIX = "/meta-research/api";
/** The last-run route. */
const LAST_PATH = `${PREFIX}/last`;
/** The census-run route. */
const RUN_PATH = `${PREFIX}/run`;
/** The artifact path, relative to the program workspace. */
const ARTIFACT_RELATIVE_PATH = "research/meta-research-last.json";
/** Origin used only when a request carries no `Host` and no origin override is configured. */
const DEFAULT_ORIGIN$1 = "http://127.0.0.1:3083";
/** Path of the decision-log list route, relative to the origin. */
const DECISION_LOG_PATH = "/decision-log/api/list";
/** Path of the intent map route, relative to the origin. */
const INTENT_MAP_PATH = "/intent-map/api/map";
const PLUGIN_NAME = "meta-research";
/** Write one JSON body with direct response ownership. */
function sendJson(res, status, body) {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(text)
	});
	res.end(text);
}
function errorText(error) {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
/**
* The origin the census should read: an explicitly configured URL wins; then the
* `Host` this request arrived on, because a harness may listen on any port and a
* hard-coded port is a wrong reading on every other deployment; then the fallback.
*/
function originOf(req) {
	const host = req.headers.host;
	return typeof host === "string" && host.length > 0 ? `http://${host}` : DEFAULT_ORIGIN$1;
}
/** A configured URL when present, else a path resolved against the request origin. */
function sourceUrl(configured, origin, path) {
	return configured.length > 0 ? configured : `${origin}${path}`;
}
/** `GET /last`: the last run of this process, or an explicit NOT RUN. */
function lastHandler(req, res) {
	if (req.method !== "GET") {
		res.setHeader("Allow", "GET");
		sendJson(res, 405, {
			ok: false,
			error: "method-not-allowed",
			allow: "GET"
		});
		return;
	}
	const last = getLastRun();
	sendJson(res, 200, last === null ? {
		ok: true,
		last: null,
		note: "no run recorded in this process"
	} : {
		ok: true,
		last,
		note: `last run recorded at ${last.ranAt}`
	});
}
/**
* Serialise runs: two overlapping POSTs queue rather than interleave their
* writes to one artifact. The queue is a promise chain, so a failed run does not
* wedge the next one.
*/
let queue = Promise.resolve();
function serialise(task) {
	const next = queue.then(task, task);
	queue = next.then(() => void 0, () => void 0);
	return next;
}
/** Read every source, compute the census, persist it, return the record. */
async function computeAndRecord(options, origin) {
	const censusAt = (/* @__PURE__ */ new Date()).toISOString();
	const [decisions, intentMap, embedderPs] = await Promise.all([
		readHttpJson("decision-log", sourceUrl(options.decisionLogUrl, origin, DECISION_LOG_PATH)),
		readHttpJson("intent-map", sourceUrl(options.intentMapUrl, origin, INTENT_MAP_PATH)),
		readEmbedderResidency(options.embedderPsUrl)
	]);
	const intentField = readDiskJson("intent-field", join(options.workspaceDir, "plan/intent-field/field.json"));
	const profileManifest = readDiskJson("profile-manifest", options.profileManifestPath);
	const census = buildCensus({
		censusAt,
		workspaceDir: options.workspaceDir,
		profileManifestPath: options.profileManifestPath,
		decisions,
		intentMap,
		intentField,
		profileManifest,
		embedderPs
	});
	const run = {
		ranAt: censusAt,
		census,
		findings: census.checks.flatMap((check) => check.findings)
	};
	writeRunRecord(options.recordPath, run);
	return run;
}
/** `POST /run`: compute and record; answer only after the artifact is written. */
function runHandler(options) {
	return async (req, res) => {
		if (req.method !== "POST") {
			res.setHeader("Allow", "POST");
			sendJson(res, 405, {
				ok: false,
				error: "method-not-allowed",
				allow: "POST"
			});
			return;
		}
		try {
			const run = await serialise(() => computeAndRecord(options, originOf(req)));
			setLastRun(run);
			sendJson(res, 200, {
				ok: true,
				run
			});
		} catch (error) {
			sendJson(res, 500, {
				ok: false,
				error: "run-failed",
				message: errorText(error)
			});
		}
	};
}
/** Mount both routes, each through `ctx.effect` so unload removes it. */
function mountRoutes(ctx, options) {
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: LAST_PATH,
		handler: lastHandler
	}), `${PLUGIN_NAME}:last`);
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: RUN_PATH,
		handler: runHandler(options)
	}), `${PLUGIN_NAME}:run`);
}
//#endregion
//#region src/host/workspace.ts
/**
* Where the records live: workspace and profile-manifest discovery.
*
* The plugin must run on a machine that is NOT this one. A compiled-in
* `C:\Users\...` literal is not a default, it is a defect: on another host it
* makes the first run write its artifact into a directory tree that does not
* exist (or worse, silently creates one) and makes every check read the wrong
* files. So the workspace is DISCOVERED, in a stated order, and the order is
* part of the contract:
*
* 1. `DSH_META_RESEARCH_WORKSPACE`, when set — an explicit answer always wins.
* 2. A program workspace seen from the current directory: the nearest ancestor
*    that carries `AGENTS.md`, `plan/` and `research/`.
* 3. A program workspace beside the harness: for each ancestor, a
*    `<ancestor>/profiles-tree/<tier>/<name>` directory with the same three
*    markers. This is how a clone under `plugins-src/` finds the workspace the
*    program actually keeps its records in.
* 4. The current directory, unchanged and unrescued — a wrong answer that is
*    REPORTED by the checks rather than a fabricated one.
*
* Step 3 is the one that makes an install with no manual steps work: it needs no
* configuration, and it is a SEARCH, not a guess, because the markers are the
* thing being searched for.
*
* @module dsh-meta-research/host/workspace
*/
/** This module's own directory, used as a second search seed. */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
/** True when `dir` is a program workspace: the three markers this census reads. */
function isProgramWorkspace(dir) {
	try {
		return statSync(dir).isDirectory() && existsSync(join(dir, "AGENTS.md")) && existsSync(join(dir, "plan")) && existsSync(join(dir, "research"));
	} catch {
		return false;
	}
}
/** `dir` and every ancestor of it, nearest first. */
function ancestors(dir) {
	const out = [];
	let current = resolve(dir);
	for (;;) {
		out.push(current);
		const parent = dirname(current);
		if (parent === current) return out;
		current = parent;
	}
}
/** Directory names under `dir`, sorted, or `[]` when it is unreadable. */
function listDir(dir) {
	try {
		return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
	} catch {
		return [];
	}
}
/** The first program workspace under `<ancestor>/profiles-tree/<tier>/<name>`, or null. */
function scanProfilesTree(ancestor) {
	const root = join(ancestor, "profiles-tree");
	for (const tier of listDir(root)) for (const name of listDir(join(root, tier))) {
		const candidate = join(root, tier, name);
		if (isProgramWorkspace(candidate)) return candidate;
	}
	return null;
}
/**
* Discover the program workspace.
*
* @param start - the seed directory; defaults to the process working directory.
* @returns an absolute path. Never empty, never invented: the last resort is the seed.
*/
function discoverWorkspace(start) {
	const fromEnv = process.env.DSH_META_RESEARCH_WORKSPACE;
	if (typeof fromEnv === "string" && fromEnv.length > 0) return resolve(fromEnv);
	const seed = resolve(start ?? process.cwd());
	for (const searchSeed of [seed, MODULE_DIR]) for (const dir of ancestors(searchSeed)) {
		if (isProgramWorkspace(dir)) return dir;
		const found = scanProfilesTree(dir);
		if (found !== null) return found;
	}
	return seed;
}
/**
* The profile manifest this census reads, discovered rather than compiled in.
*
* Order: `DSH_PROFILE_MANIFEST`; the first ancestor of the workspace's PARENT
* that carries a `package.json` (a program workspace that lives inside a profile
* gets that profile's manifest); otherwise the parent's `package.json` path, so
* the check reports it unreadable rather than reading some unrelated file.
*/
function findProfileManifest(workspaceDir) {
	const fromEnv = process.env.DSH_PROFILE_MANIFEST;
	if (typeof fromEnv === "string" && fromEnv.length > 0) return resolve(fromEnv);
	const parent = dirname(resolve(workspaceDir));
	for (const dir of ancestors(parent)) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) return manifest;
	}
	return join(parent, "package.json");
}
//#endregion
//#region src/index.ts
/**
* dsh-meta-research — the research half of the meta layer.
*
* The meta layer folds RESEARCH onto the current architecture. This half answers
* one question WITH EVIDENCE: **where has the program drifted from its own
* record?** It is a READER plus a recorder: it reads the decision log and the
* intent map over HTTP, and `plan/intent-field/field.json` and the profile
* manifest from disk; it computes a four-check drift census; it writes exactly
* one artifact, `research/meta-research-last.json`. It does not edit the plan,
* the log, the map, or the profile.
*
* **TWO ROUTES, BOTH STATED ONCE.**
*
* - `GET  /meta-research/api/last` — the last run of this process, or
*   `{"ok":true,"last":null,"note":"no run recorded in this process"}`.
* - `POST /meta-research/api/run`  — compute the census, record it, return it.
*
* The paths live in `host/routes.ts` and are re-exported here; no second copy is
* hand-written, because an advertised path that the dispatcher does not serve is
* the `D-0071` failure.
*
* **NO DEVICE AND NO MODEL.** Nothing here opens a GPU device, spawns a process,
* or asks a model to produce anything. The only network reads are the two local
* plugin routes and the embedder's `/api/ps` RESIDENCY METADATA; inference is
* `llama.cpp`'s business and its controlling scripts', not this plugin's.
*
* @module dsh-meta-research
*/
/** Plugin name used by loader diagnostics. */
const name = "meta-research";
/** The host service this plugin requires before `apply` runs. */
const inject = ["webServer"];
/**
* The program workspace, which is the canonical root every record path in the
* census resolves against. Overridable by config or by
* `DSH_META_RESEARCH_WORKSPACE`; otherwise it is DISCOVERED at load time
* (`host/workspace.ts`) so that an install with no manual steps finds the
* records without a path compiled into the bundle.
*/
const DEFAULT_WORKSPACE = discoverWorkspace();
/** Origin of the two local plugin routes the census reads. */
const DEFAULT_ORIGIN = "http://127.0.0.1:3083";
/**
* Origin of the embedder whose residency metadata check (d) compares.
*
* **EMPTY ON PURPOSE: THIS METER HAS NO LIVE DEFAULT ON THIS DEPLOYMENT.** It
* named `http://127.0.0.1:11434`, ollama's `/api/ps`. Ollama is stopped here
* (`:11434` answers `000`), so check (d) reported `of:null` with
* "unreadable: TypeError: ECONNREFUSED" on EVERY run — measured live at
* 2026-10-26T14:44:21Z, `POST /meta-research/api/run` → `complete:false`,
* `checksEvaluated {count:3, of:4}` — and the census could never reach 4 of 4.
*
* Re-pointing it at the live llama.cpp embedder would be a MISREADING rather
* than a fix. `GET :8012/v1/models` is the only residency route llama.cpp
* serves, and it publishes the loaded BLOB PATH
* (`C:\\Users\\0000\\.ollama\\models\\blobs\\sha256-0650…`): `models[].name`,
* `models[].model`, `data[].id` and `data[].aliases[]` are all that one path
* (measured 2026-10-26T14:43:17Z, 1,065 B, `meta.n_embd` 1024, `owned_by`
* "llamacpp"). Comparing a blob path with the index's `qwen3-embedding:0.6b`
* would MANUFACTURE a drift finding out of a naming difference. The other
* candidate — asking `POST /v1/embeddings` which model it is — is an inference
* call this plugin's charter forbids, and its answer echoes the REQUESTED id
* rather than reporting a served one.
*
* So the meter is REQUIRED: config `embedderPsUrl` (or this origin, when a
* deployment has a real meter) must name a service publishing a `models[]` of
* model NAMES. Empty is loud — check (d) reports NOT MEASURED with a reason that
* says the meter is unconfigured — where `:11434` was a value that looked
* configured, was read as a transport fault, and could never work.
*/
const DEFAULT_EMBEDDER_ORIGIN = "";
/** The artifact path, relative to the program workspace. */
const ARTIFACT_RELATIVE_PATH_VALUE = "research/meta-research-last.json";
function stringOption(raw, key, fallback) {
	const value = raw[key];
	return typeof value === "string" && value.length > 0 ? value : fallback;
}
function resolveOptions(raw) {
	const workspaceDir = stringOption(raw, "workspaceDir", process.env.DSH_META_RESEARCH_WORKSPACE ?? DEFAULT_WORKSPACE);
	return {
		workspaceDir,
		recordPath: stringOption(raw, "recordPath", process.env.DSH_META_RESEARCH_RECORD ?? join(workspaceDir, ARTIFACT_RELATIVE_PATH_VALUE)),
		decisionLogUrl: stringOption(raw, "decisionLogUrl", process.env.DSH_META_RESEARCH_DECISION_LOG_URL ?? ""),
		intentMapUrl: stringOption(raw, "intentMapUrl", process.env.DSH_META_RESEARCH_INTENT_MAP_URL ?? ""),
		embedderPsUrl: stringOption(raw, "embedderPsUrl", ""),
		profileManifestPath: stringOption(raw, "profileManifestPath", findProfileManifest(workspaceDir))
	};
}
/**
* Mount the two routes.
*
* `apply` is explicitly NOT async: Cordis treats a prototype-bearing ordinary
* function as a constructor, whose returned Promise is not startup work
* (`mcp-client/src/index.ts:150-153` records the same trap). Route registration
* is synchronous; the run route does its I/O when it is called.
*
* @param ctx - plugin context carrying the web server.
* @param rawConfig - the row's config, before defaults.
*/
function apply(ctx, rawConfig = {}) {
	const options = resolveOptions(rawConfig);
	ctx.logger.info(`[${name}] mounting 2 advertised routes: GET ${LAST_PATH}, POST ${RUN_PATH}; record -> ${options.recordPath}`);
	mountRoutes(ctx, options);
}
//#endregion
export { ARTIFACT_RELATIVE_PATH, CHECK_ORDER, DEFAULT_EMBEDDER_ORIGIN, DEFAULT_ORIGIN, DEFAULT_WORKSPACE, FINDING_KINDS, LAST_PATH, PREFIX, RUN_PATH, apply, discoverWorkspace, findProfileManifest, inject, isProgramWorkspace, name, validateRunRecord };
