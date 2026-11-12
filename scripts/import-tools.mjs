// Converts Colab-exported .py files (which are really HTML pages) into static pages under web/public/tools.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [, , ...pairs] = process.argv; // name=path.py ...
const back = '<a href="/" id="backHome" style="position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:2000;font:11px monospace;color:#a1a1aa;background:rgba(9,9,11,.85);border:1px solid #27272a;border-radius:999px;padding:4px 12px;text-decoration:none">&larr; Meralco Go home</a>\n';
for (const pair of pairs) {
  const [name, src] = pair.split('=');
  const t = fs.readFileSync(src, 'utf8');
  let h = t.slice(t.indexOf('<!DOCTYPE html>'));
  h = h.replace('https://unpkg.com/lucide@latest', 'https://unpkg.com/lucide@0.460.0/dist/umd/lucide.min.js');
  h = h.replace('id="custHours" required min="0.1"', 'id="custHours" required min="0.5"'); // step=0.5 made the default (4) invalid
  h = h.replace('/ 24 Meters</span>', '/ 18 Meters</span>'); // 18 simulated meters
  h = h.replace('</body>', back + '</body>');
  const out = path.join(root, 'web/public/tools', name + '.html');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, h);
  console.log('wrote', path.relative(root, out), h.length);
}
