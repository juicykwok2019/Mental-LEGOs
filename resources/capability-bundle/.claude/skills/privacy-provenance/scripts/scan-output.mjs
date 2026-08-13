const payload = JSON.parse(process.argv[2] ?? '{}');
const text = String(payload.text ?? '');

const patterns = [
  { name: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
  { name: 'api-key-like', pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/u },
  { name: 'windows-user-path', pattern: /[A-Za-z]:\\Users\\[^\\\s]+/u },
  { name: 'unix-user-path', pattern: /\/(?:Users|home)\/[^/\s]+/u },
];

const findings = patterns
  .filter(({ pattern }) => pattern.test(text))
  .map(({ name }) => ({ name }));

process.stdout.write(JSON.stringify({ safe: findings.length === 0, findings }));
