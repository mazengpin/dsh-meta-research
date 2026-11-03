# RESEARCH — dsh-meta-research

**State: SOURCE PREVIEW - information-providing only.** This document states what one research round measures, what it does NOT measure, and the next measurement. It is a record, not a route, a schema or a promise.

## 1. The research question

Can a round's artifact be re-derived byte-identically - same corpus, same four live sources, same clock - and if not, which bytes prevent it?

The question is not "is the report true". Truth needs an author. Re-derivability needs only the inputs, and that is the property a reader can test without trusting anyone.

## 2. What is measured

- The four-check census, each check with a numerator and a denominator. Green today: `CHECKS: 17/17 passed`, `MUTATIONS: 5/5 changed the record AND were refused`, observer render `asserts: 45/45 passed` (measured 2026-11-03 against the built bundle).
- The artifact write shape: LF, two-space JSON, exactly one trailing newline, validated before write, written as a temp sibling then renamed onto the artifact.
- Provenance of the run: `ranAt`, plus per source its location, HTTP status and byte count, plus the route census.
- The claim under test: two runs over identical inputs under a fixed clock produce identical bytes, and changing one input changes at least one byte.

## 3. What is NOT MEASURED

- **Byte-identical re-derivation: NOT MEASURED.** It has not been run. `ranAt` is a wall-clock stamp, so two runs cannot agree while it is present: that is a stated property, not a measurement, and this document does not report the re-derivation as measured-positive or as measured-negative.
- **The `embeddings` check: NOT MEASURED.** No residency meter is configured on this deployment, so the check reports NOT MEASURED with its reason and the census has never been observed at 4 of 4. It is never reported as zero drift: an unconfigured meter is an absence of a reading, not a reading of zero.
- **Anything about model output: NOT MEASURED.** The package calls no `model` and reads no weights, so nothing here is evidence about a `decision head` or about retrieval quality.
- **Rows 1-4 of ROADMAP.md: NOT MEASURED as done.** Their commands exit 1 today, and "in progress" is not a measurement of a row.

## 4. Next measurement

1. Make the clock an input: an injectable `now` on the round, defaulting to wall clock, so `ranAt` can be fixed for a pair of runs.
2. Run the round twice into two separate record paths and compare them: `sha256` of each, byte size of each.
3. Record the pair in this section as path, byte size and hash, with the verdict - identical, or the enumerated set of differing keys and the reason each differs.
4. Only then does ROADMAP row 1 become checkable in the sense that matters: a second reader can re-derive the artifact without re-running the program.

Falsifier for this whole document: if two runs under a fixed clock over identical inputs differ in any key other than `ranAt`, the invariant in section 2 is false and this document must be corrected in place rather than defended.
