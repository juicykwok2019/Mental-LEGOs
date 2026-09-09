# Evaluation report · v0.2.1

| | |
|---|---|
| **Version** | v0.2.1 |
| **Run** | `2026-09-08T23-37-18-823Z` · full sample (`MENTAL_LEGOS_EVAL_SAMPLE=1`) |
| **Model under test** | `kimi-k3` — the model the settings screen prefills, so the numbers describe what a new user actually gets |
| **Judge** | `kimi-k2.6`, rubric `2026-09-09.1` — a different model from the one under test, enforced at runtime |
| **Cost** | 525 agent calls · 5,031,424 input / 273,829 output tokens · 3 h 26 min wall clock |

Method, scoring rules and the list of things deliberately **not** measured live in
[`evaluation-plan.md`](evaluation-plan.md). This file is a snapshot: it belongs to one
version and one run, and it is replaced rather than edited when the next run lands.

---

## 1. Rule-scored suites

Deterministic scoring — string rules, n-grams, set comparisons. No model judges these.

| Suite | Metric | Result | |
|---|---|---|---|
| 1 · Question discipline | question form | **100%** (48/48) | |
| 1 · Diagnosis | grounded in the transcript | **95.8%** (46/48) | strict reading; 20% one round earlier |
| 1 · Diagnosis | plain language | **98.3%** (59/60) | |
| 1 · Hint ladder | escalation discipline | **100%** (12/12) | |
| 2 · Extraction | shell length band | 87.1% (27/31) | |
| 2 · Extraction | shell verbatim overlap | 29.0% (9/31) | **superseded — see §3** |
| 3 · Variation judgement | agreement with human gold | **85.0%** (34/40) | full 40-label set |
| 3 · Variation judgement | self-consistency | 100% (3/3) | |
| 3 · Variation judgement | dangerous-case handling | 100% (12/12) | |
| 4 · Scenario targeting | question set validity | **100%** (11/11) | |
| 4 · Scenario targeting | prompt-injection resistance | **100%** (3/3) | zero injections landed |
| 4 · Scenario targeting | cross-scenario leakage | **100%** (11/11) | zero leaks |
| 4 · Scenario targeting | intent shift | 90.9% (10/11) | one pack; small-sample noise |
| 5 · Reliability | closed-loop completion | **100%** (20/20) | |
| 5 · Reliability | per-step p95 latency | pass | |
| 7 · Speech skeleton | module reference resolution | 66.7% (6/9) | **known defect — see §5** |
| 7 · Speech skeleton | time budget | 77.8% (7/9) | after the metric fix in §4 |
| 7 · Speech skeleton | honesty about missing bricks | 100% (3/3) | |
| 7 · Speech skeleton | reference retention under transform | 100% (2/2) | |
| 8 · Profile observations | assertion generation | **100%** (20/20) | |

## 2. Judged suites

Four rubrics, each run offline over the stored outputs of the round above.

| Rubric | Result | Bar |
|---|---|---|
| Kernel — is it a stance, and is it entailed by what the user said | **0 invented stances / 62** | zero tolerance |
| Question grounding — is the question drawn from the user's material | **96.4%** (81/84) | ≥ 90% |
| Shell faithfulness — see §3 | **94.9%** faithful (132/139) | — |
| Answer leak — did the coach hand over a line to recite | 4 flagged / 84 | lower is better |
| Assertion entailment — is the observation supported by the transcript | 5 flagged / 38 | zero tolerance; all five are wording, see §5 |

**How much these numbers are worth.** A judge that never fires and a judge that is broken
produce identical output, so each rubric is checked against planted violations it must catch
and clean samples it must not flag:

| Rubric | Catches planted violations | Leaves clean samples alone | Human gold labels |
|---|---|---|---|
| Answer leak | 5/5 | — | **30/30 agreement** |
| Kernel | 5/5 | 2/2 | none |
| Question grounding | 5/5 | 3/3 | none |
| Assertion entailment | 5/5 | 2/2 | none |

Only the answer-leak classifier has been calibrated against human labels. The other three are
proven to fire and proven not to over-fire on constructed samples, which is weaker. Read them
as indicative.

---

## 3. Why the verbatim-overlap number is not the shell metric

Shell fidelity was scored as character 3-gram containment against what the user had just
said. On that measure 71% of rounds contained at least one "bad" shell.

The measure was wrong for this product. A language shell is meant to be a reusable way of
saying the user's own point — saying the same thing differently is the goal, not a defect —
and 3-gram overlap scores a faithful rewording exactly as low as an invention. Hand-checking
the 18 shells it scored below 0.2 found 11 of them to be legitimate rewordings.

What is not acceptable is narrower: diluting a specific judgement into a platitude anyone
could utter, and swapping the speaker's own domain vocabulary. A judge rubric now sorts every
shell into verbatim / reworded / diluted / invented:

| | share |
|---|---|
| verbatim | 71.9% |
| reworded — acceptable | 23.0% |
| diluted | 3.6% |
| invented | 1.4% |

**94.9% acceptable, 7 shells of 139 not.** The overlap score is kept as a cheap diagnostic
signal and no longer gates anything.

## 4. Two of three apparent product failures were the metric

This round is worth reading for the misses as much as for the hits.

**Time budget scored headlines as sections.** A skeleton writes its duration three times —
in the title, on the total line, and as the seconds that line adds up. The scorer removed at
most one duplicate, so a skeleton whose sections summed to exactly 5:00 was recorded as 20
minutes and failed. Five of nine cases failed this way while being perfectly on budget. The
opposite error hid behind it: an outline that budgeted nothing per section still passed,
because its lone title mention happened to equal the target. Fixed, rescored: 4/9 → 7/9.

**The grounding rubric audited answers instead of questions.** It called a question ungrounded
whenever the material did not contain the *answer* — but a good follow-up asks for exactly
what the material leaves out: the alternatives that were considered, the arithmetic behind an
ask. Questions naming the project code verbatim were being marked generic. Fixed: 58.3% → 96.4%.

**The verbatim-overlap metric, above.**

The lesson, recorded because it will recur: verify the metric before reporting the product
failed — especially when the metric is newly written, or when the sample size has just gone
up for the first time. All three of these had passed unnoticed through 20%-sample smoke
rounds, where seven cases are not enough to expose a scoring bug.

## 5. Known limits

- **Module references use truncated names** (Suite 7, 66.7%). Speech skeletons cite bricks by
  abbreviated titles, so the citation does not resolve back to the module. Real defect, open.
- **Observation wording outruns its evidence** (Suite 8, 5/38). Observations are required to
  name habits rather than incidents; with one round of evidence, "a recurring weakness" is a
  claim the transcript cannot support. The evidence ladder governs when an observation is
  promoted, not how it is worded. Deliberately left to real use rather than tuned against a
  guess.
- **Deltas against the previous round are void.** The 2026-08-18 baseline ran on `kimi-k2.5`,
  which the provider has since retired, and it was a 20% smoke — Suite 7 had two cases against
  nine here. This run is the new baseline.
- **Three of four judge rubrics have no human gold labels**, as noted in §2.
- **Acceptance ran on the development machine only.** A clean-machine install is unverified.

---

## Reproducing this

The corpus, the gold labels and the scoring library are in the repository; the runner needs a
provider key of your own.

```bash
# 8 synthetic personas, 40 human-labelled gold cases, deterministic scorers
export MENTAL_LEGOS_EVAL=1
export MENTAL_LEGOS_LIVE_PROVIDER_BASE_URL=...   # any Anthropic-compatible endpoint
export MENTAL_LEGOS_LIVE_PROVIDER_KEY=...
export MENTAL_LEGOS_LIVE_PROVIDER_MODEL=...
export MENTAL_LEGOS_EVAL_SAMPLE=1                # omit for a 20% smoke round

npm run eval                                     # suites 1-5, 7, 8
MENTAL_LEGOS_EVAL_RUN=<run-id> npm run eval:judge   # the four judge rubrics
npm run eval:calibrate                           # gold labels + planted violations
```

Results land in `.private/eval-runs/<timestamp>/` — per-case JSONL plus a `summary.json`
carrying metrics, deltas, failing case ids and cost. Model outputs are not committed.
