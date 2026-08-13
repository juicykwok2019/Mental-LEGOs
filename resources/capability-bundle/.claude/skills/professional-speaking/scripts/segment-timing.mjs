const payload = JSON.parse(process.argv[2] ?? '{}');
const segments = Array.isArray(payload.segments) ? payload.segments : [];

const result = segments.map((segment, index) => {
  const start = Number(segment.start_ms ?? 0);
  const end = Number(segment.end_ms ?? start);
  return {
    ref: String(segment.ref ?? `segment-${index + 1}`),
    duration_ms: Math.max(0, end - start),
    text: String(segment.text ?? '').trim(),
  };
});

const total_ms = result.reduce((sum, segment) => sum + segment.duration_ms, 0);
process.stdout.write(JSON.stringify({ total_ms, segments: result }));
