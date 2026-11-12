const peso = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: 0 });
const peso2 = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP', minimumFractionDigits: 2 });
const num1 = new Intl.NumberFormat('en-PH', { maximumFractionDigits: 1 });

export const php = (n) => (n === null || n === undefined ? '—' : peso.format(n));
export const php2 = (n) => (n === null || n === undefined ? '—' : peso2.format(n));
export const kwh = (n) => (n === null || n === undefined ? '—' : `${num1.format(n)} kWh`);
export const pct = (r, digits = 1) => (r === null || r === undefined ? '—' : `${(r * 100).toFixed(digits)}%`);

const MANILA = { timeZone: 'Asia/Manila' };
export const simTime = (ts) => (ts ? new Date(ts).toLocaleString('en-PH', { ...MANILA, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
export const simDate = (ts) => (ts ? new Date(ts).toLocaleDateString('en-PH', { ...MANILA, month: 'short', day: 'numeric' }) : '—');
export const dayLabel = (iso) => new Date(`${iso}T00:00:00+08:00`).toLocaleDateString('en-PH', { ...MANILA, month: 'short', day: 'numeric' });
export const wallTime = (ms) => new Date(ms).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });

/** Confidence wording for an anomaly score: a signal for review, never a verdict. */
export function scoreLevel(score) {
  if (score >= 0.85) return { cls: 'critical', label: 'High', icon: '◆' };
  if (score >= 0.6) return { cls: 'serious', label: 'Medium', icon: '▲' };
  if (score >= 0.3) return { cls: 'warning', label: 'Watch', icon: '!' };
  return { cls: 'good', label: 'Normal', icon: '✓' };
}

export const TYPE_LABEL = {
  consumption_spike: 'Usage spike',
  consumption_drop: 'Usage drop',
  flatline: 'Meter flatline',
  tamper_signature: 'Tamper signature',
  transformer_balance: 'Transformer energy gap',
};

export const CATEGORY_LABEL = {
  suspected_jumper: 'Suspected illegal connection',
  meter_issue: 'Meter issue',
  safety_hazard: 'Safety hazard',
  other: 'Other concern',
};

export const sourceLabel = (s) => ({ live: 'live', mock: 'simulated', 'mock-fallback': 'simulated (live failed)' }[s] ?? s ?? '—');
