const payload = JSON.parse(process.argv[2] ?? '{}');
const moduleId = String(payload.module_id ?? '').trim();
if (!moduleId) throw new Error('module_id is required');

const dimensions = payload.dimensions ?? {
  audience: ['executive', 'peer'],
  objective: ['explain', 'defend'],
  seconds: [30, 60],
};

const matrix = [];
for (const audience of dimensions.audience ?? []) {
  for (const objective of dimensions.objective ?? []) {
    for (const seconds of dimensions.seconds ?? []) {
      matrix.push({ module_id: moduleId, audience, objective, seconds });
    }
  }
}

process.stdout.write(JSON.stringify({ matrix }));
