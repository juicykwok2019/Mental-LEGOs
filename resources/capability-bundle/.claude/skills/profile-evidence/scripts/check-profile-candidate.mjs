const candidate = JSON.parse(process.argv[2] ?? '{}');
const states = new Set([
  'confirmed_fact',
  'learner_viewpoint',
  'observation',
  'hypothesis',
  'conflicted',
  'retired',
]);

const errors = [];
if (!states.has(candidate.state)) errors.push('invalid assertion state');
if (!String(candidate.claim ?? '').trim()) errors.push('claim is required');
if (!Array.isArray(candidate.evidence_refs) || candidate.evidence_refs.length === 0) {
  errors.push('at least one evidence reference is required');
}
if (!String(candidate.scope ?? '').trim()) errors.push('scope is required');

process.stdout.write(JSON.stringify({ valid: errors.length === 0, errors }));
