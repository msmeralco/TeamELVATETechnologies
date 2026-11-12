// Deterministic bill calculation: kWh in, peso breakdown out.
// Standard residential accounts only (no net-metering, lifeline or special schedules).
import fs from 'node:fs';

export const rates = JSON.parse(fs.readFileSync(new URL('./rates.json', import.meta.url), 'utf8'));

const LABELS = {
  generation: 'Generation',
  transmission: 'Transmission',
  systemLoss: 'System loss',
  distribution: 'Distribution',
  supply: 'Supply',
  metering: 'Metering',
  universalCharges: 'Universal charges',
  fitAll: 'FIT-All',
  vat: 'VAT',
};

const round2 = (n) => Math.round(n * 100) / 100;

export function computeBill(kwh, cfg = rates) {
  if (!Number.isFinite(kwh) || kwh < 0 || kwh > 100000) throw new RangeError('kwh must be between 0 and 100000');
  const tier = cfg.distributionTiers.find((t) => t.upToKwh === null || kwh <= t.upToKwh);
  const lines = {
    generation: kwh * cfg.perKwh.generation,
    transmission: kwh * cfg.perKwh.transmission,
    systemLoss: kwh * cfg.perKwh.systemLoss,
    distribution: kwh * tier.distribution,
    supply: kwh * tier.supply + cfg.fixedPerMonth.supply,
    metering: kwh * tier.metering + cfg.fixedPerMonth.metering,
    universalCharges: kwh * cfg.perKwh.universalCharges,
    fitAll: kwh * cfg.perKwh.fitAll,
  };
  const vatBase = cfg.vat.appliesTo.reduce((s, k) => s + (lines[k] ?? 0), 0);
  lines.vat = vatBase * cfg.vat.rate;
  const total = Object.values(lines).reduce((a, b) => a + b, 0);
  return {
    kwh: round2(kwh),
    total: round2(total),
    lines: Object.entries(lines).map(([key, amount]) => ({ key, label: LABELS[key], amount: round2(amount) })),
    rateVersion: cfg.version,
  };
}

export function billRange({ low, base, high }, cfg = rates) {
  return { low: computeBill(low, cfg).total, base: computeBill(base, cfg).total, high: computeBill(high, cfg).total };
}

export const rateInfo = () => ({ version: rates.version, verified: rates.verified, source: rates.source });
