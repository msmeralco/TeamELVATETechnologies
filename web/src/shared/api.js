import { useEffect, useRef } from 'react';

export async function api(path, { method = 'GET', body, staff = false } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // Mocked staff session for the demo (real staff login is out of scope).
  if (staff) headers['X-Demo-Role'] = 'staff';
  const r = await fetch(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await r.json().catch(() => null);
  if (!r.ok) {
    const err = new Error(json?.error?.message ?? `Request failed (${r.status})`);
    err.code = json?.error?.code;
    err.status = r.status;
    throw err;
  }
  return json.data;
}

const EVENT_NAMES = ['alert', 'report', 'ledger', 'tick'];
const POLL_MS = 3000;

/**
 * Live updates. Uses server-sent events where the server supports them (local
 * `npm start`). On Vercel /events answers 204 (no streams in serverless), the
 * EventSource closes, and we fall back to polling every ~3 s, fetching only rows
 * newer than the last seen id (and /system for the clock).
 *
 * handlers: { alert, report, ledger, tick }
 * poll (optional, read on every poll so it may change): {
 *   alerts: { path: '/alerts?audience=ops', staff: true } | null,
 *   reports: bool (staff), ledger: bool }
 */
export function useEvents(handlers, poll = {}) {
  const ref = useRef(handlers);
  const pollRef = useRef(poll);
  ref.current = handlers;
  pollRef.current = poll;
  useEffect(() => {
    let stopped = false;
    let timer = null;
    let es = null;
    const lastId = new Map(); // source key -> highest id seen
    let lastTs;

    const sources = () => {
      const p = pollRef.current;
      return [
        p.alerts && { key: `alert:${p.alerts.path}`, event: 'alert', path: p.alerts.path, staff: !!p.alerts.staff },
        p.reports && { key: 'report', event: 'report', path: '/reports', staff: true },
        p.ledger && { key: 'ledger', event: 'ledger', path: '/ledger-entries', staff: false },
      ].filter(Boolean);
    };

    async function pollOnce() {
      if (stopped || document.hidden) return;
      for (const src of sources()) {
        try {
          const first = !lastId.has(src.key);
          const sep = src.path.includes('?') ? '&' : '?';
          const rows = await api(first ? src.path : `${src.path}${sep}since_id=${lastId.get(src.key)}`, { staff: src.staff });
          const max = rows.reduce((m, r) => Math.max(m, r.id), lastId.get(src.key) ?? 0);
          lastId.set(src.key, max);
          // The first poll only learns the current high-water mark: the page already loaded those rows.
          if (!first) [...rows].reverse().forEach((r) => ref.current[src.event]?.(r));
        } catch { /* transient; retry next poll */ }
      }
      if (ref.current.tick) {
        try {
          const sys = await api('/system');
          if (lastTs !== undefined && sys.sim_ts !== lastTs) ref.current.tick({ ts: sys.sim_ts });
          lastTs = sys.sim_ts;
        } catch { /* ignore */ }
      }
    }

    function startPolling() {
      if (timer || stopped) return;
      pollOnce();
      timer = setInterval(pollOnce, POLL_MS);
    }

    if (typeof EventSource === 'undefined') startPolling();
    else {
      es = new EventSource('/api/v1/events');
      const listeners = EVENT_NAMES.map((n) => {
        const fn = (e) => ref.current[n]?.(JSON.parse(e.data));
        es.addEventListener(n, fn);
        return [n, fn];
      });
      // CLOSED = the server refused a stream (204) or the browser gave up: poll instead.
      es.onerror = () => { if (es.readyState === EventSource.CLOSED) startPolling(); };
      es.cleanup = () => listeners.forEach(([n, fn]) => es.removeEventListener(n, fn));
    }
    return () => { stopped = true; clearInterval(timer); if (es) { es.cleanup?.(); es.close(); } };
  }, []);
}
