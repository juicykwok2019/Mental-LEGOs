const payload = JSON.parse(process.argv[2] ?? '{}');
const turns = Array.isArray(payload.turns) ? payload.turns : [];

const normalized = turns.map((turn, index) => ({
  ref: String(turn.ref ?? `turn-${index + 1}`),
  speaker: String(turn.speaker ?? 'unknown'),
  start_ms: Number(turn.start_ms ?? 0),
  end_ms: Number(turn.end_ms ?? turn.start_ms ?? 0),
  text: String(turn.text ?? '').trim(),
})).filter((turn) => turn.text);

normalized.sort((left, right) => left.start_ms - right.start_ms);
process.stdout.write(JSON.stringify({ turns: normalized }));
