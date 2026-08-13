const candidate = JSON.parse(process.argv[2] ?? '{}');
const required = [
  'semantic_core',
  'logical_skeleton',
  'language_shells',
  'retrieval_cues',
  'scope',
  'provenance',
];

const errors = required
  .filter((key) => candidate[key] == null || candidate[key] === '')
  .map((key) => `missing:${key}`);

if (!Array.isArray(candidate.language_shells) || candidate.language_shells.length === 0) {
  errors.push('language_shells must be a non-empty array');
}

if (String(candidate.semantic_core ?? '').length > 280) {
  errors.push('semantic_core is probably too large for one module');
}

process.stdout.write(JSON.stringify({ valid: errors.length === 0, errors }));
