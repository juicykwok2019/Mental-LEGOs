# Language LEGO candidate schema

Required fields:

- `semantic_core`: the judgment or communicative move, independent of wording.
- `logical_skeleton`: an ordered relation such as premise → mechanism → implication.
- `language_shells`: one or more natural phrasings, tagged by tone and duration.
- `retrieval_cues`: question features that should activate the module.
- `slots`: replaceable entities, examples, goals, constraints, or audiences.
- `connectors`: compatible opening, evidence, transition, and closing module types.
- `evidence_refs`: stable references and assertion state.
- `scope`: where the module is safe to reuse and where it is not.
- `provenance`: learner words, learner-confirmed rewrite, or agent proposal.

Reject candidates that are a complete memorized answer, contain several unrelated judgments, hide factual claims in rhetoric, or have no changed-question reuse path.
