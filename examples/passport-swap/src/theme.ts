/* The theme switch. The system's preference applies until somebody presses
   the button; the choice is kept in localStorage so it survives a reload. */
const KEY = 'passport-app:theme';

export type Theme = 'light' | 'dark';

export function currentTheme(): Theme {
  const stored = read();
  if (stored) return stored;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* Storage may be unavailable; the attribute still applies for this page. */
  }
}

export function restoreTheme(): void {
  const stored = read();
  if (stored) document.documentElement.dataset.theme = stored;
}

function read(): Theme | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}
