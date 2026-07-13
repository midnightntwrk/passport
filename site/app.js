// Midnight Passport — site app
// Renders the promises section, the macro component dependency graph, and the
// decision-cascade graph. Reads from window.PASSPORT_DATA (see data.js).

(function () {
  'use strict';

  const data = window.PASSPORT_DATA;
  if (!data) {
    console.error('PASSPORT_DATA not loaded');
    return;
  }

  // Quick lookups.
  const componentById = Object.fromEntries(data.components.map(c => [c.id, c]));
  const promiseById   = Object.fromEntries(data.promises.map(p => [p.id, p]));
  const categoryById  = Object.fromEntries(data.categories.map(c => [c.id, c]));
  const decisionById  = Object.fromEntries((data.decisions || []).map(d => [d.id, d]));
  const coreSet       = new Set(data.core_scc);
  const workstreamSet = new Set(data.workstreams);

  // Components-per-promise (precomputed).
  const componentsByPromise = {};
  data.promises.forEach(p => { componentsByPromise[p.id] = []; });
  data.components.forEach(c => {
    (c.serves || []).forEach(pid => {
      if (componentsByPromise[pid]) componentsByPromise[pid].push(c);
    });
  });

  // -------------------------------------------------------------------------
  // Promises section.
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

    grid.addEventListener('click', (e) => {
      const card = e.target.closest('.promise-card');
      if (!card) return;
      const id = card.dataset.promise;
      const promise = promiseById[id];
      if (promise) openPanelForPromise(promise);
    });
  }

  // -------------------------------------------------------------------------
  // Components table (Section 2) — searchable, filterable.
  // -------------------------------------------------------------------------

  function buildHaystack(c) {
    const parts = [c.id, c.name, c.outcome || ''];
    (c.alternatives || []).forEach(a => { parts.push(a.label); parts.push(a.description); });
    (c.open_questions || []).forEach(q => parts.push(q));
    (c.failure_modes || []).forEach(f => parts.push(f));
    (c.serves || []).forEach(p => parts.push(p));
    return parts.join(' ').toLowerCase();
  }

  // Cache haystacks once.
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

    // Click / keyboard activation → open panel.
    body.addEventListener('click', (e) => {
      const row = e.target.closest('.comp-row');
      if (!row || row.classList.contains('is-empty')) return;
      const id = row.dataset.component;
      openPanelForComponentId(id);
    });
    body.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('.comp-row');
      if (!row || row.classList.contains('is-empty')) return;
      e.preventDefault();
      const id = row.dataset.component;
      openPanelForComponentId(id);
    });
  }

  function renderPromiseFilters() {
    const host = document.getElementById('promiseFilters');
    if (!host) return;
    host.innerHTML = data.promises.map(p =>
      `<button class="filter-pill" type="button" data-promise="${p.id}" aria-pressed="false"
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
      .map(b => b.dataset.promise);
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
    if (ws) {
      ws.setAttribute('aria-pressed', 'false');
    }
    const done = document.getElementById('specifiedOnly');
    if (done) {
      done.setAttribute('aria-pressed', 'false');
    }
    applyComponentFilters();
  }

  function openPanelForComponentId(id) {
    // Use the existing macro-graph node when available so highlighting still works.
    const c = componentById[id];
    if (!c) return;
    if (window._macroCy) {
      const node = window._macroCy.getElementById(id);
      if (node && node.length) {
        clearHighlights(window._macroCy);
        highlightNeighbourhood(window._macroCy, node);
        openPanelForNode(node);
        return;
      }
    }
    // Fallback: render the panel from raw data even if cy isn't ready.
    openPanelForNode({ id: () => id });
  }

  // -------------------------------------------------------------------------
  // Macro graph (Section 3) — Cytoscape.
  // -------------------------------------------------------------------------

  function buildMacroGraphElements() {
    const elements = [];

    // CORE compound parent — members nest inside via data.parent.
    elements.push({
      data: {
        id: 'CORE',
        label: 'CORE — identity-and-account core',
        kind: 'core',
      },
      classes: 'node-core',
    });

    // All component nodes. CORE members carry data.parent: 'CORE' so the
    // compound parent visually contains them.
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
      elements.push({
        data: nodeData,
        classes: classes.join(' '),
      });
    });

    // Edge insertion. Directed precedence edges entirely within CORE are
    // skipped — the SCC's mutual structure is conveyed by the dedicated
    // co-design edges below, which render without arrows.
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

    // Hard precedence edges.
    data.components.forEach(c => {
      (c.hard_deps || []).forEach(dep => addEdge(c.id, dep, 'edge-hard'));
    });

    // Association edges — initially hidden via .edge-hidden.
    data.components.forEach(c => {
      (c.associations || []).forEach(dep => addEdge(c.id, dep, 'edge-assoc edge-hidden'));
    });

    // CORE co-design edges (bidirectional, drawn without arrows).
    (data.core_codesign || []).forEach(cd => {
      elements.push({
        data: {
          id: 'e:codesign:' + cd.a + '-' + cd.b,
          source: cd.a,
          target: cd.b,
        },
        classes: 'edge-codesign',
      });
    });

    return elements;
  }

  // -------------------------------------------------------------------------
  // Cascade graph (Section 3) — Cytoscape.
  // -------------------------------------------------------------------------

  function buildCascadeGraphElements() {
    const elements = [];
    const decisions = data.decisions || [];
    const couplings = data.decision_couplings || [];

    // Question nodes.
    decisions.forEach(d => {
      elements.push({
        data: {
          id: d.id,
          label: d.workstream + '\n' + d.question,
          kind: 'question',
        },
        classes: 'node-question',
      });
    });

    // Component nodes — only include components touched by a cascade.
    const touchedComponents = new Set();
    decisions.forEach(d => {
      (d.cascade_to || []).forEach(c => touchedComponents.add(c));
    });
    touchedComponents.forEach(cid => {
      const c = componentById[cid];
      if (!c) return;
      const classes = [];
      if (workstreamSet.has(c.id)) classes.push('node-workstream');
      else classes.push('node-component');
      if (c.status === 'specified') classes.push('node-specified');
      else if (c.status === 'decided') classes.push('node-decided');
      elements.push({
        data: {
          id: c.id,
          label: c.id + '\n' + c.name,
          category: c.category,
          kind: 'component',
        },
        classes: classes.join(' '),
      });
    });

    // Cascade edges (question → component).
    decisions.forEach(d => {
      (d.cascade_to || []).forEach(cid => {
        elements.push({
          data: { id: 'e:cascade:' + d.id + '->' + cid, source: d.id, target: cid },
          classes: 'edge-cascade',
        });
      });
    });

    // Coupling edges (question ↔ question, no precedence — drawn dotted).
    couplings.forEach((cp, i) => {
      elements.push({
        data: {
          id: 'e:coupling:' + i + ':' + cp.a + '-' + cp.b,
          source: cp.a,
          target: cp.b,
          label: cp.note || '',
        },
        classes: 'edge-coupling',
      });
    });

    return elements;
  }

  // -------------------------------------------------------------------------
  // Cytoscape styling — shared across both graphs.
  // -------------------------------------------------------------------------

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function buildCytoscapeStyle() {
    return [
      // CORE compound parent — auto-sized to wrap its child component nodes.
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
      // Standard component nodes.
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
      // Workstream component nodes.
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
      // Decided components — decision set in stone, specification
      // pending; overrides the workstream/component colouring.
      {
        selector: '.node-decided',
        style: {
          'background-color': cssVar('--info-soft'),
          'border-color': cssVar('--info'),
          'border-width': 2,
        },
      },
      // Specified components — decision set in stone and drafted as a
      // standard; overrides the workstream/component colouring, hence
      // listed after both.
      {
        selector: '.node-specified',
        style: {
          'background-color': cssVar('--good-soft'),
          'border-color': cssVar('--good'),
          'border-width': 2,
        },
      },
      // Open-decision (question) nodes.
      {
        selector: '.node-question',
        style: {
          'background-color': cssVar('--warn-soft'),
          'border-color': cssVar('--warn'),
          'border-width': 2,
          'shape': 'round-rectangle',
          'label': 'data(label)',
          'text-wrap': 'wrap',
          'text-max-width': 170,
          'text-valign': 'center',
          'text-halign': 'center',
          'font-family': 'Barlow, system-ui, sans-serif',
          'font-size': 11,
          'font-weight': 700,
          'color': cssVar('--text'),
          'width': 180,
          'height': 64,
          'padding': 10,
        },
      },
      // Hard-precedence edges.
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
      // Association edges (dashed).
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
      // CORE co-design edges — bidirectional, no arrows, sit inside the
      // CORE compound parent.
      {
        selector: '.edge-codesign',
        style: {
          'curve-style': 'bezier',
          'width': 1.8,
          'line-color': cssVar('--card-stroke'),
          'opacity': 0.55,
        },
      },
      // Cascade edges in the decision graph (solid arrows).
      {
        selector: '.edge-cascade',
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
      // Coupling edges (dotted, no precedence — shown without arrow).
      {
        selector: '.edge-coupling',
        style: {
          'curve-style': 'bezier',
          'width': 1.2,
          'line-color': cssVar('--warn'),
          'line-style': 'dotted',
          'target-arrow-shape': 'none',
          'opacity': 0.7,
        },
      },
      // Hidden edges (display:none keeps layout stable).
      {
        selector: '.edge-hidden',
        style: { 'display': 'none' },
      },
      // Selection / hover.
      {
        selector: 'node:active, node:selected',
        style: {
          'border-color': cssVar('--iog-infared'),
          'border-width': 3,
        },
      },
      {
        selector: 'node.faded',
        style: { 'opacity': 0.25 },
      },
      {
        selector: 'edge.faded',
        style: { 'opacity': 0.1 },
      },
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

  function dagreLayout(opts) {
    const base = {
      name: 'dagre',
      rankDir: 'TB',
      nodeSep: 28,
      rankSep: 60,
      edgeSep: 14,
      animate: false,
      fit: true,
      padding: 30,
    };
    return Object.assign(base, opts || {});
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

  function fcoseLayout(opts) {
    const base = {
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
    return Object.assign(base, opts || {});
  }

  function makeCytoscape(containerId, elements, layoutOptions, preferredLayout) {
    const container = document.getElementById(containerId);
    if (!container || !window.cytoscape) return null;
    let layout;
    if (preferredLayout === 'fcose' && window.cytoscapeFcose) {
      layout = fcoseLayout(layoutOptions);
    } else if (window.cytoscapeDagre) {
      layout = dagreLayout(layoutOptions);
    } else {
      layout = fallbackLayout();
    }
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
  // Highlight helpers (work on either graph).
  // -------------------------------------------------------------------------

  function clearHighlights(cy) {
    if (!cy) return;
    cy.elements().removeClass('faded highlight');
  }

  function highlightNeighbourhood(cy, node) {
    cy.elements().addClass('faded');
    const hood = node.closedNeighborhood();
    hood.removeClass('faded');
    hood.connectedEdges().filter(e =>
      e.source().id() === node.id() || e.target().id() === node.id()
    ).addClass('highlight');
    node.removeClass('faded');
  }

  // -------------------------------------------------------------------------
  // Side panel — global, used by promises, components, decisions.
  // -------------------------------------------------------------------------

  function openPanelForNode(node) {
    const id = node.id();
    if (id === 'CORE') return openCorePanel();
    const c = componentById[id];
    if (!c) return;
    const cat = categoryById[c.category];

    const html = `
      <div class="panel-head">
        <div class="panel-kind">Component${c.status === 'specified' ? ' · specified' : c.status === 'decided' ? ' · decided' : c.workstream ? ' · open decision' : ''}${cat ? ' · ' + escapeHtml(cat.label) : ''}</div>
        <h3 class="panel-title"><span class="panel-id">${c.id}</span> ${escapeHtml(c.name)}</h3>
        ${c.status_note ? `<p class="panel-status-${c.status === 'specified' ? 'done' : 'decided'}">${c.status === 'specified' ? '✓' : '●'} ${escapeHtml(c.status_note)}</p>` : ''}
        ${c.serves && c.serves.length ? `
          <div class="panel-serves">
            ${c.serves.map(p => {
              const pr = promiseById[p];
              return `<button class="panel-promise-pill" data-promise="${p}" type="button" title="${pr ? escapeHtml(pr.name) : p} — open promise">${p}</button>`;
            }).join('')}
          </div>
        ` : ''}
      </div>

      <section class="panel-section">
        <h4>Outcome</h4>
        <p>${escapeHtml(c.outcome)}</p>
      </section>

      ${(c.hard_deps && c.hard_deps.length) ? `
        <section class="panel-section">
          <h4>Hard dependencies</h4>
          <p class="panel-hint">Must be settled before this component can be designed.</p>
          <ul class="panel-deps">
            ${c.hard_deps.map(id => depLink(id)).join('')}
          </ul>
        </section>
      ` : ''}

      ${(c.associations && c.associations.length) ? `
        <section class="panel-section">
          <h4>Associations</h4>
          <p class="panel-hint">Interact at the runtime interface; co-designed, no precedence.</p>
          <ul class="panel-deps">
            ${c.associations.map(id => depLink(id)).join('')}
          </ul>
        </section>
      ` : ''}

      ${(c.alternatives && c.alternatives.length) ? `
        <section class="panel-section">
          <h4>Alternatives</h4>
          <ul class="panel-alternatives">
            ${c.alternatives.map(a => `
              <li>
                <span class="alt-label">${escapeHtml(a.label)}</span>
                <span class="alt-desc">${escapeHtml(a.description)}</span>
              </li>
            `).join('')}
          </ul>
        </section>
      ` : ''}

      ${(c.open_questions && c.open_questions.length) ? `
        <section class="panel-section">
          <h4>Open questions</h4>
          <ul class="panel-list">
            ${c.open_questions.map(q => `<li>${escapeHtml(q)}</li>`).join('')}
          </ul>
        </section>
      ` : ''}

      ${(c.failure_modes && c.failure_modes.length) ? `
        <section class="panel-section">
          <h4>Failure modes</h4>
          <ul class="panel-list">
            ${c.failure_modes.map(f => `<li>${escapeHtml(f)}</li>`).join('')}
          </ul>
        </section>
      ` : ''}
    `;
    showPanel(html);
  }

  function openCorePanel() {
    const members = data.core_scc.map(id => componentById[id]).filter(Boolean);
    const codesign = data.core_codesign || [];
    const html = `
      <div class="panel-head">
        <div class="panel-kind">Identity-and-account core · SCC</div>
        <h3 class="panel-title">CORE</h3>
      </div>

      <section class="panel-section">
        <h4>What this is</h4>
        <p>The strongly-connected component at the centre of the dependency graph. Six components held together by ${codesign.length} mutual co-design relationships — each pair evolves at a shared interface. Drawn as a compound box in the macro view; click any member to open its individual canvas.</p>
      </section>

      <section class="panel-section">
        <h4>Members</h4>
        <ul class="panel-deps">
          ${members.map(c => `
            <li>
              <button class="dep-link" data-target="${c.id}" data-target-kind="component" type="button">
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
    `;
    showPanel(html);
  }

  function openPanelForPromise(p) {
    const components = componentsByPromise[p.id] || [];
    const html = `
      <div class="panel-head">
        <div class="panel-kind">Promise</div>
        <h3 class="panel-title"><span class="panel-id">${p.id}</span> ${escapeHtml(p.name)}</h3>
      </div>

      <section class="panel-section">
        <h4>Statement</h4>
        <p>${escapeHtml(p.statement)}</p>
      </section>

      <section class="panel-section">
        <h4>Invariants (${p.invariants.length})</h4>
        <p class="panel-hint">Falsifiable properties — a component, surface, or API could plausibly violate any of these, and we could detect that.</p>
        <ul class="panel-invariants">
          ${p.invariants.map(i => `
            <li>
              <span class="invariant-id">${i.id}</span>
              <span class="invariant-text">${escapeHtml(i.text)}</span>
            </li>
          `).join('')}
        </ul>
      </section>

      ${components.length ? `
        <section class="panel-section">
          <h4>Components serving this promise (${components.length})</h4>
          <p class="panel-hint">Click any to open its design space in the graph.</p>
          <ul class="panel-deps">
            ${components.map(c => `
              <li>
                <button class="dep-link" data-target="${c.id}" data-target-kind="component" type="button">
                  <span class="dep-id">${c.id}</span>
                  <span class="dep-name">${escapeHtml(c.name)}</span>
                </button>
              </li>
            `).join('')}
          </ul>
        </section>
      ` : ''}
    `;
    showPanel(html);
  }

  function openPanelForDecision(d) {
    const ws = componentById[d.workstream];
    const html = `
      <div class="panel-head">
        <div class="panel-kind">Open decision · ${d.workstream}</div>
        <h3 class="panel-title">${escapeHtml(d.question)}</h3>
      </div>

      <section class="panel-section">
        <h4>What's at stake</h4>
        <p>${escapeHtml(d.detail)}</p>
        ${d.leverage ? `<p class="panel-hint">${escapeHtml(d.leverage)}</p>` : ''}
      </section>

      <section class="panel-section">
        <h4>Cascades to (${d.cascade_to.length} components)</h4>
        <p class="panel-hint">When this is answered, these canvases visibly shift.</p>
        <ul class="panel-deps">
          ${d.cascade_to.map(id => depLink(id)).join('')}
        </ul>
      </section>

      ${ws ? `
        <section class="panel-section">
          <h4>Component carrying this decision</h4>
          <ul class="panel-deps">
            ${depLink(ws.id)}
          </ul>
        </section>
      ` : ''}
    `;
    showPanel(html);
  }

  function depLink(id) {
    const c = componentById[id];
    if (!c) return `<li><span class="dep-id">${id}</span></li>`;
    return `
      <li>
        <button class="dep-link" data-target="${id}" data-target-kind="component" type="button">
          <span class="dep-id">${id}</span>
          <span class="dep-name">${escapeHtml(c.name)}</span>
        </button>
      </li>
    `;
  }

  function showPanel(html) {
    const panel = document.getElementById('panel');
    const body = document.getElementById('panelBody');
    const backdrop = document.getElementById('panelBackdrop');
    if (!panel || !body) return;
    body.innerHTML = html;
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    if (backdrop) backdrop.classList.add('show');
    panel.scrollTop = 0;
  }

  function closePanel() {
    const panel = document.getElementById('panel');
    const backdrop = document.getElementById('panelBackdrop');
    if (panel) {
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
    }
    if (backdrop) backdrop.classList.remove('show');
  }

  // -------------------------------------------------------------------------
  // Wire-up.
  // -------------------------------------------------------------------------

  function init() {
    renderPromises();

    // Section 2 — components table + filters.
    renderPromiseFilters();
    renderCategoryOptions();
    renderComponentsTable();
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

    // Build both graphs. Macro uses fcose because it has the CORE compound
    // parent; cascade stays on dagre (pure DAG, no compounds).
    const cy = makeCytoscape('cy', buildMacroGraphElements(), null, 'fcose');
    window._macroCy = cy;
    const cascadeCy = makeCytoscape('cascadeCy', buildCascadeGraphElements(), {
      rankSep: 80,
      nodeSep: 36,
    });

    // Macro graph click handlers.
    if (cy) {
      cy.on('tap', (evt) => {
        if (evt.target === cy) {
          clearHighlights(cy);
          closePanel();
        }
      });
      cy.on('tap', 'node', (evt) => {
        const node = evt.target;
        clearHighlights(cy);
        highlightNeighbourhood(cy, node);
        openPanelForNode(node);
      });
    }

    // Cascade graph click handlers.
    if (cascadeCy) {
      cascadeCy.on('tap', (evt) => {
        if (evt.target === cascadeCy) {
          clearHighlights(cascadeCy);
          closePanel();
        }
      });
      cascadeCy.on('tap', 'node', (evt) => {
        const node = evt.target;
        const id = node.id();
        clearHighlights(cascadeCy);
        if (decisionById[id]) {
          highlightNeighbourhood(cascadeCy, node);
          openPanelForDecision(decisionById[id]);
        } else if (componentById[id]) {
          // Component clicked in the cascade graph — surface its canvas + jump to macro graph.
          const macroNode = cy ? cy.getElementById(id) : null;
          if (macroNode && macroNode.length) {
            highlightNeighbourhood(cascadeCy, node);
            openPanelForNode(macroNode);
          } else {
            openPanelForNode(node);
          }
        }
      });
    }

    // Associations toggle on the macro graph.
    const toggleAssoc = document.getElementById('toggleAssoc');
    if (toggleAssoc && cy) {
      toggleAssoc.addEventListener('click', () => {
        const pressed = toggleAssoc.getAttribute('aria-pressed') === 'true';
        const next = !pressed;
        toggleAssoc.setAttribute('aria-pressed', String(next));
        toggleAssoc.textContent = next ? 'Hide associations' : 'Show associations';
        if (next) {
          cy.edges('.edge-assoc').removeClass('edge-hidden');
        } else {
          cy.edges('.edge-assoc').addClass('edge-hidden');
        }
      });
    }

    // Panel close button.
    const closeBtn = document.getElementById('panelClose');
    if (closeBtn) closeBtn.addEventListener('click', () => {
      closePanel();
      clearHighlights(cy);
      clearHighlights(cascadeCy);
    });

    // Backdrop click → close panel.
    const backdrop = document.getElementById('panelBackdrop');
    if (backdrop) backdrop.addEventListener('click', () => {
      closePanel();
      clearHighlights(cy);
      clearHighlights(cascadeCy);
    });

    // ESC key → close panel.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closePanel();
        clearHighlights(cy);
        clearHighlights(cascadeCy);
      }
    });

    // Panel body — handle dep-link (component nav) and promise-pill (promise nav).
    const panelBody = document.getElementById('panelBody');
    if (panelBody) panelBody.addEventListener('click', (e) => {
      const depLinkEl = e.target.closest('.dep-link');
      if (depLinkEl) {
        const target = depLinkEl.dataset.target;
        const kind = depLinkEl.dataset.targetKind || 'component';
        if (kind === 'component' && cy && target) {
          const node = cy.getElementById(target);
          if (node && node.length) {
            document.getElementById('cy').scrollIntoView({ behavior: 'smooth', block: 'center' });
            cy.center(node);
            clearHighlights(cy);
            highlightNeighbourhood(cy, node);
            openPanelForNode(node);
          }
        }
        return;
      }
      const pillEl = e.target.closest('.panel-promise-pill');
      if (pillEl) {
        const pid = pillEl.dataset.promise;
        const promise = promiseById[pid];
        if (promise) openPanelForPromise(promise);
      }
    });

    // Re-style both graphs on theme change.
    const themeObs = new MutationObserver(() => {
      const styles = buildCytoscapeStyle();
      if (cy) cy.style(styles);
      if (cascadeCy) cascadeCy.style(styles);
    });
    themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    // Deep-link via URL hash (e.g. index.html#C5 → opens C5 panel; #P3 → P3 promise; #Q4 → decision).
    function applyHashRoute() {
      const raw = (window.location.hash || '').replace(/^#/, '').trim();
      if (!raw) return;
      const id = decodeURIComponent(raw);
      if (componentById[id]) {
        if (cy) {
          const node = cy.getElementById(id);
          if (node && node.length) {
            const cyEl = document.getElementById('cy');
            if (cyEl) cyEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            cy.center(node);
            clearHighlights(cy);
            highlightNeighbourhood(cy, node);
            openPanelForNode(node);
            return;
          }
        }
        openPanelForNode({ id: () => id });
      } else if (promiseById[id]) {
        openPanelForPromise(promiseById[id]);
      } else if (decisionById[id]) {
        openPanelForDecision(decisionById[id]);
      }
    }
    applyHashRoute();
    window.addEventListener('hashchange', applyHashRoute);
  }

  // -------------------------------------------------------------------------
  // Helpers.
  // -------------------------------------------------------------------------

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
