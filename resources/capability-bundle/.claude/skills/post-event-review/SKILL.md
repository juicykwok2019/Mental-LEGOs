---
name: post-event-review
description: Review an important professional interaction from authorized recording, transcript, notes, outcomes, and the learner's own recollection.
---

# Post-event review

Use after an interview, negotiation, meeting, discussion, or speaking event. Do not infer another person's private intent, score the learner from audio style alone, or rewrite history to fit a desired narrative.

Align questions, responses, interventions, commitments, and outcomes with [references/review-protocol.md](references/review-protocol.md). Copy [scripts/align-turns.mjs](scripts/align-turns.mjs) to `scratch/` to adapt speaker labels or transcript formats.

Evidence: authorized media/transcript ranges, learner notes, formal scenario objective, observable outcome, and prior preparation artifacts when in scope. Keep “said,” “inferred,” “remembered,” and “outcome” distinct.

Recommended routes: `media.get_transcript`, `media.get_timing_features`, `context.get_scenario_context`, `artifact.submit_candidate`, and `practice.record_real_world_use` after the learner confirms the evidence.

Quality output reconstructs the interaction timeline, identifies effective module use and missed retrieval opportunities, separates content gaps from expression gaps, proposes small module/rehearsal changes, and records unresolved uncertainty.

Do not retain raw media in outputs, promote inferred profile traits, or make formal updates without preview and confirmation.
