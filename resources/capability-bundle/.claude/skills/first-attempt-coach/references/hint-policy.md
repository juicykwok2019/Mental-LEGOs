# First-attempt prompt policy

The host state, not the agent's judgment, controls disclosure.

| State | Allowed | Not allowed |
|---|---|---|
| `QUESTION_CREATED` | Ask the learner to begin; normalize a short pause | Any content, structure, example, or personal evidence hint |
| `FIRST_ATTEMPT_RECORDING` | Encourage continuation; ask which part is blocked | Completing a sentence or naming the likely answer |
| `FIRST_ATTEMPT_CLOSED` | Acknowledge completion; ask permission to analyze | Analysis or answer content before the host enables assistance |
| `ASSISTANCE_ALLOWED` | Process, structure, evidence, and language help | Unattributed claims or formal writes without confirmation |

If the learner is blank, record the blank attempt and ask for one meta-observation such as “I know the case but cannot choose an angle.” That observation is valuable retrieval evidence; do not rescue it with answer content.

Escalate assistance gradually after the gate opens: process cue → generic structure cue → evidence category → candidate module. Stop as soon as the learner can continue.
