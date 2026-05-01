// Midnight Passport — shared panel rendering.
//
// Renders component and promise canvases in the sliding side panel that
// index.html already exposes. Loaded by demo.html, standards.html, and
// any future page that wants the same in-place view, so a click on a
// component or promise reference opens the panel rather than navigating
// away.
//
// Requires: data.js loaded first; #panel, #panelBody, and #panelBackdrop
// elements present in the DOM. Auto-binds clicks on any element carrying
// data-component="<C-id>" or data-promise="<P-id>" — including the
// dep-link buttons inside the rendered panel itself, so dependencies are
// navigable in place.
(function () {
  const data = window.PASSPORT_DATA;
  if (!data) {
    console.error('PASSPORT_DATA not loaded — panel.js will be inactive');
    return;
  }

  const componentById = Object.fromEntries((data.components || []).map(c => [c.id, c]));
  const promiseById = Object.fromEntries((data.promises || []).map(p => [p.id, p]));
  const categoryById = Object.fromEntries((data.categories || []).map(cat => [cat.id, cat]));

  const componentsByPromise = {};
  (data.promises || []).forEach(p => { componentsByPromise[p.id] = []; });
  (data.components || []).forEach(c => {
    (c.serves || []).forEach(p => {
      if (componentsByPromise[p]) componentsByPromise[p].push(c);
    });
  });

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function depLink(id) {
    const c = componentById[id];
    if (!c) return `<li><span class="dep-id">${id}</span></li>`;
    return `
      <li>
        <button class="dep-link" data-component="${id}" type="button">
          <span class="dep-id">${c.id}</span>
          <span class="dep-name">${escapeHtml(c.name)}</span>
        </button>
      </li>
    `;
  }

  function buildComponentHtml(c) {
    const cat = categoryById[c.category];
    return `
      <div class="panel-head">
        <div class="panel-kind">Component${c.workstream ? ' · open decision' : ''}${cat ? ' · ' + escapeHtml(cat.label) : ''}</div>
        <h3 class="panel-title"><span class="panel-id">${c.id}</span> ${escapeHtml(c.name)}</h3>
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
  }

  function buildPromiseHtml(p) {
    const components = componentsByPromise[p.id] || [];
    return `
      <div class="panel-head">
        <div class="panel-kind">Promise</div>
        <h3 class="panel-title"><span class="panel-id">${p.id}</span> ${escapeHtml(p.name)}</h3>
      </div>

      ${p.statement ? `
        <section class="panel-section">
          <h4>Statement</h4>
          <p>${escapeHtml(p.statement)}</p>
        </section>
      ` : ''}

      ${(p.invariants && p.invariants.length) ? `
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
      ` : ''}

      ${components.length ? `
        <section class="panel-section">
          <h4>Components serving this promise (${components.length})</h4>
          <p class="panel-hint">Click any to open its canvas.</p>
          <ul class="panel-deps">
            ${components.map(c => depLink(c.id)).join('')}
          </ul>
        </section>
      ` : ''}
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
    if (!panel) return;
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    if (backdrop) backdrop.classList.remove('show');
  }

  function openComponent(id) {
    const c = componentById[id];
    if (!c) return;
    showPanel(buildComponentHtml(c));
  }

  function openPromise(id) {
    const p = promiseById[id];
    if (!p) return;
    showPanel(buildPromiseHtml(p));
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest('.panel-close') || e.target.closest('#panelBackdrop')) {
      closePanel();
      return;
    }
    const promiseTrigger = e.target.closest('[data-promise]');
    if (promiseTrigger) {
      e.preventDefault();
      openPromise(promiseTrigger.dataset.promise);
      return;
    }
    const componentTrigger = e.target.closest('[data-component]');
    if (componentTrigger) {
      e.preventDefault();
      openComponent(componentTrigger.dataset.component);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel();
  });

  window.PassportPanel = { openComponent, openPromise, close: closePanel };
})();
