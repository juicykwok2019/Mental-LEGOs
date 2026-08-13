const payload = JSON.parse(process.argv[2] ?? '{}');
const text = String(payload.text ?? '').trim();
if (!text) throw new Error('text is required');

const markers = {
  convergence: /(?:focus|scope|收敛|范围|具体来看)/iu,
  judgment: /(?:I (?:think|believe)|my view|我认为|核心是)/iu,
  structure: /(?:first|second|finally|第一|第二|最后)/iu,
  evidence: /(?:for example|because|案例|例如|因为)/iu,
  closure: /(?:therefore|in short|所以|归根结底|总结)/iu,
};

const signals = Object.fromEntries(
  Object.entries(markers).map(([name, pattern]) => [name, pattern.test(text)]),
);

process.stdout.write(JSON.stringify({ signals, note: 'Heuristic signals require transcript review.' }));
