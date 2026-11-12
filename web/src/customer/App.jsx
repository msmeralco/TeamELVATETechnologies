import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, useEvents } from '../shared/api.js';
import { DailyColumns } from '../shared/charts.jsx';
import { php, php2, kwh, simTime, dayLabel, wallTime, CATEGORY_LABEL, sourceLabel } from '../shared/format.js';

const initialMeter = new URLSearchParams(location.search).get('meter') || 'm03';

export default function App() {
  const [meterId, setMeterId] = useState(initialMeter);
  const [meters, setMeters] = useState([]);
  const [tab, setTab] = useState('bill');
  const [system, setSystem] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [unread, setUnread] = useState(0);
  const [toast, setToast] = useState(null);

  useEffect(() => { api('/meters').then(setMeters).catch(() => {}); api('/system').then(setSystem).catch(() => {}); }, []);

  const loadAlerts = useCallback(() => api(`/alerts?audience=customer&meter_id=${meterId}`).then(setAlerts).catch(() => {}), [meterId]);
  useEffect(() => { loadAlerts(); setUnread(0); }, [loadAlerts]);

  const switchMeter = (id) => {
    setMeterId(id);
    const u = new URL(location.href); u.searchParams.set('meter', id); history.replaceState(null, '', u);
  };

  useEvents({
    alert: (a) => {
      if (a.meter_id !== meterId || a.audience === 'ops' || a.status !== 'open') return;
      setAlerts((prev) => (prev.some((x) => x.id === a.id) ? prev : [a, ...prev]));
      if (tab !== 'inbox') setUnread((n) => n + 1);
      setToast(a);
    },
  }, { alerts: { path: `/alerts?audience=customer&meter_id=${meterId}` } });
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(null), 7000); return () => clearTimeout(t); }, [toast]);
  useEffect(() => { if (tab === 'inbox') setUnread(0); }, [tab]);

  const integrations = system?.integrations?.apis?.emessage ?? system?.integrations?.mode;

  return (
    <div className="phone">
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <span>Meralco Go</span>
        </div>
        <label className="who">
          <span className="sr-only">Viewing as</span>
          <select value={meterId} onChange={(e) => switchMeter(e.target.value)}>
            {(meters.length ? meters : [{ id: meterId, label: `Household ${meterId.toUpperCase()}` }]).map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </label>
      </header>

      {toast && (
        <button className="toast" onClick={() => { setTab('inbox'); setToast(null); }}>
          <strong>{toast.title}</strong>
          <span>Tap to read</span>
        </button>
      )}

      <main className="content">
        {tab === 'bill' && <BillView meterId={meterId} />}
        {tab === 'inbox' && <Inbox alerts={alerts} />}
        {tab === 'report' && <ReportForm meterId={meterId} />}
      </main>

      <footer className="fineprint">
        Simulated smart-meter data · alerts via EMessage ({integrations === 'live' ? 'live' : 'simulated'}) · demo login
      </footer>

      <nav className="tabs" aria-label="Sections">
        {[['bill', 'My bill'], ['inbox', 'Alerts'], ['report', 'Report']].map(([k, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)} aria-current={tab === k ? 'page' : undefined}>
            {label}
            {k === 'inbox' && unread > 0 && <span className="dot">{unread}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}

// --------------------------------------------------------------------- bill
function BillView({ meterId }) {
  const [usage, setUsage] = useState(null);
  const [proj, setProj] = useState(null);
  const [baseline, setBaseline] = useState(null);
  const [hours, setHours] = useState(0);
  const [error, setError] = useState(null);
  const hoursRef = useRef(0);
  hoursRef.current = hours;

  const load = useCallback(async (h) => {
    try {
      const [u, p] = await Promise.all([api(`/meters/${meterId}/consumption`), api(`/meters/${meterId}/projection?aircon_hours=${h}`)]);
      setUsage(u); setProj(p); setError(null);
      if (h === 0) setBaseline(p);
    } catch (e) { setError(e); }
  }, [meterId]);

  useEffect(() => { setHours(0); setBaseline(null); setProj(null); setUsage(null); load(0); }, [load]);

  // Refresh as new readings arrive (throttled to every 15 s of wall time).
  useEffect(() => {
    const t = setInterval(async () => {
      if (hoursRef.current !== 0) {
        try { setBaseline(await api(`/meters/${meterId}/projection?aircon_hours=0`)); } catch { /* keep last */ }
      }
      load(hoursRef.current);
    }, 15000);
    return () => clearInterval(t);
  }, [load, meterId]);

  // Debounced what-if
  useEffect(() => {
    if (!baseline) return undefined;
    const t = setTimeout(() => load(hours), 250);
    return () => clearTimeout(t);
  }, [hours]); // eslint-disable-line react-hooks/exhaustive-deps

  const days = useMemo(() => {
    if (!usage || !proj) return [];
    const recorded = usage.daily.map((d) => ({ label: dayLabel(d.date), value: d.kwh, kind: 'recorded', note: d.complete ? null : 'Today so far' }));
    const remaining = Math.max(0, Math.ceil(proj.projection.remaining_days - 0.01) - (usage.daily.at(-1)?.complete ? 0 : 0));
    const lastDate = usage.daily.at(-1)?.date;
    const projected = [];
    for (let i = 1; i <= remaining && lastDate; i++) {
      const d = new Date(`${lastDate}T00:00:00+08:00`); d.setDate(d.getDate() + i);
      projected.push({ label: d.toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' }), value: proj.projection.expected_daily_kwh, kind: 'projected' });
    }
    return [...recorded, ...projected].slice(0, usage.cycle.days);
  }, [usage, proj]);

  if (error) {
    return <section className="empty"><h2>Can't project your bill right now</h2><p>{error.code === 'NO_DATA' ? 'No meter readings have arrived yet. Start the simulator and this page fills in on its own.' : error.message}</p><button className="btn" onClick={() => load(hours)}>Try again</button></section>;
  }
  if (!proj || !usage) return <section className="loading" aria-busy="true"><div className="skeleton hero-sk" /><div className="skeleton chart-sk" /></section>;

  const t = proj.projection.total_kwh;
  const delta = baseline && hours > 0 ? proj.bill.base - baseline.bill.base : 0;

  return (
    <>
      <section className="hero">
        <p className="eyebrow">Day {proj.cycle.day} of {proj.cycle.days} · as of {simTime(proj.as_of)}</p>
        <h1 className="sr-only">Projected bill</h1>
        <p className="lead">You're on track for</p>
        <p className="figure">{php(proj.bill.base)}</p>
        <p className="range">likely between <b>{php(proj.bill.low)}</b> and <b>{php(proj.bill.high)}</b></p>
        <RangeBar bill={proj.bill} />
        <dl className="facts">
          <div><dt>Used so far</dt><dd className="num">{kwh(proj.projection.used_kwh)}</dd></div>
          <div><dt>Projected total</dt><dd className="num">{kwh(t.base)}</dd></div>
          <div><dt>Days left</dt><dd className="num">{proj.projection.remaining_days.toFixed(1)}</dd></div>
        </dl>
      </section>

      <section className="whatif">
        <div className="whatif-head">
          <h2>What if I run the aircon more?</h2>
          <output className={delta > 0 ? 'up' : ''}>{hours > 0 ? `+${php(delta)}` : 'Your usual'}</output>
        </div>
        <label htmlFor="hours" className="slider-label">
          Extra aircon per day: <b className="num">{hours} {hours === 1 ? 'hour' : 'hours'}</b>
        </label>
        <input id="hours" type="range" min="0" max="8" step="0.5" value={hours} onChange={(e) => setHours(Number(e.target.value))} />
        <p className="hint">Assumes {proj.what_if.assumption}. The forecast also uses your recent usage pattern and the temperature outlook ({proj.projection.features.temp_outlook_c}°C).</p>
      </section>

      <section className="usage">
        <h2>This billing cycle</h2>
        <DailyColumns days={days} title="Daily electricity use this billing cycle, recorded and projected" />
      </section>

      <details className="breakdown">
        <summary>
          <span>How {php(proj.bill.base)} adds up</span>
          <span className="muted num">{kwh(proj.breakdown.kwh)}</span>
        </summary>
        <ul>
          {proj.breakdown.lines.map((l) => <li key={l.key}><span>{l.label}</span><span className="num">{php2(l.amount)}</span></li>)}
          <li className="total"><span>Projected total</span><span className="num">{php2(proj.breakdown.total)}</span></li>
        </ul>
      </details>

      <p className="disclaimer">
        A range, not a guarantee: your actual bill depends on how much you use for the rest of the cycle.
        {!proj.rate.verified && <> <strong>Rates shown are illustrative placeholders, not the current Meralco schedule.</strong></>}
        {' '}Model {proj.projection.model_version}.
      </p>
    </>
  );
}

function RangeBar({ bill }) {
  // Thin segmented figure: low..high span on a track from 0.8x low to 1.2x high.
  const min = bill.low * 0.8; const max = bill.high * 1.2;
  const pos = (v) => `${((v - min) / (max - min)) * 100}%`;
  return (
    <div className="rangebar" aria-hidden="true">
      <span className="span" style={{ left: pos(bill.low), width: `calc(${pos(bill.high)} - ${pos(bill.low)})` }} />
      <span className="pin" style={{ left: pos(bill.base) }} />
    </div>
  );
}

// --------------------------------------------------------------------- inbox
function Inbox({ alerts }) {
  if (!alerts.length) {
    return (
      <section className="empty">
        <h2>No alerts</h2>
        <p>If your usage suddenly jumps, or your meter stops recording, you'll get a plain-language message here before your bill closes.</p>
      </section>
    );
  }
  return (
    <section>
      <h2 className="section-title">Alerts</h2>
      <ol className="inbox">
        {alerts.map((a) => (
          <li key={a.id}>
            <p className="when">{simTime(a.detected_at)} <span className="muted">· via EMessage ({sourceLabel(a.emessage_source)})</span></p>
            <h3>{a.title}</h3>
            <p>{a.customer_text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

// --------------------------------------------------------------------- report
const CATS = [
  ['meter_issue', 'My meter seems wrong', 'Not recording, damaged, or readings look off'],
  ['suspected_jumper', 'Possible illegal connection nearby', 'Wires tapped to a post or line'],
  ['safety_hazard', 'Safety hazard', 'Sagging or sparking lines, exposed wires'],
  ['other', 'Something else', ''],
];

function ReportForm({ meterId }) {
  const [category, setCategory] = useState('');
  const [note, setNote] = useState('');
  const [state, setState] = useState({ status: 'idle' });

  const submit = async (e) => {
    e.preventDefault();
    if (!category) { setState({ status: 'error', message: 'Pick what the concern is about.' }); return; }
    setState({ status: 'sending' });
    try {
      const r = await api('/reports', { method: 'POST', body: { meter_id: meterId, category, note: note.trim() || undefined } });
      setState({ status: 'sent', report: r });
      setCategory(''); setNote('');
    } catch (err) { setState({ status: 'error', message: err.message }); }
  };

  if (state.status === 'sent') {
    const r = state.report;
    return (
      <section className="sent">
        <p className="eyebrow">Report received · {wallTime(r.created_at)}</p>
        <h2>Thanks. Meralco staff will review it.</h2>
        <p>Reference <b className="num">{r.ereport_ticket}</b> ({CATEGORY_LABEL[r.category]}), filed through EReport ({sourceLabel(r.ereport_source)}).</p>
        <button className="btn" onClick={() => setState({ status: 'idle' })}>Report something else</button>
      </section>
    );
  }

  return (
    <form className="report" onSubmit={submit} noValidate>
      <h2 className="section-title">Report a concern</h2>
      <fieldset>
        <legend>What is it about?</legend>
        {CATS.map(([k, label, sub]) => (
          <label key={k} className={`choice ${category === k ? 'on' : ''}`}>
            <input type="radio" name="category" value={k} checked={category === k} onChange={() => setCategory(k)} />
            <span><b>{label}</b>{sub && <small>{sub}</small>}</span>
          </label>
        ))}
      </fieldset>
      <label className="note">
        <span>Details (optional)</span>
        <textarea rows="3" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Where is it, and what did you see?" />
        <small className="muted num">{note.length}/500</small>
      </label>
      {state.status === 'error' && <p className="error-note" role="alert">{state.message}</p>}
      <button className="btn primary wide" disabled={state.status === 'sending'}>{state.status === 'sending' ? 'Sending…' : 'Send report'}</button>
      <p className="hint">Reports go to Meralco staff for review and are never shown to other customers.</p>
    </form>
  );
}
