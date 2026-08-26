/**
 * Docs theme preference — a compact sibling of the Passport app's own
 * `examples/passport-demo/src/lib/theme.ts`, using the same mechanism:
 *
 *   - 'light'  → `data-theme="light"` on `<html>`
 *   - 'dark'   → `data-theme="dark"` on `<html>`
 *   - 'system' → the attribute is REMOVED, letting the
 *                `@media (prefers-color-scheme: dark)` block in styles.css win.
 *
 * The default here is 'system' (the docs meet the reader in their operating
 * system's theme); an explicit choice from the header toggle is persisted to
 * localStorage and wins from then on. `index.html` inlines the same logic
 * ahead of first paint so the wrong theme never flashes.
 */

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'passport-docs-theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

const listeners = new Set<() => void>();
let current: ThemePreference | null = null;

function isPreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

function readStored(): ThemePreference | null {
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isPreference(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return preference;
}

function applyToDocument(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', preference);
  root.style.colorScheme = resolveTheme(preference);
}

export function getThemePreference(): ThemePreference {
  if (current) return current;
  current = readStored() ?? 'system';
  return current;
}

export function getResolvedTheme(): ResolvedTheme {
  return resolveTheme(getThemePreference());
}

export function setTheme(preference: ThemePreference): void {
  current = preference;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* Private browsing — the choice simply does not persist. */
  }
  applyToDocument(preference);
  for (const listener of listeners) listener();
}

/** Flips between light and dark, starting from whatever is resolved now. */
export function toggleTheme(): void {
  setTheme(getResolvedTheme() === 'dark' ? 'light' : 'dark');
}

export function subscribeToTheme(listener: () => void): () => void {
  listeners.add(listener);
  if (typeof window.matchMedia === 'function') {
    const query = window.matchMedia(DARK_QUERY);
    const onChange = () => {
      if (getThemePreference() === 'system') {
        applyToDocument('system');
        listener();
      }
    };
    query.addEventListener('change', onChange);
    const detach = () => {
      query.removeEventListener('change', onChange);
      listeners.delete(listener);
    };
    return detach;
  }
  return () => listeners.delete(listener);
}

export function initTheme(): void {
  applyToDocument(getThemePreference());
}
