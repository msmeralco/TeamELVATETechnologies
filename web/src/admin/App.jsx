import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, useEvents } from '../shared/api.js';
import { RatioLine } from '../shared/charts.jsx';
import { kwh, pct, php, simTime, simDate, wallTime, TYPE_LABEL, CATEGORY_LABEL, sourceLabel } from '../shared/format.js';
import { Icon, Logo } from './icons.jsx';
import DemoControls from './DemoControls.jsx';

const staff = { staff: true };

// ------------------------------------------------------------------ helpers
const severityOf = (score = 0) => (score >= 0.85 ? 'high' : score >= 0.6 ? 'medium' : 'low');
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const meterStatus = (m) => {
  if (!m.last_ts) return 'offline';
  if (m.anomaly_type && m.anomaly_score >= 0.6) return 'anomaly';
  if (m.anomaly_type && m.anomaly_score >= 0.3) return 'warning';
  return 'normal';
};
const signalLevel = (q) => (q == null ? 0 : q >= 0.85 ? 4 : q >= 0.65 ? 3 : q >= 0.4 ? 2 : 1);
const sigText = (q) => (q == null ? '—' : ['', 'Weak', 'Fair', 'Good', 'Strong'][signalLevel(q)]);
// Deterministic spot on the illustrated map for a meter (no coordinates in the data model).
const pinPos = (i) => [12 + ((i * 37 + 11) % 76), 14 + ((i * 53 + 7) % 70)];
const PAGE = 10;
const STATUSES = ['normal', 'warning', 'anomaly', 'offline'];

function downloadCsv(name, rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const blob = new Blob([rows.map((r) => r.map(esc).join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const NAV = [
  { title: 'Grid', items: [
    { label: 'Overview', icon: 'overview' }, { label: 'Grid map', icon: 'map' }, { label: 'Meters', icon: 'meter' },
    { label: 'Unusual activity', icon: 'alert', count: 'alerts' }, { label: 'Forecasts', icon: 'forecast' },
  ] },
  { title: 'Customers', items: [
    { label: 'Reports', icon: 'report', count: 'reports' }, { label: 'Messages', icon: 'message' }, { label: 'Records', icon: 'record' },
  ] },
];

const Skeleton = ({ width, height = 10 }) => <i className="skeleton" style={{ width, height }} />;
const SignalBars = ({ level = 4 }) => <span className="signal-bars">{[1, 2, 3, 4].map((b) => <i className={b <= level ? 'on' : ''} key={b} />)}</span>;
const MeterStatus = ({ status }) => <span className={`meter-status-chip ${status}`}><i /> {cap(status)}</span>;
const Severity = ({ level }) => <i className={`severity ${level}`}><Icon name="alert" size={13} />{cap(level)}</i>;

function RowMenu({ items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <span className="ops-menu-wrap" ref={ref}>
      <button className="row-more" aria-label="More actions" onClick={() => setOpen(!open)}><Icon name="more" size={17} /></button>
      {open && (
        <span className="ops-menu" role="menu">
          {items.map(([label, fn]) => <button key={label} role="menuitem" onClick={() => { setOpen(false); fn(); }}>{label}</button>)}
        </span>
      )}
    </span>
  );
}

function Pagination({ page, setPage, total, label }) {
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const from = total ? (page - 1) * PAGE + 1 : 0;
  const nums = [...new Set([1, page - 1, page, page + 1, pages])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  return (
    <footer className="table-pagination">
      <span>{from} to {Math.min(page * PAGE, total)} of {total} {label}</span>
      <div>
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
        {nums.map((n, i) => (
          <span key={n}>{i > 0 && n - nums[i - 1] > 1 && <span>…</span>}<button className={n === page ? 'active' : ''} onClick={() => setPage(n)}>{n}</button></span>
        ))}
        <button disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </footer>
  );
}

// Daily series -> sparkline paths in a 340x95 box.
function sparkPaths(daily) {
  if (!daily.length) return null;
  const max = Math.max(1, ...daily.map((d) => d.kwh));
  const pts = daily.map((d, i) => [daily.length > 1 ? (i / (daily.length - 1)) * 340 : 170, 85 - (d.kwh / max) * 70]);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  return { line, area: `${line}V95H0Z` };
}

// ------------------------------------------------------------------ login (mocked staff session)
function Login({ onLogin }) {
  const [show, setShow] = useState(false);
  return (
    <main className="login-page">
      <div className="login-brand"><Logo /><span>Meralco Go Admin</span></div>
      <section className="login-card">
        <div className="login-lock"><Icon name="lock" size={25} /></div>
        <span>Operations portal</span>
        <h1>Welcome back</h1>
        <p>Log in with your Meralco staff account.</p>
        <form onSubmit={(e) => { e.preventDefault(); onLogin(); }}>
          <label><span>Email address</span><div><input type="email" defaultValue="alex.santos@meralco.com.ph" /></div></label>
          <label><span>Password</span><div>
            <Icon name="lock" size={18} />
            <input type={show ? 'text' : 'password'} defaultValue="operations" />
            <button type="button" onClick={() => setShow(!show)} aria-label="Show password"><Icon name="eye" size={18} /></button>
          </div></label>
          <button className="forgot" type="button">Forgot password?</button>
          <button className="primary-button" type="submit">Log in</button>
        </form>
        <div className="authorized-note"><Icon name="lock" size={15} />For authorized Meralco staff only. Demo session, no real authentication.</div>
      </section>
      <footer>Meralco Go Operations · Secure access</footer>
    </main>
  );
}

function Sidebar({ active, onChange, onLogout, counts }) {
  return (
    <aside className="sidebar">
      <div className="brand"><Logo /><div><b>Meralco Go</b><span>Admin</span></div></div>
      <nav>
        {NAV.map((g) => (
          <div className="nav-group" key={g.title}>
            <span>{g.title}</span>
            {g.items.map((it) => (
              <button className={active === it.label ? 'active' : ''} onClick={() => onChange(it.label)} key={it.label}>
                <Icon name={it.icon} size={19} /><b>{it.label}</b>
                {it.count && counts[it.count] > 0 && <i>{counts[it.count]}</i>}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <button className={active === 'Settings' ? 'active' : ''} onClick={() => onChange('Settings')}>
          <Icon name="settings" size={19} /><b>Settings</b>
        </button>
        <div className="admin-user">
          <span className="admin-avatar">AS</span>
          <div><b>Alex Santos</b><small>Operations admin</small></div>
          <button onClick={onLogout} aria-label="Log out"><Icon name="logout" size={18} /></button>
        </div>
      </div>
    </aside>
  );
}

function Topbar({ title, system, query, setQuery, openAlerts, onBell, onDate }) {
  const input = useRef(null);
  useEffect(() => {
    const k = (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.current?.focus(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  const c = system?.cycle;
  return (
    <header className="topbar">
      <div className="page-title">
        <h1>{title}</h1>
        <span>{system?.sim_ts ? `Simulated ${simTime(system.sim_ts)}` : 'Waiting for readings'}{c ? ` · cycle day ${c.day}/${c.days}` : ''}</span>
      </div>
      <div className="topbar-actions">
        <label className="global-search">
          <Icon name="search" size={18} />
          <input ref={input} placeholder="Search meters, customers, reports" value={query} onChange={(e) => setQuery(e.target.value)} />
          <kbd>Ctrl K</kbd>
        </label>
        <button className="date-picker" onClick={onDate} title="Current billing cycle">
          <Icon name="calendar" size={18} />
          {c ? `${simDate(c.start)} – ${simDate(system.sim_ts)}` : 'Billing cycle'}
          <Icon name="chevron" size={15} />
        </button>
        <span className={`engine-pill ${system?.engine?.online ? 'on' : ''}`}>Prediction engine {system?.engine?.online ? 'online' : 'offline'}</span>
        <span className="engine-pill">eGov APIs {system?.integrations?.mode ?? '…'}</span>
        <button className="notification-button" aria-label={`Notifications: ${openAlerts} open`} onClick={onBell}>
          <Icon name="bell" size={20} />{openAlerts > 0 && <i />}
        </button>
        <button className="top-avatar" aria-label="Account">AS</button>
      </div>
    </header>
  );
}

function PageTools({ title, description, children }) {
  return (
    <div className="page-tools"><div><h2>{title}</h2><p>{description}</p></div>{children && <div>{children}</div>}</div>
  );
}

function BackTitle({ title, subtitle, onBack, children }) {
  return (
    <div className="detail-titlebar">
      <button onClick={onBack} aria-label="Back">←</button>
      <div><h2>{title}</h2><p>{subtitle}</p></div>
      {children && <div>{children}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ overview
const statusCounts = (meters) => meters.reduce((c, m) => { c[meterStatus(m)]++; return c; }, { normal: 0, warning: 0, anomaly: 0, offline: 0 });
const StatusLegend = ({ counts }) => (
  <div className="map-status">
    {STATUSES.map((s) => <span key={s}><i className={s} /> {cap(s)} <b>{counts[s]}</b></span>)}
  </div>
);

function forecastAccuracy(meters) {
  const devs = meters.map((m) => m.deviation_pct).filter((v) => v != null).map(Math.abs);
  return devs.length ? Math.max(0, Math.min(100, 100 - devs.reduce((a, b) => a + b, 0) / devs.length)) : null;
}

function FigureStrip({ data, loading }) {
  const { meters, alerts, reports, system } = data;
  const online = meters.filter((m) => m.last_ts && system?.sim_ts && system.sim_ts - m.last_ts < 30 * 60e3).length;
  const load = meters.reduce((s, m) => s + (m.today_kwh ?? 0), 0);
  const acc = forecastAccuracy(meters);
  const open = alerts.filter((a) => a.status === 'open').length;
  const items = [
    ['Connected meters', online.toLocaleString(), `of ${meters.length}`, online === meters.length],
    ['Load today', load.toFixed(1), 'kWh', true],
    ['Unusual activity', String(open), 'open', open === 0],
    ['Customer reports', String(reports.filter((r) => r.status === 'new').length), 'new', true],
    ['Forecast accuracy', acc == null ? '—' : acc.toFixed(1), acc == null ? '' : '%', true],
  ];
  return (
    <section className="figure-strip">
      {items.map(([label, value, suffix, good]) => (
        <div key={label}>
          <span>{label}</span>
          {loading ? <><Skeleton width="58%" height={28} /><Skeleton width="42%" /></> : (
            <>
              <p><strong>{value}</strong><b>{suffix}</b></p>
              <small className={good ? 'positive' : 'negative'}>
                <Icon name={good ? 'check' : 'alert'} size={13} />{good ? 'On track' : 'Needs review'}
              </small>
            </>
          )}
        </div>
      ))}
    </section>
  );
}

function BalancePanel({ transformers, loading, onDetails }) {
  const STEP = 15 * 60 * 1000;
  return (
    <section className="panel load-panel">
      <header className="panel-header">
        <div><h2>Transformer energy balance</h2><p>Energy delivered that meters did not record, rolling 4-hour window. The normal gap is technical loss.</p></div>
        <div className="legend"><span><i className="actual" />Gap now</span><span><i className="forecast" />Baseline</span></div>
      </header>
      {loading && <div className="chart-loading"><Skeleton width="100%" height={210} /></div>}
      {!loading && !transformers.length && <p className="ops-empty">No transformer data yet.</p>}
      {!loading && transformers.map((t) => {
        const b = t.balance;
        const points = (b?.series ?? []).map((p) => ({ label: simTime(b.ts + p.i * STEP), value: p.gap_ratio }));
        return (
          <div key={t.id} className="balance-block">
            <div className="chart-footer">
              <div><span>{t.id} gap now</span><strong>{b ? pct(b.gap_ratio) : '—'}</strong></div>
              <div><span>Baseline</span><strong>{b ? pct(b.baseline) : '—'}</strong></div>
              <div><span>Deviation</span><strong className={b?.flag ? 'warning-text' : ''}>{b?.z == null ? '—' : `${b.z}σ`}</strong></div>
              <button onClick={onDetails}>View forecast details<Icon name="chevron" size={15} /></button>
            </div>
            {b ? <RatioLine points={points} reference={b.baseline} referenceLabel="baseline" title={`${t.id} unbilled energy gap, last 3 days`} /> : <p className="ops-empty">Waiting for live readings…</p>}
          </div>
        );
      })}
    </section>
  );
}

const PLACES = [['center', 'Malolos'], ['longos', 'Brgy. Longos'], ['guinhawa', 'Guinhawa']];

function MapPanel({ meters, loading, onOpen }) {
  return (
    <section className="panel map-panel">
      <header className="panel-header">
        <div><h2>Meter status</h2><p>Malolos, Bulacan · {meters.length} meters</p></div>
        <button className="more-button" aria-label="Open grid map" onClick={onOpen}><Icon name="more" size={19} /></button>
      </header>
      {loading ? <Skeleton width="100%" height={250} /> : (
        <div className="grid-map">
          <div className="river" /><div className="road road-one" /><div className="road road-two" /><div className="road road-three" />
          {PLACES.map(([c, l]) => <span key={c} className={`place-label ${c}`}>{l}</span>)}
          {meters.map((m, i) => { const [x, y] = pinPos(i); return <i key={m.id} title={m.id} className={`meter-pin ${meterStatus(m)}`} style={{ left: `${x}%`, top: `${y}%` }} />; })}
          <div className="map-scale">1 km</div>
        </div>
      )}
      <StatusLegend counts={statusCounts(meters)} />
      <button className="panel-link" onClick={onOpen}>Open grid map<Icon name="chevron" size={15} /></button>
    </section>
  );
}

function NeedsAttention({ alerts, state, onAll, onOpen }) {
  const all = alerts.filter((a) => a.status === 'open');
  const open = state === 'empty' ? [] : all.slice(0, 5);
  const loading = state === 'loading';
  return (
    <section className="panel attention-panel">
      <header className="panel-header">
        <div><h2>Needs attention</h2><p>Highest-priority events requiring review. Signals, not findings.</p></div>
        <button className="panel-link top-link" onClick={onAll}>View all {state === 'empty' ? 0 : all.length}<Icon name="chevron" size={15} /></button>
      </header>
      <div className="attention-table">
        <div className="table-row table-head"><span>Severity</span><span>Type</span><span>Meter ID</span><span>Area</span><span>Detected</span><span /></div>
        {loading && [0, 1, 2, 3, 4].map((i) => <div className="table-row loading-row" key={i}><Skeleton width={70} height={24} /><Skeleton width="80%" /><Skeleton width="70%" /><Skeleton width="70%" /><Skeleton width="55%" /><Skeleton width={68} height={30} /></div>)}
        {!loading && !open.length && (
          <div className="attention-empty"><span><Icon name="check" size={25} /></span><div><h3>Nothing needs attention right now.</h3><p>New unusual activity will appear here for review.</p></div></div>
        )}
        {!loading && open.map((a) => (
          <div className="table-row" key={a.id}>
            <span><Severity level={severityOf(a.score)} /></span>
            <span className="type-cell">{TYPE_LABEL[a.type] ?? a.type}</span>
            <strong>{a.meter_id ?? '—'}</strong>
            <span>{a.transformer_id ?? '—'}</span>
            <span>{simTime(a.detected_at)}</span>
            <button className="review-button" onClick={() => onOpen(a.id)}><Icon name="review" size={15} />Review</button>
          </div>
        ))}
      </div>
    </section>
  );
}

function LatestReports({ reports, loading, onAll }) {
  const iconFor = (c) => (c === 'meter_issue' ? 'meter' : c === 'safety_hazard' ? 'alert' : 'report');
  return (
    <section className="panel reports-panel">
      <header className="panel-header">
        <div><h2>Latest customer reports</h2><p>{reports.filter((r) => r.status === 'new').length} new via EReport</p></div>
        <button className="panel-link top-link" onClick={onAll}>View all<Icon name="chevron" size={15} /></button>
      </header>
      <div className="report-list">
        {loading && [0, 1, 2, 3].map((i) => <div className="report-list-row" key={i}><Skeleton width={34} height={34} /><div><Skeleton width="80%" /><Skeleton width="55%" /></div></div>)}
        {!loading && !reports.length && <p className="ops-empty">No reports yet. Customers file them from the app's Report tab.</p>}
        {!loading && reports.slice(0, 4).map((r) => (
          <button className="report-list-row" key={r.id} onClick={onAll}>
            <span className={r.category === 'safety_hazard' ? 'high' : r.category === 'suspected_jumper' ? 'warning' : 'info'}><Icon name={iconFor(r.category)} size={17} /></span>
            <div><b>{CATEGORY_LABEL[r.category]}</b><small>{r.meter_id} · {wallTime(r.created_at)}</small></div>
            <Icon name="chevron" size={15} />
          </button>
        ))}
      </div>
    </section>
  );
}

function Overview({ data, go, openAlert }) {
  const [state, setState] = useState('default');
  const effective = !data.loaded ? 'loading' : state;
  const loading = effective === 'loading';
  return (
    <main className="dashboard-content">
      <FigureStrip data={data} loading={loading} />
      <div className="main-grid">
        <BalancePanel transformers={data.transformers} loading={loading} onDetails={() => go('Forecasts')} />
        <MapPanel meters={data.meters} loading={loading} onOpen={() => go('Grid map')} />
      </div>
      <div className="lower-grid">
        <NeedsAttention alerts={data.alerts} state={effective} onAll={() => go('Unusual activity')} onOpen={openAlert} />
        <LatestReports reports={data.reports} loading={loading} onAll={() => go('Reports')} />
      </div>
      <div className="prototype-state">
        <span>Preview state</span>
        {[['default', 'Default'], ['loading', 'Loading'], ['empty', 'Empty table']].map(([k, l]) => (
          <button className={state === k ? 'active' : ''} onClick={() => setState(k)} key={k}>{l}</button>
        ))}
      </div>
    </main>
  );
}

// ------------------------------------------------------------------ grid map
function MeterDrawer({ sel, onClose, onOpenMeter, onMessage }) {
  const [c, setC] = useState(null);
  useEffect(() => { setC(null); api(`/meters/${sel.id}/consumption`).then(setC).catch(() => setC(null)); }, [sel.id]);
  const sp = sparkPaths(c?.daily ?? []);
  const status = meterStatus(sel);
  return (
    <aside className="meter-drawer">
      <header><div><span>Selected meter</span><h2>{sel.id}</h2></div><button onClick={onClose} aria-label="Close">×</button></header>
      <div className="drawer-customer">
        <span className="drawer-avatar">{(sel.label ?? sel.id).split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()}</span>
        <div><b>{sel.label}</b><small>{sel.transformer_id} · {cap(sel.customer_type)} · Malolos, Bulacan</small></div>
        <i className={`status-chip ${status}`}>{status === 'normal' ? <Icon name="check" size={13} /> : <Icon name="alert" size={13} />} {cap(status)}</i>
      </div>
      <section>
        <div className="drawer-section-title"><span>Daily usage this cycle</span><b>{kwh(sel.today_kwh)} today</b></div>
        {sp ? <svg className="sparkline" viewBox="0 0 340 95" preserveAspectRatio="none"><path d={sp.line} /><path className="spark-area" d={sp.area} /></svg> : <p className="ops-empty">No daily data yet.</p>}
        <div className="spark-labels"><span>{c?.daily?.[0]?.date ?? ''}</span><span>Cycle start</span><span>Now</span></div>
      </section>
      <dl className="drawer-facts">
        <div><dt>Last reading</dt><dd>{sel.cumulative_kwh != null ? `${sel.cumulative_kwh.toFixed(3)} kWh · ${simTime(sel.last_ts)}` : '—'}</dd></div>
        <div><dt>Signal</dt><dd><SignalBars level={signalLevel(sel.signal_quality)} /> {sigText(sel.signal_quality)}</dd></div>
        <div><dt>Gateway</dt><dd>GW-{sel.transformer_id}</dd></div>
        <div><dt>Feeder</dt><dd>{sel.transformer_id}</dd></div>
        <div><dt>Anomaly score</dt><dd>{(sel.anomaly_score ?? 0).toFixed(2)}</dd></div>
      </dl>
      <div className="drawer-actions">
        <button className="drawer-primary" onClick={() => onOpenMeter(sel.id)}>Open meter</button>
        <button className="drawer-secondary" onClick={() => onMessage(sel.id)}><Icon name="message" size={16} /> Message customer</button>
      </div>
    </aside>
  );
}

function GridMapPage({ meters, transformers, onOpenMeter, onMessage }) {
  const [selected, setSelected] = useState(null);
  const [checks, setChecks] = useState({ normal: true, warning: true, anomaly: true, offline: true });
  const [feeder, setFeeder] = useState('all');
  const [gateways, setGateways] = useState(true);
  const [zoom, setZoom] = useState(1);
  const counts = statusCounts(meters);
  const idx = new Map(meters.map((m, i) => [m.id, i]));
  const visible = meters.filter((m) => checks[meterStatus(m)] && (feeder === 'all' || m.transformer_id === feeder));
  const sel = meters.find((m) => m.id === selected);
  // Cluster bubble per transformer at the centroid of its meters (shown when zoomed out).
  const clusters = useMemo(() => {
    const g = {};
    visible.forEach((m) => { (g[m.transformer_id] ??= []).push(pinPos(idx.get(m.id))); });
    return Object.entries(g).map(([id, ps]) => ({ id, n: ps.length, x: ps.reduce((s, p) => s + p[0], 0) / ps.length, y: ps.reduce((s, p) => s + p[1], 0) / ps.length }));
  }, [visible, idx]);
  const reset = () => { setChecks({ normal: true, warning: true, anomaly: true, offline: true }); setFeeder('all'); setZoom(1); };
  return (
    <main className="grid-map-page">
      <div className="full-map">
        <div className="full-map-inner" style={{ transform: `scale(${zoom})` }}>
          <div className="map-river large-river" /><div className="map-road map-road-one" /><div className="map-road map-road-two" /><div className="map-road map-road-three" /><div className="map-road map-road-four" />
          <span className="full-place malolos">Malolos</span><span className="full-place longos">Brgy. Longos</span><span className="full-place guinhawa">Guinhawa</span><span className="full-place tikay">Tikay</span>
          {visible.map((m) => {
            const s = meterStatus(m); const [x, y] = pinPos(idx.get(m.id));
            return (
              <button className={`shape-pin ${s} ${selected === m.id ? 'selected' : ''}`} style={{ left: `${x}%`, top: `${y}%`, transform: `scale(${1 / zoom})` }} onClick={() => setSelected(m.id)} key={m.id} aria-label={`${m.id} ${s}`} title={m.id}>
                {s === 'offline' && <i />}
                {m.open_alerts > 0 && <span>{m.open_alerts}</span>}
              </button>
            );
          })}
          {zoom <= 1 && clusters.map((c) => (
            <button className="cluster" style={{ left: `${c.x}%`, top: `${c.y}%` }} key={c.id} onClick={() => { setFeeder(c.id); setZoom(1.6); }} title={`${c.id}: zoom in`}>
              <b>{c.n}</b><span>meters</span>
            </button>
          ))}
          {gateways && transformers.slice(0, 2).map((t, i) => (
            <div className={`gateway ${i ? 'gateway-two' : 'gateway-one'}`} key={t.id}>
              <i /><span><Icon name="tower" size={20} /></span><b>GW-{t.id}</b>
            </div>
          ))}
        </div>
      </div>
      <section className="map-filter-panel">
        <header><h2>Map filters</h2><button onClick={reset}>Reset</button></header>
        <label><span>Area</span>
          <select className="filter-select" defaultValue="malolos" aria-label="Area"><option value="malolos">All Malolos areas</option></select>
        </label>
        <label><span>Feeder</span>
          <select className="filter-select" value={feeder} onChange={(e) => setFeeder(e.target.value)} aria-label="Feeder">
            <option value="all">All feeders</option>
            {transformers.map((t) => <option key={t.id} value={t.id}>{t.id}</option>)}
          </select>
        </label>
        <div className="status-checks">
          <span>Status</span>
          {STATUSES.map((s) => (
            <button className={checks[s] ? 'checked' : ''} onClick={() => setChecks({ ...checks, [s]: !checks[s] })} key={s}>
              <i>{checks[s] && <Icon name="check" size={11} />}</i><em className={s} />{cap(s)}<b>{counts[s]}</b>
            </button>
          ))}
        </div>
        <button className="gateway-toggle" onClick={() => setGateways(!gateways)} aria-pressed={gateways}>
          <span><Icon name="tower" size={17} /> LoRaWAN gateways</span><i className={gateways ? 'on' : ''}><em /></i>
        </button>
        <p className="ops-note">Pin and gateway positions are illustrative: the data model has no coordinates yet.</p>
      </section>
      <div className="map-controls">
        <button onClick={() => setZoom((z) => Math.min(2.4, +(z + 0.4).toFixed(1)))} aria-label="Zoom in">+</button>
        <button onClick={() => setZoom((z) => Math.max(1, +(z - 0.4).toFixed(1)))} aria-label="Zoom out">−</button>
        <button onClick={() => setZoom(1)} aria-label="Recenter"><Icon name="pin" size={17} /></button>
      </div>
      <div className="map-legend">
        {STATUSES.map((s) => <span key={s}><i className={s} /> {cap(s)}</span>)}
        <span><Icon name="tower" size={15} /> Gateway</span>
      </div>
      {sel && <MeterDrawer sel={sel} onClose={() => setSelected(null)} onOpenMeter={onOpenMeter} onMessage={onMessage} />}
    </main>
  );
}

// ------------------------------------------------------------------ meters
function AddMeterModal({ transformers, onClose, onDone, notify }) {
  const [f, setF] = useState({ id: '', label: '', transformer_id: transformers[0]?.id ?? 'DT-001', customer_type: 'residential' });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      // Demo: ingest key is the public default; production deployments set their own.
      const r = await fetch(`/api/v1/meters/${encodeURIComponent(f.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-ingest-key': 'dev-ingest-key' }, body: JSON.stringify({ label: f.label, transformer_id: f.transformer_id, customer_type: f.customer_type }) });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error?.message ?? `Request failed (${r.status})`);
      notify(`Meter ${f.id} added. It will show as offline until readings arrive.`); onDone(); onClose();
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="ops-modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="ops-modal" onSubmit={submit} role="dialog" aria-label="Add meter">
        <h2>Add meter</h2>
        <label><span>Meter ID</span><input required pattern="[A-Za-z0-9_-]{1,32}" value={f.id} onChange={set('id')} placeholder="m21" /></label>
        <label><span>Customer name</span><input required maxLength={80} value={f.label} onChange={set('label')} placeholder="Household 21" /></label>
        <label><span>Transformer (feeder)</span><input required pattern="[A-Za-z0-9_-]{1,32}" list="dt-list" value={f.transformer_id} onChange={set('transformer_id')} /><datalist id="dt-list">{transformers.map((t) => <option key={t.id} value={t.id} />)}</datalist></label>
        <label><span>Customer type</span><select value={f.customer_type} onChange={set('customer_type')}><option>residential</option><option>commercial</option></select></label>
        {err && <p className="warning-text">{err}</p>}
        <div className="ops-row-actions"><button type="button" className="page-secondary" onClick={onClose}>Cancel</button><button className="page-primary" disabled={busy}>{busy ? 'Adding…' : 'Add meter'}</button></div>
      </form>
    </div>
  );
}

function MetersPage({ meters, transformers, query, onOpenMeter, onMessage, refresh, notify }) {
  const [filter, setFilter] = useState('all');
  const [local, setLocal] = useState('');
  const [sortAsc, setSortAsc] = useState(true);
  const [selected, setSelected] = useState([]);
  const [page, setPage] = useState(1);
  const [showFilters, setShowFilters] = useState(false);
  const [dt, setDt] = useState('all');
  const [type, setType] = useState('all');
  const [adding, setAdding] = useState(false);
  const counts = statusCounts(meters);
  const rows = useMemo(() => {
    const q = `${query} ${local}`.trim().toLowerCase();
    const terms = q.split(/\s+/).filter(Boolean);
    const r = meters.filter((m) => (filter === 'all' || meterStatus(m) === filter) && (dt === 'all' || m.transformer_id === dt) && (type === 'all' || m.customer_type === type)
      && terms.every((t) => m.id.toLowerCase().includes(t) || (m.label ?? '').toLowerCase().includes(t)));
    return sortAsc ? r : [...r].reverse();
  }, [meters, filter, query, local, sortAsc, dt, type]);
  useEffect(() => setPage(1), [filter, query, local, dt, type]);
  const pageRows = rows.slice((page - 1) * PAGE, page * PAGE);
  const activeFilters = (dt !== 'all') + (type !== 'all');
  const toggle = (id) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const allOnPage = pageRows.length > 0 && pageRows.every((m) => selected.includes(m.id));
  const exportReadings = (ids) => downloadCsv('meter-readings.csv', [['meter_id', 'customer', 'transformer', 'today_kwh', 'last_reading_kwh', 'last_reading_ts', 'status'], ...meters.filter((m) => ids.includes(m.id)).map((m) => [m.id, m.label, m.transformer_id, m.today_kwh, m.cumulative_kwh, m.last_ts ? new Date(m.last_ts).toISOString() : '', meterStatus(m)])]);
  return (
    <main className="intelligence-page">
      <PageTools title="Meter fleet" description={`${meters.length} smart meters, scored from the latest forecast`}>
        <button className="page-secondary" onClick={() => { refresh(); notify('Readings refreshed.'); }}><Icon name="refresh" size={16} /> Refresh readings</button>
        <button className="page-primary" onClick={() => setAdding(true)}>Add meter</button>
      </PageTools>
      <section className="table-panel meter-table-panel">
        <div className="table-tools">
          <label><Icon name="search" size={17} /><input placeholder="Search meter ID or customer" value={local} onChange={(e) => setLocal(e.target.value)} /></label>
          <div className="filter-chips">
            {['all', ...STATUSES].map((s) => (
              <button className={filter === s ? 'active' : ''} onClick={() => setFilter(s)} key={s}>{s === 'all' ? 'All meters' : cap(s)}{s !== 'all' && <b>{counts[s]}</b>}</button>
            ))}
          </div>
          <button className="filter-button" onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters}>Filters {activeFilters > 0 && <span>{activeFilters}</span>}</button>
        </div>
        {showFilters && (
          <div className="ops-filter-panel">
            <label><span>Feeder</span><select className="ops-select" value={dt} onChange={(e) => setDt(e.target.value)}><option value="all">All feeders</option>{transformers.map((t) => <option key={t.id}>{t.id}</option>)}</select></label>
            <label><span>Customer type</span><select className="ops-select" value={type} onChange={(e) => setType(e.target.value)}><option value="all">All types</option><option value="residential">Residential</option><option value="commercial">Commercial</option></select></label>
            <button className="page-secondary" onClick={() => { setDt('all'); setType('all'); }}>Clear filters</button>
          </div>
        )}
        {selected.length > 0 && (
          <div className="bulk-bar">
            <b>{selected.length} selected</b>
            <button onClick={() => onMessage(selected[0])}>Message customers</button>
            <button onClick={() => exportReadings(selected)}>Export readings</button>
            <button onClick={() => notify('Gateway assignment is not available: gateways are not part of the demo data model.')}>Assign gateway</button>
            <button onClick={() => setSelected([])}>Clear</button>
          </div>
        )}
        <div className="meter-table">
          <div className="meter-table-row meter-table-head">
            <span><input type="checkbox" aria-label="Select all on page" checked={allOnPage} onChange={() => setSelected(allOnPage ? selected.filter((id) => !pageRows.some((m) => m.id === id)) : [...new Set([...selected, ...pageRows.map((m) => m.id)])])} /></span>
            <button onClick={() => setSortAsc(!sortAsc)}>Meter ID <Icon name={sortAsc ? 'trendUp' : 'trendDown'} size={13} /></button>
            <span>Customer</span><span>Area</span><span>Feeder</span><span>Last reading</span><span>Signal</span><span>Status</span><span />
          </div>
          {!rows.length && <p className="ops-empty">No meters match.</p>}
          {pageRows.map((m) => (
            <div className="meter-table-row" key={m.id}>
              <span><input type="checkbox" aria-label={`Select ${m.id}`} checked={selected.includes(m.id)} onChange={() => toggle(m.id)} /></span>
              <button className="meter-link" onClick={() => onOpenMeter(m.id)}>{m.id}</button>
              <span>{m.label}</span><span>Malolos</span><span>{m.transformer_id}</span>
              <span><b>{m.cumulative_kwh != null ? `${m.cumulative_kwh.toFixed(3)} kWh` : '—'}</b><small>{simTime(m.last_ts)}</small></span>
              <span><SignalBars level={signalLevel(m.signal_quality)} /></span>
              <span><MeterStatus status={meterStatus(m)} /></span>
              <RowMenu items={[['Open meter', () => onOpenMeter(m.id)], ['Message customer', () => onMessage(m.id)], ['Export readings', () => exportReadings([m.id])]]} />
            </div>
          ))}
        </div>
        <Pagination page={page} setPage={setPage} total={rows.length} label="meters" />
      </section>
      {adding && <AddMeterModal transformers={transformers} onClose={() => setAdding(false)} onDone={refresh} notify={notify} />}
    </main>
  );
}

function UsageChart({ daily, anomaly = false }) {
  const max = Math.max(1, ...daily.map((d) => d.kwh));
  const y = (v) => 190 - (v / max) * 170;
  const x = (i) => (daily.length > 1 ? (i / (daily.length - 1)) * 780 : 0);
  const pts = daily.map((d, i) => `${x(i)},${y(d.kwh)}`).join(' ');
  const avg = daily.length ? daily.reduce((s, d) => s + d.kwh, 0) / daily.length : 0;
  const every = Math.max(1, Math.ceil(daily.length / 7));
  return (
    <div className={`admin-usage-chart ${anomaly ? 'anomaly-chart' : ''}`}>
      {daily.length ? (
        <svg viewBox="0 0 780 200" preserveAspectRatio="none">
          <g className="chart-grid"><path d="M0 30H780M0 85H780M0 140H780M0 195H780" /></g>
          <path className="forecast-line" d={`M0 ${y(avg)}H780`} />
          <polyline className={anomaly ? 'anomaly-actual' : 'actual-line'} fill="none" points={pts} />
        </svg>
      ) : <p className="ops-empty">No daily data yet.</p>}
      <div className="admin-chart-labels">{daily.filter((_, i) => i % every === 0).map((d) => <span key={d.date}>{d.date}</span>)}</div>
    </div>
  );
}

function MeterDetailPage({ id, meters, alerts, ledger, onBack, onMessage, onFieldTask }) {
  const m = meters.find((x) => x.id === id);
  const [c, setC] = useState(null);
  useEffect(() => { api(`/meters/${id}/consumption`).then(setC).catch(() => setC(null)); }, [id]);
  if (!m) return <main className="intelligence-page"><BackTitle title={id} subtitle="Meter not found" onBack={onBack} /></main>;
  const mine = alerts.filter((a) => a.meter_id === id);
  const daily = c?.daily ?? [];
  return (
    <main className="intelligence-page detail-page-admin">
      <BackTitle title={m.id} subtitle={`${m.label} · ${m.transformer_id} · Malolos, Bulacan`} onBack={onBack}>
        <MeterStatus status={meterStatus(m)} />
        <button className="page-secondary" onClick={() => onMessage(m.id)}><Icon name="message" size={16} /> Message customer</button>
        <button className="page-primary" onClick={() => onFieldTask(m)}>Create field task</button>
      </BackTitle>
      <div className="device-health">
        {[['Today', kwh(m.today_kwh), 'Since midnight'], ['Signal', sigText(m.signal_quality), `quality ${m.signal_quality ?? '—'}`], ['Gateway', `GW-${m.transformer_id}`, 'Connected'], ['Anomaly score', (m.anomaly_score ?? 0).toFixed(2), m.anomaly_type ? TYPE_LABEL[m.anomaly_type] : 'Normal'], ['Cycle used', c ? kwh(c.used_kwh) : '—', c ? `day ${c.cycle.day}/${c.cycle.days}` : '']].map(([l, v, n], i) => (
          <div key={l}><span>{l}</span><strong>{v}</strong><small>{i === 2 && <i />} {n}</small></div>
        ))}
      </div>
      <section className="detail-chart-panel">
        <header className="panel-header">
          <div><h2>Usage, this cycle</h2><p>kWh per day from verified readings, with the cycle average</p></div>
          <div className="legend"><span><i className="actual" /> Actual</span><span><i className="forecast" /> Cycle average</span></div>
        </header>
        <UsageChart daily={daily} />
      </section>
      <div className="meter-detail-lower">
        <section className="detail-list-panel">
          <header><h2>Event log</h2></header>
          {!mine.length && <p className="ops-empty">No alerts on this meter.</p>}
          {mine.map((a) => (
            <div className="event-row" key={a.id}>
              <i className={severityOf(a.score)}><Icon name="alert" size={15} /></i>
              <span><b>{TYPE_LABEL[a.type] ?? a.type}</b><small>{a.ops_text}</small></span><em>{simTime(a.detected_at)}</em>
            </div>
          ))}
        </section>
        <section className="detail-list-panel">
          <header><h2>Sealed records</h2></header>
          {!ledger.length && <p className="ops-empty">No snapshots sealed yet. Seal one from Records.</p>}
          {ledger.slice(0, 3).map((e) => (
            <div className="sealed-row" key={e.id}>
              <i><Icon name="record" size={15} /></i>
              <span><b>{e.cycle_id} snapshot</b><small>{simTime(e.as_of)} · EGovChain {sourceLabel(e.chain_source)}</small></span>
              <strong>{kwh(e.summary.kwh)}</strong>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}

// ------------------------------------------------------------------ unusual activity
const TABS = [['open', 'Open'], ['escalated', 'In progress'], ['resolved', 'Closed']];
const setAlertStatus = (id, status) => api(`/alerts/${id}`, { ...staff, method: 'PATCH', body: { status } });

function AlertActions({ a, onChange }) {
  const [busy, setBusy] = useState(false);
  const act = async (status) => { setBusy(true); try { onChange(await setAlertStatus(a.id, status)); } finally { setBusy(false); } };
  return a.status === 'open' ? (
    <div className="ops-row-actions">
      <button className="page-primary" disabled={busy} onClick={() => act('escalated')}>Escalate to field</button>
      <button className="page-secondary" disabled={busy} onClick={() => act('resolved')}>Resolve</button>
    </div>
  ) : (
    <div className="ops-row-actions">
      <small>{a.status === 'resolved' ? 'Resolved' : 'Escalated'}</small>
      <button className="page-secondary" disabled={busy} onClick={() => act('open')}>Reopen</button>
    </div>
  );
}

function AlertDetail({ a, onChange }) {
  const ctx = a.context ?? {};
  return (
    <div className="ops-alert-detail">
      <p>{a.ops_text}</p>
      <small>
        {a.audience === 'ops' ? 'Ops only, customer not messaged' : `Customer messaged via EMessage (${sourceLabel(a.emessage_source)})`}
        {ctx.corroborating_reports > 0 && ` · ${ctx.corroborating_reports} customer report${ctx.corroborating_reports > 1 ? 's' : ''} on this transformer`}
        {ctx.likely_meter && ` · likely meter ${ctx.likely_meter}`}
      </small>
      <AlertActions a={a} onChange={onChange} />
    </div>
  );
}

function UnusualPage({ alerts, flash, onChange, onOpenCase, notify }) {
  const [tab, setTab] = useState('open');
  const [q, setQ] = useState('');
  const [sev, setSev] = useState('all');
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState([]);
  const rows = useMemo(() => alerts.filter((a) => a.status === tab && (sev === 'all' || severityOf(a.score) === sev)
    && (!q || `${a.meter_id} ${a.transformer_id} ${TYPE_LABEL[a.type] ?? a.type}`.toLowerCase().includes(q.toLowerCase()))), [alerts, tab, sev, q]);
  useEffect(() => { setPage(1); setSel([]); }, [tab, sev, q]);
  const pageRows = rows.slice((page - 1) * PAGE, page * PAGE);
  const assign = async () => {
    const ids = sel.filter((id) => alerts.find((a) => a.id === id)?.status === 'open');
    if (!ids.length) { notify('Select open events first.'); return; }
    for (const id of ids) onChange(await setAlertStatus(id, 'escalated'));
    setSel([]); notify(`${ids.length} event${ids.length > 1 ? 's' : ''} escalated to the field team.`);
  };
  const exportQueue = () => downloadCsv('unusual-activity.csv', [['id', 'severity', 'type', 'meter', 'transformer', 'confidence', 'detected', 'status', 'customer_messaged'], ...rows.map((a) => [a.id, severityOf(a.score), TYPE_LABEL[a.type] ?? a.type, a.meter_id ?? '', a.transformer_id ?? '', `${Math.round(a.score * 100)}%`, new Date(a.detected_at).toISOString(), a.status, a.audience === 'ops' ? 'no' : 'yes'])]);
  return (
    <main className="intelligence-page">
      <PageTools title="Unusual activity" description="Signals for review, not findings. Alerts to customers go out via EMessage.">
        <button className="page-secondary" onClick={exportQueue}>Export queue</button>
        <button className="page-primary" onClick={assign}>Assign selected</button>
      </PageTools>
      <section className="table-panel unusual-panel">
        <div className="queue-tabs">
          {TABS.map(([k, l]) => <button className={tab === k ? 'active' : ''} onClick={() => setTab(k)} key={k}>{l} <b>{alerts.filter((a) => a.status === k).length}</b></button>)}
          <label><Icon name="search" size={16} /><input placeholder="Search activity" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          <button className="filter-button" onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters}>Filters {sev !== 'all' && <span>1</span>}</button>
        </div>
        {showFilters && (
          <div className="ops-filter-panel">
            <label><span>Severity</span><select className="ops-select" value={sev} onChange={(e) => setSev(e.target.value)}><option value="all">All severities</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
            <button className="page-secondary" onClick={() => setSev('all')}>Clear filters</button>
          </div>
        )}
        <div className="queue-table ops-queue">
          <div className="queue-row queue-head"><span>Severity</span><span>Type</span><span>Subject</span><span>Confidence</span><span>Detected</span><span>Customer</span><span>Status</span></div>
          {!rows.length && <p className="ops-empty">{tab === 'open' ? 'Nothing to review. Inject an event from Settings and watch it arrive here.' : 'No alerts in this state.'}</p>}
          {pageRows.map((a) => (
            <div className={`ops-alert ${a.id === flash ? 'new' : ''}`} key={a.id}>
              <div className="queue-row">
                <span className="ops-sev-cell"><input type="checkbox" aria-label={`Select event ${a.id}`} checked={sel.includes(a.id)} onChange={() => setSel(sel.includes(a.id) ? sel.filter((x) => x !== a.id) : [...sel, a.id])} /><Severity level={severityOf(a.score)} /></span>
                <button className="case-link" onClick={() => onOpenCase(a.id)}>{TYPE_LABEL[a.type] ?? a.type}</button>
                <strong>{a.meter_id ?? a.transformer_id}</strong>
                <span><b className="confidence">{Math.round(a.score * 100)}%</b></span>
                <span>{simTime(a.detected_at)}</span>
                <span>{a.audience === 'ops' ? 'Not messaged' : 'Messaged'}</span>
                <span><i className={`queue-status ${a.status === 'open' ? 'open' : 'progress'}`}>{a.status === 'open' ? 'Open' : cap(a.status)}</i></span>
              </div>
              <AlertDetail a={a} onChange={onChange} />
            </div>
          ))}
        </div>
        <Pagination page={page} setPage={setPage} total={rows.length} label={`${TABS.find(([k]) => k === tab)[1].toLowerCase()} events`} />
      </section>
    </main>
  );
}

function CaseDetailPage({ id, alerts, meters, onChange, onBack, onMessage, notify }) {
  const a = alerts.find((x) => x.id === id);
  const [c, setC] = useState(null);
  const [notes, setNotes] = useState([]);
  useEffect(() => { if (a?.meter_id) api(`/meters/${a.meter_id}/consumption`).then(setC).catch(() => setC(null)); }, [a?.meter_id]);
  if (!a) return <main className="intelligence-page"><BackTitle title="Case not found" subtitle="" onBack={onBack} /></main>;
  const subject = meters.find((m) => m.id === a.meter_id);
  const neighbors = meters.filter((m) => m.transformer_id === (subject?.transformer_id ?? a.transformer_id) && m.id !== a.meter_id).slice(0, 5);
  const top = Math.max(0.1, subject?.today_kwh ?? 0, ...neighbors.map((n) => n.today_kwh ?? 0));
  const ctx = a.context ?? {};
  const act = async (status, msg) => { onChange(await setAlertStatus(a.id, status)); notify(msg); };
  const log = [
    ['Event detected', a.ops_text, a.detected_at, 'alert'],
    ['Case created', 'Added to the unusual activity queue', a.created_at ?? a.detected_at, 'report'],
    ...(a.audience !== 'ops' ? [['Customer messaged', `Sent via EMessage (${sourceLabel(a.emessage_source)})`, a.created_at ?? a.detected_at, 'message']] : []),
    ...(a.status !== 'open' ? [[a.status === 'resolved' ? 'Closed' : 'Escalated to field', `Status is now ${a.status}`, Date.now(), 'check']] : []),
    ...notes.map((n) => ['Note added', n.text, n.at, 'record']),
  ];
  const addNote = () => { const text = window.prompt('Add a note to this case'); if (text?.trim()) setNotes([...notes, { text: text.trim(), at: Date.now() }]); };
  return (
    <main className="intelligence-page detail-page-admin case-detail">
      <BackTitle title={TYPE_LABEL[a.type] ?? a.type} subtitle={`${a.meter_id ?? a.transformer_id} · Detected ${simTime(a.detected_at)}`} onBack={onBack}>
        <Severity level={severityOf(a.score)} />
        <button className="page-secondary" onClick={() => act('resolved', 'Marked as expected and closed.')}>Mark as expected</button>
        <button className="page-secondary" onClick={() => act('escalated', 'Inspection team requested (escalated to field).')}>Send inspection team</button>
        {a.meter_id && <button className="page-primary" onClick={() => onMessage(a.meter_id)}><Icon name="message" size={15} /> Message customer</button>}
      </BackTitle>
      <div className="case-figures">
        <div><span>Model confidence</span><strong>{Math.round(a.score * 100)}%</strong><small className={severityOf(a.score) === 'high' ? 'normal-text' : ''}>{severityOf(a.score) === 'high' ? 'High confidence' : 'For review'}</small></div>
        <div><span>Status</span><strong style={{ fontSize: 22 }}>{TABS.find(([k]) => k === a.status)?.[1] ?? cap(a.status)}</strong><small>{a.audience === 'ops' ? 'Ops only, customer not messaged' : `Customer messaged (${sourceLabel(a.emessage_source)})`}</small></div>
        <div><span>Flagged before</span><strong>{alerts.filter((x) => x.id !== a.id && x.meter_id && x.meter_id === a.meter_id).length}</strong><small>{ctx.corroborating_reports > 0 ? `${ctx.corroborating_reports} customer report(s) on this transformer` : 'Other alerts on this meter'}</small></div>
        <div className="reason"><span>Why this was flagged</span><p>{a.ops_text}</p></div>
      </div>
      <div className="case-charts">
        <section className="detail-chart-panel">
          <header className="panel-header">
            <div><h2>Usage around the event</h2><p>Daily readings this cycle</p></div>
            <span className="verified-label"><Icon name="record" size={14} />Verified readings</span>
          </header>
          {a.meter_id ? <UsageChart daily={c?.daily ?? []} anomaly /> : <p className="ops-empty">This alert is for a transformer, not a single meter. See Forecasts for its energy balance.</p>}
        </section>
        <section className="neighbor-panel">
          <header className="panel-header"><div><h2>Neighbor comparison</h2><p>Today's usage on {subject?.transformer_id ?? a.transformer_id}</p></div></header>
          <div className="neighbor-chart">
            {neighbors.map((n, i) => <div key={n.id}><i style={{ height: `${Math.max(4, ((n.today_kwh ?? 0) / top) * 100)}%` }} /><span>N{i + 1}</span></div>)}
            {subject && <div className="subject"><i style={{ height: `${Math.max(4, ((subject.today_kwh ?? 0) / top) * 100)}%` }} /><span>{subject.id}</span></div>}
          </div>
          <p>{subject ? `${subject.id} used ${kwh(subject.today_kwh)} today; neighbors ${neighbors.map((n) => (n.today_kwh ?? 0).toFixed(1)).join(', ')} kWh.` : 'No single meter to compare.'}</p>
        </section>
      </div>
      <section className="activity-log">
        <header><h2>Activity log</h2><button onClick={addNote}>Add note</button></header>
        {log.map(([title, text, time, icon], i) => (
          <div key={i}><i><Icon name={icon} size={15} /></i><span><b>{title}</b><small>{text}</small></span><em>{simTime(time)}</em></div>
        ))}
      </section>
      <AlertActions a={a} onChange={onChange} />
    </main>
  );
}

// ------------------------------------------------------------------ forecasts
function ForecastsPage({ transformers, meters, notify }) {
  const STEP = 15 * 60 * 1000;
  const [range, setRange] = useState('7 days');
  const [bills, setBills] = useState(null);
  useEffect(() => {
    if (!meters.length) return undefined;
    let stop = false;
    // Straight-line cycle estimate from usage so far, priced by the pure /bill-estimates endpoint.
    // (Not /projection: that records what a customer was shown, which feeds the EGovChain snapshot.)
    Promise.allSettled(meters.map(async (m) => {
      const c = await api(`/meters/${m.id}/consumption`);
      const est = (c.used_kwh / Math.max(1, c.cycle.day)) * c.cycle.days;
      const b = await api('/bill-estimates', { method: 'POST', body: { kwh: Math.round(est * 100) / 100 } });
      return { meter_id: m.id, kwh: est, bill: { base: b.total } };
    })).then((rs) => { if (!stop) setBills(rs.filter((r) => r.status === 'fulfilled').map((r) => r.value)); });
    return () => { stop = true; };
  }, [meters.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const base = (bills ?? []).map((b) => b.bill.base);
  const lo = base.length ? Math.floor(Math.min(...base) / 100) * 100 : 0;
  const hi = base.length ? Math.ceil((Math.max(...base) + 1) / 100) * 100 : 0;
  const BINS = 10; const w = Math.max(100, (hi - lo) / BINS);
  const hist = Array.from({ length: BINS }, (_, i) => base.filter((v) => v >= lo + i * w && v < lo + (i + 1) * w + (i === BINS - 1 ? 1 : 0)).length);
  const hmax = Math.max(1, ...hist);
  const acc = forecastAccuracy(meters);
  const accSeries = [...meters].filter((m) => m.deviation_pct != null).sort((a, b) => a.id.localeCompare(b.id)).map((m) => Math.max(0, 100 - Math.abs(m.deviation_pct)));
  const accPath = accSeries.length > 1 ? accSeries.map((v, i) => `${i ? 'L' : 'M'}${(i / (accSeries.length - 1)) * 330} ${110 - (v / 100) * 100}`).join(' ') : '';
  const totalBase = base.reduce((s, v) => s + v, 0);
  const byDt = transformers.map((t) => {
    const ms = meters.filter((m) => m.transformer_id === t.id);
    return { t, n: ms.length, load: ms.reduce((s, m) => s + (m.today_kwh ?? 0), 0), gap: t.balance?.gap_ratio, base: t.balance?.baseline, flag: t.balance?.flag };
  }).sort((a, b) => (b.gap ?? -1) - (a.gap ?? -1));
  const flagged = [...meters].filter((m) => m.anomaly_score != null).sort((a, b) => b.anomaly_score - a.anomaly_score).slice(0, 5);
  const exportForecast = () => downloadCsv('forecast-bills.csv', [['meter_id', 'estimated_cycle_kwh', 'estimated_bill_php'], ...(bills ?? []).map((b) => [b.meter_id, b.kwh.toFixed(2), b.bill.base])]);
  return (
    <main className="intelligence-page forecasts-page">
      <PageTools title="Demand forecasts" description="Forecast-based signals: transformer balance, projected customer bills and per-meter scores">
        <select className="area-select" aria-label="Area" defaultValue="malolos"><option value="malolos">Malolos, Bulacan</option></select>
        <div className="range-toggle">
          {['7 days', '30 days'].map((r) => <button className={range === r ? 'active' : ''} onClick={() => setRange(r)} key={r}>Next {r}</button>)}
        </div>
      </PageTools>
      {transformers.map((t) => {
        const b = t.balance;
        const points = (b?.series ?? []).map((p) => ({ label: simTime(b.ts + p.i * STEP), value: p.gap_ratio }));
        return (
          <section className="forecast-main-panel" key={t.id}>
            <header className="panel-header">
              <div><h2>{t.id} energy balance</h2><p>Unbilled energy gap across {t.meters} meters</p></div>
              <div className="forecast-summary"><span>Gap now</span><b>{b ? pct(b.gap_ratio) : '—'}</b><small>baseline {b ? pct(b.baseline) : '—'}</small></div>
            </header>
            {b ? <RatioLine points={points} reference={b.baseline} referenceLabel="baseline" title={`${t.id} unbilled energy gap`} /> : <p className="ops-empty">Waiting for live readings…</p>}
          </section>
        );
      })}
      <div className="forecast-lower-grid">
        <section className="forecast-card bill-histogram">
          <header>
            <div><h2>Predicted customer bills</h2><p>Straight-line estimate for the current cycle ({range} toggle applies to demand views only)</p></div>
            <b>{bills ? `${bills.length} accounts · ${php(totalBase)}` : 'Loading…'}</b>
          </header>
          <div className="histogram">
            {hist.map((n, i) => (
              <div key={i} title={`${php(lo + i * w)} to ${php(lo + (i + 1) * w)}: ${n} accounts`}>
                <i style={{ height: `${(n / hmax) * 100}%` }} /><span>{i % 2 === 0 ? php(lo + i * w) : ''}</span>
              </div>
            ))}
          </div>
        </section>
        <section className="forecast-card accuracy-panel">
          <header>
            <div><h2>Forecast accuracy</h2><p>Per meter, latest forecast vs actual</p></div>
            <strong>{acc == null ? '—' : `${acc.toFixed(1)}%`}</strong>
          </header>
          <svg viewBox="0 0 330 110" preserveAspectRatio="none">
            {accPath && <path d={accPath} />}
            <path className="accuracy-guide" d="M0 15H330" />
          </svg>
          <div><span>{meters[0]?.id ?? ''}</span><span>{meters[meters.length - 1]?.id ?? ''}</span></div>
        </section>
      </div>
      <section className="growth-table">
        <header>
          <div><h2>Feeders ranked by unbilled energy gap</h2><p>Highest gap first. A gap above baseline is a signal to inspect, not a finding.</p></div>
          <button onClick={exportForecast}>Export forecast</button>
        </header>
        <div className="growth-head"><span>Rank</span><span>Feeder</span><span>Connected meters</span><span>Load today</span><span>Gap now</span><span>Baseline</span></div>
        {byDt.map((r, i) => (
          <div className="growth-row" key={r.t.id}>
            <span>{i + 1}</span><span>{r.t.id}</span><span>{r.n}</span><span>{kwh(r.load)}</span><span className={r.flag ? 'growth warning-text' : 'growth'}>{r.gap == null ? '—' : pct(r.gap)}</span><span>{r.base == null ? '—' : pct(r.base)}</span>
          </div>
        ))}
      </section>
      <section className="growth-table">
        <header><div><h2>Highest anomaly scores</h2><p>From each meter's latest forecast</p></div><button onClick={() => notify('Per-meter scores are included in the Meters export.')}>About scores</button></header>
        <div className="growth-head"><span>Rank</span><span>Meter</span><span>Transformer</span><span>Today</span><span>Score</span><span>Signal</span></div>
        {flagged.map((m, i) => (
          <div className="growth-row" key={m.id}>
            <span>{i + 1}</span><span>{m.id}</span><span>{m.transformer_id}</span><span>{kwh(m.today_kwh)}</span><span className="growth">{m.anomaly_score.toFixed(2)}</span><span>{m.anomaly_type ? TYPE_LABEL[m.anomaly_type] : 'Normal'}</span>
          </div>
        ))}
      </section>
    </main>
  );
}

// ------------------------------------------------------------------ reports
const REPORT_TABS = [['all', 'All'], ['new', 'New'], ['triaged', 'Triaged'], ['dispatched', 'Crew dispatched'], ['closed', 'Closed']];

function ReportsPage({ reports, onChange }) {
  const [tab, setTab] = useState('all');
  const set = async (id, status) => onChange(await api(`/reports/${id}`, { ...staff, method: 'PATCH', body: { status } }));
  const rows = reports.filter((r) => tab === 'all' || r.status === tab);
  return (
    <main className="intelligence-page">
      <PageTools title="Customer reports" description={`${reports.filter((r) => r.status === 'new').length} new · filed from the customer app's Report tab, ticketed via EReport`} />
      <section className="table-panel">
        <div className="queue-tabs">
          {REPORT_TABS.map(([k, l]) => <button className={tab === k ? 'active' : ''} onClick={() => setTab(k)} key={k}>{l} <b>{k === 'all' ? reports.length : reports.filter((r) => r.status === k).length}</b></button>)}
        </div>
        {!rows.length && <p className="ops-empty">No reports here. Customers file them from the app's Report tab.</p>}
        <ol className="ops-report-list">
          {rows.map((r) => (
            <li key={r.id} className={r.status}>
              <div className="ops-report-head">
                <strong>{CATEGORY_LABEL[r.category]}</strong>
                <span>{r.meter_id} · {r.transformer_id} · {wallTime(r.created_at)}</span>
              </div>
              {r.note && <p>“{r.note}”</p>}
              <div className="ops-report-foot">
                <small>{r.ereport_ticket} ({sourceLabel(r.ereport_source)})</small>
                <select className="ops-select" aria-label="Status" value={r.status} onChange={(e) => set(r.id, e.target.value)}>
                  <option value="new">New</option><option value="triaged">Triaged</option><option value="dispatched">Crew dispatched</option><option value="closed">Closed</option>
                </select>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}

// ------------------------------------------------------------------ messages (EMessage outbox)
function MessagesPage({ meters, meterId, setMeterId }) {
  const [msgs, setMsgs] = useState(null);
  useEffect(() => {
    if (!meters.length) return undefined;
    let stop = false;
    const ids = meterId ? [meterId] : meters.map((m) => m.id);
    Promise.allSettled(ids.map((id) => api(`/alerts?audience=customer&meter_id=${encodeURIComponent(id)}`))).then((rs) => {
      if (stop) return;
      setMsgs(rs.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).sort((a, b) => b.created_at - a.created_at));
    });
    return () => { stop = true; };
  }, [meters.length, meterId]); // eslint-disable-line react-hooks/exhaustive-deps
  const label = (id) => meters.find((m) => m.id === id)?.label ?? id;
  return (
    <main className="intelligence-page">
      <PageTools title="Messages" description="Customer notifications sent through EMessage. They go out automatically when an alert is raised for the customer.">
        <select className="ops-select" aria-label="Customer" value={meterId ?? ''} onChange={(e) => setMeterId(e.target.value || null)}>
          <option value="">All customers</option>
          {meters.map((m) => <option key={m.id} value={m.id}>{m.id} · {m.label}</option>)}
        </select>
      </PageTools>
      <section className="detail-list-panel">
        <header><h2>{meterId ? `${label(meterId)} (${meterId})` : 'Sent messages'}</h2></header>
        {msgs === null && <p className="ops-empty">Loading messages…</p>}
        {msgs?.length === 0 && <p className="ops-empty">No messages sent{meterId ? ' to this customer' : ''} yet. Inject a usage spike or flatline from Settings to trigger one.</p>}
        {msgs?.map((m) => (
          <div className="event-row" key={m.id}>
            <i className="info"><Icon name="message" size={15} /></i>
            <span><b>{m.title} · {label(m.meter_id)}</b><small>{m.customer_text}</small><small>{m.meter_id} · EMessage {sourceLabel(m.emessage_source)}</small></span>
            <em>{simTime(m.created_at)}</em>
          </div>
        ))}
      </section>
    </main>
  );
}

// ------------------------------------------------------------------ records (EGovChain)
function RecordsPage({ entries, onSealed, demo }) {
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState({});
  const [note, setNote] = useState(null);
  const seal = async () => { setBusy(true); try { onSealed(await api('/ledger-entries', { ...staff, method: 'POST' })); setNote(null); } catch (e) { setNote(e.message); } finally { setBusy(false); } };
  const verify = async (id) => {
    setResults((r) => ({ ...r, [id]: { pending: true } }));
    try { const v = await api(`/ledger-entries/${id}/verifications`, { method: 'POST' }); setResults((r) => ({ ...r, [id]: v })); } catch (e) { setResults((r) => ({ ...r, [id]: { error: e.message } })); }
  };
  const tamper = async (id) => {
    const t = await api('/demo/reading-edits', { ...staff, method: 'POST', body: { ledger_entry_id: id } });
    setNote(`Demo: changed ${t.meter_id}'s reading at ${simTime(t.ts)} from ${t.before} to ${t.after} kWh in the database. Verify again.`);
    setResults((r) => ({ ...r, [id]: undefined }));
  };
  return (
    <main className="intelligence-page">
      <PageTools title="Records" description="EGovChain audit: one hash per cycle snapshot, tamper-evident after recording">
        <button className="page-primary" onClick={seal} disabled={busy}>{busy ? 'Sealing…' : 'Seal cycle snapshot'}</button>
      </PageTools>
      {note && <p className="ops-note-box">{note}</p>}
      <section className="detail-list-panel">
        {!entries.length && <p className="ops-empty">No snapshots sealed yet.</p>}
        {entries.map((e) => {
          const v = results[e.id];
          return (
            <div className="sealed-row ops-sealed" key={e.id}>
              <i><Icon name="record" size={15} /></i>
              <span>
                <b>{e.cycle_id} · as of {simTime(e.as_of)}</b>
                <small>{e.summary.readings.toLocaleString()} readings · {kwh(e.summary.kwh)} · {e.summary.projections_shown} projections shown</small>
                <small title={e.hash}>sha256 {e.hash.slice(0, 16)}… · tx {e.chain_tx_id} ({sourceLabel(e.chain_source)})</small>
              </span>
              <div className="ops-row-actions">
                <button className="page-secondary" onClick={() => verify(e.id)}>Verify</button>
                {demo && <button className="page-secondary" onClick={() => tamper(e.id)}>Edit a reading (demo)</button>}
                {v?.pending && <small>Checking…</small>}
                {v?.error && <small className="warning-text">{v.error}</small>}
                {v && 'match' in v && (v.match ? <small className="normal-text">✓ Unchanged since recording</small> : <small className="warning-text">✕ Does not match the chain record</small>)}
              </div>
            </div>
          );
        })}
      </section>
    </main>
  );
}

// ------------------------------------------------------------------ settings
function SettingsPage({ system }) {
  const rows = [
    ['Prediction engine', system?.engine?.online ? 'Online' : 'Offline', system?.engine?.online ? 'Forecasts and scores live' : 'Scores unavailable'],
    ['eGov APIs', cap(system?.integrations?.mode ?? '—'), 'EMessage, EReport, EGovChain'],
    ['Billing rates', system?.rates?.verified ? 'Verified' : 'Illustrative', 'See backend/src/billing/rates.json'],
    ['Anomaly threshold', system?.anomaly_threshold ?? '—', 'Score above this raises an alert'],
    ['Billing cycle', system?.cycle ? `Day ${system.cycle.day}/${system.cycle.days}` : '—', system?.cycle?.id ?? ''],
    ['Demo mode', system?.demo_mode ? 'On' : 'Off', 'Reset and tamper demos'],
  ];
  return (
    <main className="intelligence-page">
      <PageTools title="Settings" description="System status and demo controls: inject events and drive the simulated clock" />
      <div className="device-health ops-settings">
        {rows.map(([l, v, n]) => <div key={l}><span>{l}</span><strong>{v}</strong><small>{n}</small></div>)}
      </div>
    </main>
  );
}

// ------------------------------------------------------------------ shell
function Dashboard({ onLogout }) {
  const [active, setActive] = useState('Overview');
  const [detail, setDetail] = useState(null); // { kind: 'meter'|'case', id }
  const [query, setQuery] = useState('');
  const [system, setSystem] = useState(null);
  const [meters, setMeters] = useState([]);
  const [transformers, setTransformers] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [reports, setReports] = useState([]);
  const [ledger, setLedger] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [flash, setFlash] = useState(null);
  const [msgMeter, setMsgMeter] = useState(null);
  const [toast, setToast] = useState(null);
  const lastRefresh = useRef(0);

  const notify = useCallback((msg) => { setToast(msg); clearTimeout(notify.t); notify.t = setTimeout(() => setToast(null), 4500); }, []);

  const refreshLive = useCallback(async () => {
    lastRefresh.current = Date.now();
    const [s, m, t] = await Promise.allSettled([api('/system'), api('/meters'), api('/transformers')]);
    if (s.status === 'fulfilled') setSystem(s.value);
    if (m.status === 'fulfilled') setMeters(m.value);
    if (t.status === 'fulfilled') setTransformers(t.value);
  }, []);

  useEffect(() => {
    refreshLive().then(() => setLoaded(true));
    api('/alerts?audience=ops', staff).then(setAlerts).catch(() => {});
    api('/reports', staff).then(setReports).catch(() => {});
    api('/ledger-entries').then(setLedger).catch(() => {});
    const t = setInterval(refreshLive, 10000);
    return () => clearInterval(t);
  }, [refreshLive]);

  const upsert = (setter) => (row) => setter((prev) => {
    const i = prev.findIndex((x) => x.id === row.id);
    if (i === -1) return [row, ...prev];
    const next = prev.slice(); next[i] = { ...prev[i], ...row }; return next;
  });

  useEvents({
    tick: () => { if (Date.now() - lastRefresh.current > 2000) refreshLive(); },
    alert: (a) => { if (a.audience === 'customer') return; setAlerts((prev) => { if (!prev.some((x) => x.id === a.id)) setFlash(a.id); return prev; }); upsert(setAlerts)(a); },
    report: upsert(setReports),
    ledger: upsert(setLedger),
  }, { alerts: { path: '/alerts?audience=ops', staff: true }, reports: true, ledger: true });

  const onAdvance = useCallback(() => { if (Date.now() - lastRefresh.current > 2000) refreshLive(); }, [refreshLive]);

  const go = (page) => { setActive(page); setDetail(null); };
  const openMeter = (id) => { setActive((a) => (a === 'Grid map' || a === 'Meters' ? a : 'Meters')); setDetail({ kind: 'meter', id }); };
  const openAlert = (id) => { setActive('Unusual activity'); setDetail({ kind: 'case', id }); };
  const messageCustomer = (id) => { setMsgMeter(id); go('Messages'); };
  const fieldTask = async (m) => {
    const open = alerts.filter((a) => a.meter_id === m.id && a.status === 'open');
    if (!open.length) { notify(`No open alerts on ${m.id}: nothing to dispatch. Field tasks are created from open alerts.`); return; }
    for (const a of open) upsert(setAlerts)(await setAlertStatus(a.id, 'escalated'));
    notify(`Field task created: ${open.length} alert${open.length > 1 ? 's' : ''} on ${m.id} escalated.`);
  };
  const data = { loaded, system, meters, transformers, alerts, reports };
  const counts = { alerts: alerts.filter((a) => a.status === 'open').length, reports: reports.filter((r) => r.status === 'new').length };

  let content;
  if (detail?.kind === 'meter') content = <MeterDetailPage id={detail.id} meters={meters} alerts={alerts} ledger={ledger} onBack={() => setDetail(null)} onMessage={messageCustomer} onFieldTask={fieldTask} />;
  else if (detail?.kind === 'case') content = <CaseDetailPage id={detail.id} alerts={alerts} meters={meters} onChange={upsert(setAlerts)} onBack={() => setDetail(null)} onMessage={messageCustomer} notify={notify} />;
  else if (active === 'Overview') content = <Overview data={data} go={go} openAlert={openAlert} />;
  else if (active === 'Grid map') content = <GridMapPage meters={meters} transformers={transformers} onOpenMeter={openMeter} onMessage={messageCustomer} />;
  else if (active === 'Meters') content = <MetersPage meters={meters} transformers={transformers} query={query} onOpenMeter={openMeter} onMessage={messageCustomer} refresh={refreshLive} notify={notify} />;
  else if (active === 'Unusual activity') content = <UnusualPage alerts={alerts} flash={flash} onChange={upsert(setAlerts)} onOpenCase={openAlert} notify={notify} />;
  else if (active === 'Forecasts') content = <ForecastsPage transformers={transformers} meters={meters} notify={notify} />;
  else if (active === 'Reports') content = <ReportsPage reports={reports} onChange={upsert(setReports)} />;
  else if (active === 'Messages') content = <MessagesPage meters={meters} meterId={msgMeter} setMeterId={setMsgMeter} />;
  else if (active === 'Records') content = <RecordsPage entries={ledger} onSealed={upsert(setLedger)} demo={system?.demo_mode} />;
  else content = <SettingsPage system={system} />;

  return (
    <main className="dashboard">
      <Sidebar active={active} onChange={go} onLogout={onLogout} counts={counts} />
      <section className="workspace">
        <Topbar title={detail ? (detail.kind === 'meter' ? 'Meters' : 'Unusual activity') : active} system={system} query={query} openAlerts={counts.alerts}
          onBell={() => go('Unusual activity')} onDate={() => notify(system?.cycle ? `Showing billing cycle ${system.cycle.id}, day ${system.cycle.day} of ${system.cycle.days}.` : 'Waiting for readings.')}
          setQuery={(q) => { setQuery(q); if (q && (active !== 'Meters' || detail)) { setActive('Meters'); setDetail(null); } }} />
        {content}
        {/* Always mounted: it also drives the simulated clock while the console is open. */}
        <DemoControls meters={meters} onAdvance={onAdvance} hidden={active !== 'Settings' || !!detail}
          onReset={() => { setAlerts([]); setReports([]); setLedger([]); refreshLive(); }} />
      </section>
      {toast && <div className="ops-toast" role="status" onClick={() => setToast(null)}>{toast}</div>}
    </main>
  );
}

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  return loggedIn ? <Dashboard onLogout={() => setLoggedIn(false)} /> : <Login onLogin={() => setLoggedIn(true)} />;
}
