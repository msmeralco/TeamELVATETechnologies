// Checks LorenzoKarl/Meralco-Hackathon for new commits since the last sync.
// Usage: node scripts/check-upstream.mjs            -> prints status, exit 0 (up to date) or 10 (new commits)
//        node scripts/check-upstream.mjs --mark     -> record current upstream HEAD as synced
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateFile = path.join(root, '.upstream-sync');
const URL_ = 'https://github.com/LorenzoKarl/Meralco-Hackathon.git';
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();

try { git('remote', 'get-url', 'upstream'); } catch { git('remote', 'add', 'upstream', URL_); }
git('fetch', '--quiet', 'upstream');
const head = git('rev-parse', 'upstream/main');
if (process.argv.includes('--mark')) { fs.writeFileSync(stateFile, head + '\n'); console.log('marked synced at', head.slice(0, 7)); process.exit(0); }

const last = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8').trim() : '';
if (last === head) { console.log('upstream up to date at', head.slice(0, 7)); process.exit(0); }
console.log(`NEW upstream commits (${last ? last.slice(0, 7) : 'none'} -> ${head.slice(0, 7)}):`);
console.log(git('log', '--format=%h %an %s', last ? `${last}..${head}` : head, '--', '.', ':!node_modules'));
console.log('Changed files:');
console.log(git('diff', '--name-status', last || '4b825dc642cb6eb9a060e54ef4d3f2cc7b4efc5', head, '--', '.', ':!node_modules'));
process.exit(10);
