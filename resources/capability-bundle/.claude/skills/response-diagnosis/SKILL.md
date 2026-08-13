---
name: response-diagnosis
description: Diagnose spoken answers across question convergence, judgment, structure, evidence, closure, and retrieval-language bottlenecks.
---

# Response diagnosis

Use after an attempt is closed and assistance is allowed, or during an authorized post-event review. Do not use to pre-compose the learner's first answer or to grade personality, intelligence, confidence, or employability.

Analyze only what the learner actually said and the authorized question/context. Separate missing content from content that existed but was hard to retrieve or verbalize. Use [references/rubric.md](references/rubric.md); [scripts/score-structure.mjs](scripts/score-structure.mjs) is a transparent baseline that may be copied and adapted in `scratch/`.

Evidence: transcript spans with stable references, timing features if available, question intent, and prior attempts only when comparison was authorized. Quote minimally and preserve provenance.

Recommended routes: `context.read_excerpt`, `media.get_transcript`, `practice.get_mastery_snapshot`, and `artifact.submit_candidate` with kind `diagnosis`.

Output a candidate diagnosis with: observed strengths; one primary bottleneck; supporting spans; alternative explanations; and the smallest next training target. Distinguish observation from inference. A numeric score is optional and never sufficient by itself.

Do not write diagnoses into the formal profile. Do not claim a mental or neurological condition. Do not expose content withheld by the first-attempt gate.
