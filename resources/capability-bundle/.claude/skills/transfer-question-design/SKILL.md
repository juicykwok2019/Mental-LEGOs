---
name: transfer-question-design
description: Design changed-question retrieval tests that require the learner to recall, adapt, and recombine existing language modules.
---

# Transfer question design

Use when a candidate or confirmed module needs retrieval practice across new cues. Do not generate cosmetic paraphrases, trivia quizzes, or questions that expose the module's wording before the learner responds.

Vary audience, objective, pressure, abstraction, evidence demand, objection, time limit, and module combination. Use [references/variation-taxonomy.md](references/variation-taxonomy.md). Copy and adapt [scripts/build-transfer-matrix.py](scripts/build-transfer-matrix.py) in `scratch/` when a new scenario requires different dimensions, then run the adapted copy with the sandboxed `python` command.

Evidence: module semantic core, allowed scope, retrieval history, scenario constraints, and mastery snapshot. Never embed answer phrases in the question.

Recommended routes: `context.get_module_with_evidence`, `practice.get_mastery_snapshot`, `artifact.submit_candidate` with kind `question_variant`, and later `practice.record_transfer_result`.

Quality requires that each question changes at least one meaningful retrieval cue and states why it tests transfer rather than repetition. Include expected module IDs for host-side evaluation but keep them hidden from the learner before the attempt.

Do not alter mastery directly or generate a reference answer before the first attempt closes.
