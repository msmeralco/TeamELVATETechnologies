import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../shared/api.js';

const staff = { staff: true };

// ------------------------------------------------------------------ demo controls
export default function DemoControls({ meters, onAdvance, onReset, hidden }) {
  const [sim, setSim] = useState(null);
  const [meter, setMeter] = useState('m03');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null); // 'Seeding demo data...' etc.
  const load = useCallback(() => api('/simulation', staff).then((s) => { setSim(s); setErr(null); return s; }).catch((e) => { setErr(e.message); return null; }), []);
  const seeding = useRef(false);

  // Registers DT-001 + meters and backfills history. Each call is bounded; repeat until done.
  const seed = useCallback(async () => {
    if (seeding.current) return;
    seeding.current = true;
    try {
      setBusy('Seeding demo data…');
      for (;;) {
        const r = await api('/simulation/seed', { ...staff, method: 'POST' });
        const total = 12 * 86400e3;
        const pct = Math.round(((r.sim_ts - (r.backfill_end - total + 900e3)) / total) * 100);
        setBusy(`Seeding demo data… ${Math.max(0, Math.min(100, pct))}%`);
        if (r.done) break;
      }
      setErr(null); await load(); onAdvance?.();
    } catch (e) { setErr(`Seeding failed: ${e.message}`); } finally { seeding.current = false; setBusy(null); }
  }, [load, onAdvance]);

  // First load: auto-seed when the database is empty.
  useEffect(() => { load().then((s) => { if (s && !s.seeded) seed(); }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Clock driver. There is no simulator process on Vercel, so while this console is open and the
  // sim is not paused it asks the backend to advance every tick_ms. One request at a time
  // (single-flight); the server also paces and guards against double-advancing.
  const tickMs = sim?.tick_ms; const paused = sim?.paused; const seeded = sim?.seeded;
  useEffect(() => {
    if (!seeded || paused || !tickMs) return undefined;
    let stop = false; let timer;
    const step = async () => {
      const t0 = Date.now();
      try {
        const r = await api('/simulation/ticks', { ...staff, method: 'POST', body: { steps: 8 } });
        if (!stop && r.advanced) { setSim((prev) => prev && { ...prev, sim_ts: r.sim_ts }); onAdvance?.(); }
        if (!stop) setErr((e) => (e && e.startsWith('Clock') ? null : e));
      } catch (e) { if (!stop) setErr(`Clock stalled: ${e.message}`); }
      if (!stop) timer = setTimeout(step, Math.max(50, tickMs - (Date.now() - t0)));
    };
    timer = setTimeout(step, tickMs);
    return () => { stop = true; clearTimeout(timer); };
  }, [seeded, paused, tickMs, onAdvance]);

  const resetDemo = async () => {
    if (!window.confirm('Reset demo data? This deletes all readings, alerts, reports and ledger entries, then re-seeds 12 days of history.')) return;
    try {
      setBusy('Resetting…');
      setSim(await api('/simulation/reset', { ...staff, method: 'POST' }));
      onReset?.();
    } catch (e) { setErr(e.message); setBusy(null); return; }
    setBusy(null);
    await seed();
  };

  const fire = async (type, withMeter = true) => {
    try { setSim(await api('/simulation/events', { ...staff, method: 'POST', body: { type, meter_id: withMeter ? meter : undefined } })); setErr(null); } catch (e) { setErr(e.message); }
  };
  const patch = async (body) => { try { setSim(await api('/simulation', { ...staff, method: 'PATCH', body })); } catch (e) { setErr(e.message); } };

  const active = sim?.events;
  const activeList = active ? [
    ...active.spike.map((m) => `spike ${m}`), ...active.flatline.map((m) => `flatline ${m}`),
    ...active.tamper.map((m) => `tamper ${m}`), ...(active.tap ? ['tap on DT'] : []),
  ] : [];

  return (
    <section className="ops-demo" aria-label="Demo controls" hidden={hidden}>
      <span className="ops-demo-label">Demo</span>
      <label>
        <span className="sr-only">Meter</span>
        <select value={meter} onChange={(e) => setMeter(e.target.value)}>
          {(meters.length ? meters : [{ id: 'm03' }]).map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
        </select>
      </label>
      <button className="page-secondary" onClick={() => fire('spike')}>Usage spike</button>
      <button className="page-secondary" onClick={() => fire('flatline')}>Flatline</button>
      <button className="page-secondary" onClick={() => fire('tamper')}>Tamper signature</button>
      <span className="ops-sep" />
      <button className="page-secondary" onClick={() => fire('tap', false)}>Tap before meters</button>
      <button className="page-secondary" onClick={() => fire('clear', false)}>Clear events</button>
      <span className="ops-sep" />
      <label className="speed">
        <span>Speed</span>
        <select value={sim?.tick_ms ?? 1000} onChange={(e) => patch({ tick_ms: Number(e.target.value) })}>
          <option value={2000}>15 min / 2 s</option>
          <option value={1000}>15 min / 1 s</option>
          <option value={300}>15 min / 0.3 s</option>
        </select>
      </label>
      <button className="page-secondary" onClick={() => patch({ paused: !sim?.paused })}>{sim?.paused ? 'Resume' : 'Pause'}</button>
      <button className="page-secondary" onClick={resetDemo} disabled={!!busy}>Reset demo data</button>
      <span className="ops-demo-state">{busy ? busy : err ? <span className="warning-text">{err}</span> : activeList.length ? `Active: ${activeList.join(', ')}` : 'No injected events'}</span>
    </section>
  );
}
