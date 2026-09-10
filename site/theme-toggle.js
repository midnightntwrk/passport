// Midnight Passport — page chrome: theme toggle + footer data stamp.
// Loaded last on every page (after data.js where present).

// Footer data stamp — appends the data.js meta.updated date to the footer
// so freshness is visible even where the deploy-time substitution has not
// run (local serving, or a page missing from an older workflow).
(function footerStamp() {
  const data = window.PASSPORT_DATA;
  if (!data || !data.meta || !data.meta.updated) return;
  document.querySelectorAll('.footer-meta').forEach((el) => {
    const span = document.createElement('span');
    span.textContent = ' · data updated ' + data.meta.updated;
    el.appendChild(span);
  });
})();

// Theme toggle.
// Cycles: Auto (no attribute) → Light → Dark → Auto. Persists in localStorage.
(function theme() {
  const root = document.documentElement;
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  const saved = localStorage.getItem('passport-theme');
  if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);
  btn.addEventListener('click', () => {
    const cur = root.getAttribute('data-theme');
    let next;
    if (!cur) next = 'light';
    else if (cur === 'light') next = 'dark';
    else next = null;
    if (next) {
      root.setAttribute('data-theme', next);
      localStorage.setItem('passport-theme', next);
    } else {
      root.removeAttribute('data-theme');
      localStorage.removeItem('passport-theme');
    }
  });
})();
