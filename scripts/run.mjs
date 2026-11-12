// Starts the local demo: prediction engine, backend, simulator clock driver (and Vite with --vite).
// Ctrl+C stops everything.
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load meralco-go/.env if present (gitignored). Values already set in the shell win.
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  const before = { ...process.env };
  process.loadEnvFile(envFile);
  Object.assign(process.env, before);
  console.log('Loaded .env');
}
const win = process.platform === 'win32';
const venvPy = path.join(root, 'prediction-engine', '.venv', win ? 'Scripts/python.exe' : 'bin/python');
const py = fs.existsSync(venvPy) ? venvPy : (win ? 'python' : 'python3');
const withVite = process.argv.includes('--vite');

if (!withVite && !fs.existsSync(path.join(root, 'web', 'dist'))) {
  console.warn('web/dist not found: run `npm run setup` (or `npm run build`) first, or use `npm run dev`.');
}

const procs = [
  ['engine', py, ['-m', 'uvicorn', 'app:app', '--port', '8000', '--log-level', 'warning'], 'prediction-engine'],
  ['backend', process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], 'backend'],
  ['sim', process.execPath, ['simulator.mjs'], 'simulator'],
];
if (withVite) procs.push(['web', process.execPath, [path.join(root, 'web', 'node_modules', 'vite', 'bin', 'vite.js')], 'web']);

// Fail fast with a clear message if an old instance still holds a port.
const ports = { 8000: 'engine', 4000: 'backend', ...(withVite ? { 5173: 'web' } : {}) };
const busy = (await Promise.all(Object.keys(ports).map((p) => new Promise((resolve) => {
  const s = net.createServer().once('error', () => resolve(p)).listen(Number(p), '127.0.0.1', () => s.close(() => resolve(null)));
})))).filter(Boolean);
if (busy.length) {
  console.error(`Port ${busy.join(', ')} already in use (${busy.map((p) => ports[p]).join(', ')}). Another Meralco Go instance is probably running:`
    + ' press Ctrl+C in its terminal, or find it with `netstat -ano | findstr ":8000 :4000"` and run `taskkill /PID <pid> /T /F`.');
  process.exit(1);
}

let stopping = false;
const children = procs.map(([name, cmd, args, cwd]) => {
  const c = spawn(cmd, args, { cwd: path.join(root, cwd), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `[${name}]`.padEnd(10);
  const out = (buf) => buf.toString().split(/\r?\n/).filter(Boolean).forEach((l) => console.log(tag, l));
  c.stdout.on('data', out); c.stderr.on('data', out);
  c.on('exit', (code) => {
    console.log(tag, `exited (${code})`);
    if (!stopping) {
      console.error(`\n${name} stopped unexpectedly; shutting the demo down. If a port is busy (4000, 8000${withVite ? ', 5173' : ''}), stop the old instance first.`);
      stop(1);
    }
  });
  return c;
});

console.log(`\nMeralco Go starting…\n  Customer app: http://localhost:${withVite ? 5173 : 4000}/customer/\n  Admin site:   http://localhost:${withVite ? 5173 : 4000}/admin/\n`);

function stop(code = 0) {
  stopping = true;
  // On Windows the venv python.exe is a launcher that spawns the real interpreter,
  // so a plain kill() leaves an orphan holding port 8000. Kill the whole tree.
  children.forEach((c) => {
    if (c.exitCode !== null) return;
    if (win) spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill();
  });
  process.exit(code);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
