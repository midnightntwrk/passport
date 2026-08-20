#!/usr/bin/env node
// Midnight Passport site checker — link/anchor sweep + data.js cross-refs.
// Run from the repo root: node site/check.js. Wired into the Pages deploy
// workflow as a gate: the deploy fails on any dangling link, anchor,
// cross-reference, nav drift, or missing deploy marker.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SITE = 'site';
const PAGES = ['index.html', 'demo.html', 'standards.html', 'architecture.html', 'plan.html'];
const STUBS = ['parallelisation.html', 'onboarding-mockup.html'];
let failures = 0;
function fail(msg) { failures++; console.log('FAIL  ' + msg); }

// Load data.js — our own checked-in file, but a vm sandbox captures
// window.PASSPORT_DATA without reaching for eval.
const dataSrc = fs.readFileSync(path.join(SITE, 'data.js'), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(dataSrc, sandbox);
const data = sandbox.window.PASSPORT_DATA;

const componentIds = new Set(data.components.map(c => c.id));
const promiseIds = new Set(data.promises.map(p => p.id));
const decisionIds = new Set(data.decisions.map(d => d.id));
const mipIds = new Set(data.mips.map(m => m.id));
const categoryIds = new Set(data.categories.map(c => c.id));
const expIds = new Set(data.experiments.map(e => e.id));
const phaseIds = new Set(data.demo_phases.map(p => p.id));

// ---- data.js cross-references ----
for (const c of data.components) {
  for (const d of (c.hard_deps || [])) if (!componentIds.has(d)) fail(`data: ${c.id} hard_dep ${d}`);
  for (const d of (c.associations || [])) if (!componentIds.has(d)) fail(`data: ${c.id} assoc ${d}`);
  for (const p of (c.serves || [])) if (!promiseIds.has(p)) fail(`data: ${c.id} serves ${p}`);
  if (!categoryIds.has(c.category)) fail(`data: ${c.id} category ${c.category}`);
}
for (const w of data.workstreams) if (!componentIds.has(w)) fail(`data: workstream ${w}`);
for (const w of data.core_scc) if (!componentIds.has(w)) fail(`data: core_scc ${w}`);
for (const d of data.decisions) {
  if (!componentIds.has(d.workstream)) fail(`data: decision ${d.id} workstream ${d.workstream}`);
  for (const c of (d.cascade_to || [])) if (!componentIds.has(c)) fail(`data: decision ${d.id} cascade ${c}`);
  if (!['resolved', 'partial', 'open'].includes(d.resolution)) fail(`data: decision ${d.id} resolution "${d.resolution}"`);
}
// The workstreams array is the single authority for open decisions; a
// per-component workstream flag would silently drift — reject it.
for (const c of data.components) if ('workstream' in c) fail(`data: ${c.id} carries a workstream flag (use data.workstreams)`);
for (const w of (data.waiting_on || [])) for (const c of (w.components || [])) if (!componentIds.has(c)) fail(`data: waiting_on "${w.party}" component ${c}`);
for (const r of data.reviews) if (!r.state) fail(`data: review "${r.label}" missing state`);
for (const cp of data.decision_couplings) {
  if (!decisionIds.has(cp.a) || !decisionIds.has(cp.b)) fail(`data: coupling ${cp.a}-${cp.b}`);
}
for (const m of data.milestones) {
  for (const c of (m.components || [])) if (!componentIds.has(c)) fail(`data: milestone "${m.title}" component ${c}`);
  for (const e of (m.evidence || [])) if (!expIds.has(e)) fail(`data: milestone "${m.title}" evidence ${e}`);
}
for (const n of data.next_steps) for (const c of (n.components || [])) if (!componentIds.has(c)) fail(`data: next_step "${n.title}" component ${c}`);
for (const m of data.mips) {
  const comps = m.components || (m.component ? [m.component] : []);
  for (const c of comps) if (!componentIds.has(c)) fail(`data: mip ${m.id} component ${c}`);
  for (const p of (m.promises || [])) if (!promiseIds.has(p)) fail(`data: mip ${m.id} promise ${p}`);
}
for (const r of data.reviews) if (!componentIds.has(r.target)) fail(`data: review target ${r.target}`);
for (const p of data.demo_phases) for (const c of (p.components || [])) if (!componentIds.has(c)) fail(`data: phase ${p.id} component ${c}`);
for (const s of data.demo_selections) if (!componentIds.has(s.component)) fail(`data: selection ${s.component}`);
for (const cx of data.crossovers) {
  for (const id of (cx.items || [])) {
    const ok = cx.kind === 'components' ? componentIds.has(id)
      : cx.kind === 'mips' ? mipIds.has(id)
      : cx.kind === 'experiments' ? expIds.has(id)
      : true;
    if (!ok) fail(`data: crossover ${cx.id} item ${id}`);
  }
}
for (const e of data.experiments) for (const c of (e.validates || [])) if (!componentIds.has(c)) fail(`data: experiment ${e.id} validates ${c}`);

// ---- Page link/anchor sweep ----
// JS-routed fragments: plan.html handles #C/#P/#Q via app.js; index.html
// forwards them to plan.html; standards.html generates id="<mip-id>" cards.
function idsIn(html) {
  const ids = new Set();
  for (const m of html.matchAll(/id="([^"$]+)"/g)) ids.add(m[1]);
  return ids;
}
const pageHtml = {}, pageIds = {};
for (const p of [...PAGES, ...STUBS]) {
  pageHtml[p] = fs.readFileSync(path.join(SITE, p), 'utf8');
  pageIds[p] = idsIn(pageHtml[p]);
}
function anchorOk(page, frag) {
  if (pageIds[page] && pageIds[page].has(frag)) return true;
  if ((page === 'plan.html' || page === 'index.html') &&
      (componentIds.has(frag) || promiseIds.has(frag) || decisionIds.has(frag))) return true;
  if (page === 'standards.html' && mipIds.has(frag)) return true;
  return false;
}
for (const p of PAGES) {
  const html = pageHtml[p];
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const url = m[1];
    if (/^(https?:|mailto:|data:)/.test(url)) continue;
    if (url.includes('${')) continue; // template literal inside inline script
    const [file, frag] = url.split('#');
    if (file) {
      const target = path.join(SITE, file);
      if (!fs.existsSync(target)) { fail(`${p}: missing target ${url}`); continue; }
      if (frag && file.endsWith('.html')) {
        const base = path.basename(file);
        if (pageHtml[base] === undefined) pageHtml[base] = fs.readFileSync(target, 'utf8'), pageIds[base] = idsIn(pageHtml[base]);
        if (!anchorOk(base, frag)) fail(`${p}: dangling anchor ${url}`);
      }
    } else if (frag) {
      if (!anchorOk(p, frag)) fail(`${p}: dangling anchor #${frag}`);
    }
  }
  // data-component/-promise/-decision attributes resolve
  for (const m of html.matchAll(/data-component="([^"$]+)"/g)) if (!componentIds.has(m[1])) fail(`${p}: data-component ${m[1]}`);
  for (const m of html.matchAll(/data-promise="([^"$]+)"/g)) if (!promiseIds.has(m[1])) fail(`${p}: data-promise ${m[1]}`);
  for (const m of html.matchAll(/data-decision="([^"$]+)"/g)) if (!decisionIds.has(m[1])) fail(`${p}: data-decision ${m[1]}`);
}

// ---- Nav consistency ----
const navRe = /<div class="navbar-links">([\s\S]*?)<\/div>/;
let navRef = null;
for (const p of PAGES) {
  const nav = (pageHtml[p].match(navRe) || [])[1] || '';
  const links = [...nav.matchAll(/href="([^"]+)"[^>]*>([^<]+)</g)].map(m => m[1] + '|' + m[2]);
  const sig = links.join(',');
  if (navRef === null) navRef = sig;
  else if (sig !== navRef) fail(`${p}: nav differs from index (${sig})`);
}

// ---- DEPLOY markers present on all real pages ----
for (const p of PAGES) {
  if (!pageHtml[p].includes('<!--DEPLOY-->')) fail(`${p}: missing DEPLOY marker`);
}

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('ALL CHECKS PASS');
