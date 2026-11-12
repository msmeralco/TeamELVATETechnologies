import crypto from 'node:crypto';

/** JSON with object keys sorted at every level, so equal data hashes equally. */
export const canonical = (o) => JSON.stringify(o, (_, v) =>
  (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v));

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
