const payload = JSON.parse(process.argv[2] ?? '{}');
const claims = Array.isArray(payload.claims) ? payload.claims : [];

const normalized = claims.map((claim, index) => ({
  claim_id: String(claim.claim_id ?? `claim-${index + 1}`),
  text: String(claim.text ?? '').trim(),
  source_refs: Array.isArray(claim.source_refs) ? claim.source_refs.map(String) : [],
  status: ['supported', 'disputed', 'inferred', 'unknown'].includes(claim.status)
    ? claim.status
    : 'unknown',
  as_of: claim.as_of == null ? null : String(claim.as_of),
}));

process.stdout.write(JSON.stringify({ claims: normalized }));
