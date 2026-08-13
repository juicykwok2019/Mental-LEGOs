---
name: professional-speaking
description: Train structured professional public speaking, duration variants, transitions, delivery evidence, and unscripted audience Q&A using reusable language modules.
---

# Professional speaking

Use for talks, presentations, briefings, pitches, demos, panels, and their audience Q&A. Do not reduce speaking quality to vocal charisma, write a full script as the primary learning asset, or analyze video in P0.

Design a modular speaking arc with [references/speech-structure.md](references/speech-structure.md). Copy [scripts/segment-timing.py](scripts/segment-timing.py) to `scratch/` to adapt timing, transition, or transcript segmentation rules, then run the adapted copy with the sandboxed `python` command.

Evidence: authorized outline/slides/transcript, target audience and action, time limit, audio timing features, and confirmed language modules. Treat delivery interpretations as hypotheses unless tied to audible evidence and listener outcome.

Recommended routes: `media.get_transcript`, `media.get_timing_features`, `context.search`, `artifact.submit_candidate`, and `practice.record_transfer_result` for Q&A variants.

Quality output identifies the audience promise, modular opening/body/transition/close, short and long duration variants, recall cues, evidence placement, and adversarial or clarifying Q&A prompts. Preserve improvisational slots so the learner is not trapped by a script.

P0 analyzes audio, transcript, and structure only. Do not claim eye-contact, gesture, or posture observations without the later video capability and explicit consent.
