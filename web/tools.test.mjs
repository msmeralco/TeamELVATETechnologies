// Sanity checks for the imported standalone tool pages (run: node --test web/tools.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const pages = { 'rf-twin': ['init', 'recalculateMesh', 'spawnGateway', 'openReport', 'refreshReport', 'exportReportCsv'], 'load-twin': ['init', 'recalculate', 'executeSolver'] };

for (const [name, fns] of Object.entries(pages)) {
  const html = fs.readFileSync(new URL(`./public/tools/${name}.html`, import.meta.url), 'utf8');
  test(`${name}: is plain HTML (no Colab header) with back link`, () => {
    assert.ok(html.startsWith('<!DOCTYPE html>'));
    assert.match(html, /id="backHome"/);
    assert.doesNotMatch(html, /lucide@latest/);
  });
  test(`${name}: inline scripts parse and define ${fns.join(', ')}`, () => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length > 0);
    for (const s of scripts) new vm.Script(s); // throws on syntax error
    for (const f of fns) assert.match(html, new RegExp(`function ${f}\\b`));
  });
}

test('load-twin custom-hours input accepts its own default', () => {
  const html = fs.readFileSync(new URL('./public/tools/load-twin.html', import.meta.url), 'utf8');
  const m = html.match(/id="custHours"[^>]*/)[0];
  const min = +m.match(/min="([\d.]+)"/)[1], step = +m.match(/step="([\d.]+)"/)[1], val = +m.match(/value="([\d.]+)"/)[1];
  assert.equal(((val - min) / step) % 1, 0);
});

test('landing page links to both tools', () => {
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /href="\/tools\/rf-twin\.html"/);
  assert.match(html, /href="\/tools\/load-twin\.html"/);
});
