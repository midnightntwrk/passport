// Midnight Passport — plan-page app.
// Renders the promises grid, the searchable components table, the macro
// dependency graph, and the decision cards on plan.html. Reads from
// window.PASSPORT_DATA (data.js); all side-panel rendering is delegated
// to window.PassportPanel (panel.js), which must be loaded first.

(function () {
  'use strict';

  const data = window.PASSPORT_DATA;
  if (!data) {
    console.error('PASSPORT_DATA not loaded');
    return;
  }
  const Panel = window.PassportPanel;
  if (!Panel) {
    console.error('PassportPanel not loaded — load panel.js before app.js');
    return;
  }

  // Quick lookups.
  const componentById = Object.fromEntries(data.components.map(c => [c.id, c]));
  const promiseById   = Object.fromEntries(data.promises.map(p => [p.id, p]));
  const categoryById  = Object.fromEntries(data.categories.map(c => [c.id, c]));
  const decisionById  = Object.fromEntries((data.decisions || []).map(d => [d.id, d]));
  const coreSet       = new Set(data.core_scc);
  const workstreamSet = new Set(data.workstreams);
  const escapeHtml    = Panel.escapeHtml;

  // Components-per-promise (precomputed).
  const componentsByPromise = {};
  data.promises.forEach(p => { componentsByPromise[p.id] = []; });
  data.components.forEach(c => {
    (c.serves || []).forEach(pid => {
      if (componentsByPromise[pid]) componentsByPromise[pid].push(c);
    });
  });

  // -------------------------------------------------------------------------
  // Promises grid. Clicks are handled by panel.js's [data-promise] delegation.
  // -------------------------------------------------------------------------

  function renderPromises() {
    const grid = document.getElementById('promisesGrid');
    if (!grid) return;
    grid.innerHTML = data.promises.map(p => {
      const compCount = (componentsByPromise[p.id] || []).length;
      return `
        <button class="promise-card" data-promise="${p.id}" type="button"
                aria-label="Open details for ${p.id} ${escapeHtml(p.name)}">
          <header class="promise-card-head">
            <span class="promise-id">${p.id}</span>
            <h3 class="promise-name">${escapeHtml(p.name)}</h3>
          </header>
          <p class="promise-statement">${escapeHtml(p.statement)}</p>
          <footer class="promise-card-foot">
            <span class="promise-meta">${p.invariants.length} invariants${compCount ? ` · ${compCount} components` : ''}</span>
            <span class="promise-arrow">→</span>
          </footer>
        </button>
      `;
    }).join('');
  }

  // -------------------------------------------------------------------------
  // Components table — searchable, filterable. Row clicks open the canvas
  // (via panel.js) and highlight the node in the macro graph.
  // -------------------------------------------------------------------------

  function buildHaystack(c) {
    const parts = [c.id, c.name, c.outcome || ''];
    (c.alternatives || []).forEach(a => { parts.push(a.label); parts.push(a.description); });
    (c.open_questions || []).forEach(q => parts.push(q));
    (c.failure_modes || []).forEach(f => parts.push(f));
    (c.serves || []).forEach(p => parts.push(p));
    return parts.join(' ').toLowerCase();
  }

  data.components.forEach(c => { c._haystack = buildHaystack(c); });

  function renderComponentsTable() {
    const body = document.getElementById('compTableBody');
    if (!body) return;
    body.innerHTML = data.components.map(c => {
      const cat = categoryById[c.category];
      const isWs = workstreamSet.has(c.id);
      const isDone = c.status === 'specified';
      const serves = (c.serves || []).map(p =>
        `<span class="serves-pill" title="${promiseById[p] ? escapeHtml(promiseById[p].name) : p}">${p}</span>`
      ).join('');
      const flag = isDone
        ? `<span class="done-badge" title="${escapeHtml(c.status_note || 'Specified — decision set in stone')}">✓ Specified</span>`
        : c.status === 'decided'
          ? `<span class="decided-badge" title="${escapeHtml(c.status_note || 'Decision set in stone; specification pending')}">● Decided</span>`
          : isWs ? '<span class="ws-badge">Open decision</span>' : '';
      return `
        <tr class="comp-row" data-component="${c.id}" tabindex="0"
            data-category="${escapeHtml(c.category)}"
            data-serves="${(c.serves || []).join(',')}"
            data-workstream="${isWs ? '1' : '0'}"
            data-specified="${isDone ? '1' : '0'}">
          <td class="comp-id">${c.id}</td>
          <td>
            <div class="comp-name">${escapeHtml(c.name)}</div>
            <div class="comp-outcome">${escapeHtml(c.outcome || '')}</div>
          </td>
          <td class="col-cat"><span class="comp-category">${cat ? escapeHtml(cat.label) : escapeHtml(c.category)}</span></td>
          <td class="col-serves"><div class="comp-serves-pills">${serves}</div></td>
          <td class="col-flag">${flag}</td>
        </tr>
      `;
    }).join('') + `
      <tr class="comp-row is-empty" id="compEmptyRow" hidden>
        <td colspan="5">No components match the current filters.</td>
      </tr>
    `;

    // panel.js's [data-component] delegation opens the canvas on click;
    // here we only add the graph highlight side-effect plus keyboard
    // activation (delegation is click-only).
    body.addEventListener('click', (e) => {
      const row = e.target.closest('.comp-row');
      if (!row || row.classList.contains('is-empty')) return;
      highlightInGraph(row.dataset.component);
    });
    body.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('.comp-row');
      if (!row || row.classList.contains('is-empty')) return;
      e.preventDefault();
      highlightInGraph(row.dataset.component);
      Panel.openComponent(row.dataset.component);
    });
  }

  function renderPromiseFilters() {
    const host = document.getElementById('promiseFilters');
    if (!host) return;
    host.innerHTML = data.promises.map(p =>
      `<button class="filter-pill" type="button" data-promise-filter="${p.id}" aria-pressed="false"
               title="${escapeHtml(p.name)} — ${escapeHtml(p.statement)}">${p.id}</button>`
    ).join('');
    host.addEventListener('click', (e) => {
      const pill = e.target.closest('.filter-pill');
      if (!pill) return;
      const pressed = pill.getAttribute('aria-pressed') === 'true';
      pill.setAttribute('aria-pressed', String(!pressed));
      applyComponentFilters();
    });
  }

  function renderCategoryOptions() {
    const sel = document.getElementById('categoryFilter');
    if (!sel) return;
    data.categories.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat.id;
      opt.textContent = cat.label;
      sel.appendChild(opt);
    });
  }

  function activePromiseFilters() {
    return Array.from(document.querySelectorAll('#promiseFilters .filter-pill[aria-pressed="true"]'))
      .map(b => b.dataset.promiseFilter);
  }

  function applyComponentFilters() {
    const search = (document.getElementById('compSearch').value || '').trim().toLowerCase();
    const promises = activePromiseFilters();
    const category = document.getElementById('categoryFilter').value;
    const wsOnly = document.getElementById('workstreamOnly').getAttribute('aria-pressed') === 'true';
    const doneEl = document.getElementById('specifiedOnly');
    const doneOnly = doneEl && doneEl.getAttribute('aria-pressed') === 'true';

    let visible = 0;
    document.querySelectorAll('#compTableBody .comp-row:not(.is-empty)').forEach(row => {
      const id = row.dataset.component;
      const c = componentById[id];
      if (!c) { row.hidden = true; return; }

      let show = true;
      if (search && !c._haystack.includes(search)) show = false;
      if (show && promises.length) {
        const has = promises.some(p => (c.serves || []).includes(p));
        if (!has) show = false;
      }
      if (show && category && c.category !== category) show = false;
      if (show && wsOnly && !workstreamSet.has(c.id)) show = false;
      if (show && doneOnly && !c.status) show = false;

      row.hidden = !show;
      if (show) visible++;
    });

    const empty = document.getElementById('compEmptyRow');
    if (empty) empty.hidden = visible !== 0;

    const counter = document.getElementById('resultCount');
    if (counter) {
      counter.textContent = visible === data.components.length
        ? `Showing all ${data.components.length} components`
        : `Showing ${visible} of ${data.components.length}`;
    }
  }

  function clearComponentFilters() {
    document.getElementById('compSearch').value = '';
    document.querySelectorAll('#promiseFilters .filter-pill').forEach(p => p.setAttribute('aria-pressed', 'false'));
    document.getElementById('categoryFilter').value = '';
    const ws = document.getElementById('workstreamOnly');
    if (ws) ws.setAttribute('aria-pressed', 'false');
    const done = document.getElementById('specifiedOnly');
    if (done) done.setAttribute('aria-pressed', 'false');
    applyComponentFilters();
  }

  // -------------------------------------------------------------------------
  // Decision cards — the five decision spaces as a static list. Clicks are
  // handled by panel.js's [data-decision] delegation.
  // -------------------------------------------------------------------------

  function renderDecisions() {
    const host = document.getElementById('decisionCards');
    if (!host) return;
    const couplings = data.decision_couplings || [];
    host.innerHTML = (data.decisions || []).map(d => {
      const badge = d.resolution === 'resolved'
        ? '<span class="decision-resolved">Resolved</span>'
        : d.resolution === 'partial'
          ? '<span class="decision-partial">Partially resolved</span>'
          : '<span class="decision-open">Open</span>';
      const coupled = couplings
        .filter(cp => cp.a === d.id || cp.b === d.id)
        .map(cp => (cp.a === d.id ? cp.b : cp.a) + ' — ' + cp.note);
      return `
        <button class="decision-card" data-decision="${d.id}" type="button">
          <div class="decision-card-head">
            <span class="decision-id">${d.id}</span>
            <span class="decision-ws">${escapeHtml(d.workstream)}</span>
            ${badge}
          </div>
          <h3 class="decision-q">${escapeHtml(d.question)}</h3>
          ${d.venue ? `<p class="decision-venue">${escapeHtml(d.venue)}</p>` : ''}
          <div class="decision-cascade">
            <span class="decision-cascade-label">Cascades to</span>
            ${(d.cascade_to || []).map(id => `<span class="serves-pill">${id}</span>`).join('')}
          </div>
          ${coupled.length ? `<div class="decision-couplings">Coupled: ${coupled.map(escapeHtml).join(' · ')}</div>` : ''}
        </button>
      `;
    }).join('');
  }

  // -------------------------------------------------------------------------
  // What remains — the open work, by lane.
  // -------------------------------------------------------------------------

  function renderNextSteps() {
    const host = document.getElementById('nextSteps');
    if (!host) return;
    host.innerHTML = (data.next_steps || []).map(n => `
      <div class="next-card">
        <span class="next-lane">${escapeHtml(n.lane)}</span>
        <h3 class="next-title">${escapeHtml(n.title)}</h3>
        <p class="next-detail">${escapeHtml(n.detail)}</p>
        ${(n.components || []).length
          ? `<div class="next-chips">${n.components.map(c =>
              `<button class="next-chip" data-component="${escapeHtml(c)}" type="button">${escapeHtml(c)}</button>`).join('')}</div>`
          : ''}
      </div>`).join('');
  }

  // -------------------------------------------------------------------------
  // Macro graph — Cytoscape.
  // -------------------------------------------------------------------------

  function buildMacroGraphElements() {
    const elements = [];

    // CORE compound parent — members nest inside via data.parent.
    elements.push({
      data: { id: 'CORE', label: 'CORE — identity-and-account core', kind: 'core' },
      classes: 'node-core',
    });

    data.components.forEach(c => {
      const classes = [];
      if (workstreamSet.has(c.id)) classes.push('node-workstream');
      else classes.push('node-component');
      if (c.status === 'specified') classes.push('node-specified');
      else if (c.status === 'decided') classes.push('node-decided');
      const nodeData = {
        id: c.id,
        label: c.id + '\n' + c.name,
        category: c.category,
        kind: 'component',
      };
      if (coreSet.has(c.id)) nodeData.parent = 'CORE';
      elements.push({ data: nodeData, classes: classes.join(' ') });
    });

    // Directed precedence edges entirely within CORE are skipped — the SCC's
    // mutual structure is conveyed by the co-design edges below.
    const seen = new Set();
    const addEdge = (src, tgt, edgeClass) => {
      if (coreSet.has(src) && coreSet.has(tgt)) return;
      const key = edgeClass.split(' ')[0] + ':' + src + '->' + tgt;
      if (seen.has(key)) return;
      seen.add(key);
      elements.push({
        data: { id: 'e:' + key, source: src, target: tgt },
        classes: edgeClass,
      });
    };

    data.components.forEach(c => {
      (c.hard_deps || []).forEach(dep => addEdge(c.id, dep, 'edge-hard'));
    });
    data.components.forEach(c => {
      (c.associations || []).forEach(dep => addEdge(c.id, dep, 'edge-assoc edge-hidden'));
    });
    (data.core_codesign || []).forEach(cd => {
      elements.push({
        data: { id: 'e:codesign:' + cd.a + '-' + cd.b, source: cd.a, target: cd.b },
        classes: 'edge-codesign',
      });
    });

    return elements;
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function buildCytoscapeStyle() {
    return [
      {
        selector: '.node-core',
        style: {
          'background-color': cssVar('--iog-volt-yellow'),
          'background-opacity': 0.22,
          'border-color': cssVar('--card-stroke'),
          'border-width': 2,
          'shape': 'round-rectangle',
          'label': 'data(label)',
          'text-wrap': 'wrap',
          'text-valign': 'top',
          'text-halign': 'center',
          'text-margin-y': -8,
          'font-family': 'Barlow, system-ui, sans-serif',
          'font-size': 13,
          'font-weight': 700,
          'color': cssVar('--text'),
          'padding': 24,
        },
      },
      {
        selector: '.node-component',
        style: {
          'background-color': cssVar('--card-fill'),
          'border-color': cssVar('--card-stroke-soft'),
          'border-width': 1.5,
          'shape': 'round-rectangle',
          'label': 'data(label)',
          'text-wrap': 'wrap',
          'text-max-width': 130,
          'text-valign': 'center',
          'text-halign': 'center',
          'font-family': 'Barlow, system-ui, sans-serif',
          'font-size': 11,
          'font-weight': 500,
          'color': cssVar('--text'),
          'width': 140,
          'height': 50,
          'padding': 8,
        },
      },
      {
        selector: '.node-workstream',
        style: {
          'background-color': cssVar('--bad-soft'),
          'border-color': cssVar('--iog-infared'),
          'border-width': 2,
          'shape': 'round-rectangle',
          'label': 'data(label)',
          'text-wrap': 'wrap',
          'text-max-width': 130,
          'text-valign': 'center',
          'text-halign': 'center',
          'font-family': 'Barlow, system-ui, sans-serif',
          'font-size': 11,
          'font-weight': 600,
          'color': cssVar('--text'),
          'width': 140,
          'height': 50,
          'padding': 8,
        },
      },
      // Decided components — decision set in stone, specification pending.
      {
        selector: '.node-decided',
        style: {
          'background-color': cssVar('--info-soft'),
          'border-color': cssVar('--info'),
          'border-width': 2,
        },
      },
      // Specified components — listed after both so it overrides.
      {
        selector: '.node-specified',
        style: {
          'background-color': cssVar('--good-soft'),
          'border-color': cssVar('--good'),
          'border-width': 2,
        },
      },
      {
        selector: '.edge-hard',
        style: {
          'curve-style': 'bezier',
          'width': 1.4,
          'line-color': cssVar('--line-strong'),
          'target-arrow-color': cssVar('--line-strong'),
          'target-arrow-shape': 'triangle',
          'arrow-scale': 1.2,
          'opacity': 0.7,
        },
      },
      {
        selector: '.edge-assoc',
        style: {
          'curve-style': 'bezier',
          'width': 1,
          'line-color': cssVar('--card-stroke-soft'),
          'line-style': 'dashed',
          'target-arrow-color': cssVar('--card-stroke-soft'),
          'target-arrow-shape': 'triangle',
          'arrow-scale': 1,
          'opacity': 0.55,
        },
      },
      {
        selector: '.edge-codesign',
        style: {
          'curve-style': 'bezier',
          'width': 1.8,
          'line-color': cssVar('--card-stroke'),
          'opacity': 0.55,
        },
      },
      { selector: '.edge-hidden', style: { 'display': 'none' } },
      {
        selector: 'node:active, node:selected',
        style: { 'border-color': cssVar('--iog-infared'), 'border-width': 3 },
      },
      { selector: 'node.faded', style: { 'opacity': 0.25 } },
      { selector: 'edge.faded', style: { 'opacity': 0.1 } },
      {
        selector: 'edge.highlight',
        style: {
          'line-color': cssVar('--iog-infared'),
          'target-arrow-color': cssVar('--iog-infared'),
          'opacity': 1,
          'width': 2.2,
          'z-index': 20,
        },
      },
    ];
  }

  function fcoseLayout() {
    return {
      name: 'fcose',
      quality: 'proof',
      animate: false,
      fit: true,
      padding: 36,
      nodeSeparation: 60,
      idealEdgeLength: 90,
      nodeRepulsion: 4500,
      gravity: 0.3,
      gravityRangeCompound: 1.5,
      gravityCompound: 5.0,
      nestingFactor: 0.1,
      numIter: 3500,
      randomize: true,
      tile: true,
      tilingPaddingVertical: 10,
      tilingPaddingHorizontal: 10,
    };
  }

  function fallbackLayout() {
    return {
      name: 'cose',
      animate: false,
      idealEdgeLength: 110,
      nodeOverlap: 12,
      randomize: true,
      componentSpacing: 60,
      nodeRepulsion: 8000,
      edgeElasticity: 80,
      gravity: 50,
      numIter: 1500,
      fit: true,
      padding: 30,
    };
  }

  function makeCytoscape(containerId, elements) {
    const container = document.getElementById(containerId);
    if (!container || !window.cytoscape) return null;
    const layout = window.cytoscapeFcose ? fcoseLayout() : fallbackLayout();
    return window.cytoscape({
      container: container,
      elements: elements,
      style: buildCytoscapeStyle(),
      layout: layout,
      minZoom: 0.3,
      maxZoom: 2.5,
    });
  }

  // -------------------------------------------------------------------------
  // Highlight helpers.
  // -------------------------------------------------------------------------

  let macroCy = null;

  function clearHighlights() {
    if (macroCy) macroCy.elements().removeClass('faded highlight');
  }

  function highlightNeighbourhood(node) {
    macroCy.elements().addClass('faded');
    const hood = node.closedNeighborhood();
    hood.removeClass('faded');
    hood.connectedEdges().filter(e =>
      e.source().id() === node.id() || e.target().id() === node.id()
    ).addClass('highlight');
    node.removeClass('faded');
  }

  function highlightInGraph(id, scroll) {
    if (!macroCy) return;
    const node = macroCy.getElementById(id);
    if (!node || !node.length) return;
    if (scroll) {
      const cyEl = document.getElementById('cy');
      if (cyEl) cyEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      macroCy.center(node);
    }
    clearHighlights();
    highlightNeighbourhood(node);
  }

  // Custom panel for the CORE compound node.
  function openCorePanel() {
    const members = data.core_scc.map(id => componentById[id]).filter(Boolean);
    const codesign = data.core_codesign || [];
    Panel.show(`
      <div class="panel-head">
        <div class="panel-kind">Identity-and-account core · SCC</div>
        <h3 class="panel-title">CORE</h3>
      </div>

      <section class="panel-section">
        <h4>What this is</h4>
        <p>The strongly-connected component at the centre of the dependency graph: ${members.length} components held together by ${codesign.length} mutual co-design relationships — each pair evolves at a shared interface. Drawn as a compound box in the macro view; click any member to open its individual canvas.</p>
      </section>

      <section class="panel-section">
        <h4>Members</h4>
        <ul class="panel-deps">
          ${members.map(c => `
            <li>
              <button class="dep-link" data-component="${c.id}" type="button">
                <span class="dep-id">${c.id}</span>
                <span class="dep-name">${escapeHtml(c.name)}</span>
              </button>
            </li>
          `).join('')}
        </ul>
      </section>

      <section class="panel-section">
        <h4>Co-design pairs</h4>
        <ul class="panel-list">
          ${codesign.map(cd => `
            <li><strong>${cd.a} ↔ ${cd.b}</strong> · ${escapeHtml(cd.note)}</li>
          `).join('')}
        </ul>
      </section>
    `);
  }

  // -------------------------------------------------------------------------
  // Wire-up.
  // -------------------------------------------------------------------------

  function init() {
    renderPromises();
    renderPromiseFilters();
    renderCategoryOptions();
    renderComponentsTable();
    renderDecisions();
    renderNextSteps();
    applyComponentFilters();

    const search = document.getElementById('compSearch');
    if (search) search.addEventListener('input', applyComponentFilters);
    const catSel = document.getElementById('categoryFilter');
    if (catSel) catSel.addEventListener('change', applyComponentFilters);
    const wsOnly = document.getElementById('workstreamOnly');
    if (wsOnly) wsOnly.addEventListener('click', () => {
      const pressed = wsOnly.getAttribute('aria-pressed') === 'true';
      wsOnly.setAttribute('aria-pressed', String(!pressed));
      applyComponentFilters();
    });
    const doneOnly = document.getElementById('specifiedOnly');
    if (doneOnly) doneOnly.addEventListener('click', () => {
      const pressed = doneOnly.getAttribute('aria-pressed') === 'true';
      doneOnly.setAttribute('aria-pressed', String(!pressed));
      applyComponentFilters();
    });
    const clearBtn = document.getElementById('clearFilters');
    if (clearBtn) clearBtn.addEventListener('click', clearComponentFilters);

    macroCy = makeCytoscape('cy', buildMacroGraphElements());

    if (macroCy) {
      macroCy.on('tap', (evt) => {
        if (evt.target === macroCy) {
          clearHighlights();
          Panel.close();
        }
      });
      macroCy.on('tap', 'node', (evt) => {
        const node = evt.target;
        clearHighlights();
        highlightNeighbourhood(node);
        if (node.id() === 'CORE') openCorePanel();
        else Panel.openComponent(node.id());
      });
    }

    // Associations toggle.
    const toggleAssoc = document.getElementById('toggleAssoc');
    if (toggleAssoc && macroCy) {
      toggleAssoc.addEventListener('click', () => {
        const pressed = toggleAssoc.getAttribute('aria-pressed') === 'true';
        const next = !pressed;
        toggleAssoc.setAttribute('aria-pressed', String(next));
        toggleAssoc.textContent = next ? 'Hide associations' : 'Show associations';
        if (next) macroCy.edges('.edge-assoc').removeClass('edge-hidden');
        else macroCy.edges('.edge-assoc').addClass('edge-hidden');
      });
    }

    // Clear graph highlights whenever the panel closes (panel.js owns the
    // close behaviour; these listeners only add the highlight side-effect).
    const closeBtn = document.getElementById('panelClose');
    if (closeBtn) closeBtn.addEventListener('click', clearHighlights);
    const backdrop = document.getElementById('panelBackdrop');
    if (backdrop) backdrop.addEventListener('click', clearHighlights);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') clearHighlights();
    });

    // Navigating dep-links inside the panel should also move the graph.
    const panelBody = document.getElementById('panelBody');
    if (panelBody) panelBody.addEventListener('click', (e) => {
      const depLinkEl = e.target.closest('[data-component]');
      if (depLinkEl) highlightInGraph(depLinkEl.dataset.component, true);
    });

    // Re-style the graph on theme change.
    const themeObs = new MutationObserver(() => {
      if (macroCy) macroCy.style(buildCytoscapeStyle());
    });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    // Deep-link via URL hash (plan.html#C5 / #P3 / #Q4).
    function applyHashRoute() {
      const raw = (window.location.hash || '').replace(/^#/, '').trim();
      if (!raw) return;
      const id = decodeURIComponent(raw);
      if (componentById[id]) {
        highlightInGraph(id, true);
        Panel.openComponent(id);
      } else if (promiseById[id]) {
        Panel.openPromise(id);
      } else if (decisionById[id]) {
        Panel.openDecision(id);
      }
    }
    applyHashRoute();
    window.addEventListener('hashchange', applyHashRoute);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
