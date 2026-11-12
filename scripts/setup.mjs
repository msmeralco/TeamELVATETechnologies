// One-time setup: Python venv + deps, Node deps, web build.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const run = (cmd, args, cwd) => {
  console.log(`> ${cmd} ${args.join(' ')}   (${path.relative(root, cwd) || '.'})`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: win });
};

const engine = path.join(root, 'prediction-engine');
const venvPy = path.join(engine, '.venv', win ? 'Scripts/python.exe' : 'bin/python');
if (!fs.existsSync(venvPy)) run(win ? 'python' : 'python3', ['-m', 'venv', '.venv'], engine);
run(venvPy, ['-m', 'pip', 'install', '-q', '-r', 'requirements.txt'], engine);
run('npm', ['install', '--no-audit', '--no-fund'], path.join(root, 'backend'));
run('npm', ['install', '--no-audit', '--no-fund'], path.join(root, 'web'));
run('npm', ['run', 'build'], path.join(root, 'web'));
console.log('\nSetup done. Start the demo with: npm start');
