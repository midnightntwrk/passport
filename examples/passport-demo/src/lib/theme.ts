/**
 * Passport theme preference.
 *
 * Three preferences are recorded: 'light', 'dark', and 'system'. Light is the
 * default, both here and in `screens/tokens.css`.
 *
 * How it reaches the CSS
 * ----------------------
 * - 'light'  → `data-theme="light"` on `<html>`
 * - 'dark'   → `data-theme="dark"` on `<html>`
 * - 'system' → the attribute is **removed**, which is what lets the
 *              `@media (prefers-color-scheme: dark)` block in tokens.css win.
 *
 * Flash of the wrong theme
 * ------------------------
 * `initTheme()` is safe to call before React mounts and is invoked once
 * automatically when this module is first imported in a browser, so importing
 * it from an entry point ahead of `createRoot` is enough for the common case.
 * For a guaranteed zero-flash first paint, inline {@link themeInitScript} in
 * `index.html` ahead of the module script — it runs before any stylesheet
 * paints and writes the same attribute this module would.
 */

export type ThemePreference = 'light' | 'dark' | 'system'

/** What the preference actually resolves to right now. Never 'system'. */
export type ResolvedTheme = 'light' | 'dark'

/** localStorage key. Stable — do not rename without a migration. */
export const THEME_STORAGE_KEY = 'passport-theme'

/**
 * The preference used when nothing has been recorded.
 *
 * Light, deliberately: Passport's default look is the light one, and a visitor
 * whose operating system happens to be dark should still meet the light
 * interface first. 'system' remains one tap away in the theme control, and is
 * honoured fully once chosen.
 */
export const DEFAULT_THEME: ThemePreference = 'light'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** Order used by {@link toggleTheme}. */
const CYCLE: readonly ThemePreference[] = ['light', 'dark', 'system']

type Listener = (preference: ThemePreference, resolved: ResolvedTheme) => void

const listeners = new Set<Listener>()

let current: ThemePreference | null = null
let mediaQuery: MediaQueryList | null = null
let mediaBound = false

function hasDom(): boolean {
  return typeof document !== 'undefined' && typeof window !== 'undefined'
}

function isPreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system'
}

function readStored(): ThemePreference | null {
  if (!hasDom()) return null
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isPreference(raw) ? raw : null
  } catch {
    /* Private mode, or storage disabled. The preference simply does not
       persist; everything else still works. */
    return null
  }
}

function writeStored(preference: ThemePreference): void {
  if (!hasDom()) return
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    /* See readStored. */
  }
}

function getMediaQuery(): MediaQueryList | null {
  if (!hasDom() || typeof window.matchMedia !== 'function') return null
  if (!mediaQuery) mediaQuery = window.matchMedia(DARK_QUERY)
  return mediaQuery
}

/** True when the operating system is currently asking for a dark interface. */
export function systemPrefersDark(): boolean {
  return getMediaQuery()?.matches ?? false
}

/** What a preference resolves to, given the current system setting. */
export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark() ? 'dark' : 'light'
  return preference
}

/** Writes the preference to `<html>` without touching storage or listeners. */
function applyToDocument(preference: ThemePreference): void {
  if (!hasDom()) return
  const root = document.documentElement
  if (preference === 'system') {
    root.removeAttribute('data-theme')
  } else {
    root.setAttribute('data-theme', preference)
  }
  /* Keep the browser's own chrome — form controls, scrollbars, the address
     bar on mobile — in step with the resolved theme. */
  const resolved = resolveTheme(preference)
  root.style.colorScheme = resolved
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0a0a0a' : '#e9e9e9')
}

function notify(preference: ThemePreference): void {
  const resolved = resolveTheme(preference)
  for (const listener of listeners) listener(preference, resolved)
}

function bindSystemChanges(): void {
  if (mediaBound) return
  const query = getMediaQuery()
  if (!query) return
  mediaBound = true
  const onChange = (): void => {
    /* CSS re-resolves on its own, but the document attributes and any
       subscriber still need to hear about it. */
    if (getThemePreference() !== 'system') return
    applyToDocument('system')
    notify('system')
  }
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', onChange)
  } else if (typeof (query as MediaQueryList).addListener === 'function') {
    /* Safari below 14. */
    ;(query as MediaQueryList).addListener(onChange)
  }
}

/**
 * Reads the recorded preference, falling back to whatever is already on the
 * document element, then to {@link DEFAULT_THEME}.
 */
export function getThemePreference(): ThemePreference {
  if (current) return current
  const stored = readStored()
  if (stored) {
    current = stored
    return current
  }
  if (hasDom()) {
    const attribute = document.documentElement.getAttribute('data-theme')
    if (isPreference(attribute)) {
      current = attribute
      return current
    }
  }
  current = DEFAULT_THEME
  return current
}

/** The theme actually in force right now. Never 'system'. */
export function getResolvedTheme(): ResolvedTheme {
  return resolveTheme(getThemePreference())
}

/** Records a preference, applies it, and tells subscribers. */
export function setTheme(preference: ThemePreference): ThemePreference {
  const next = isPreference(preference) ? preference : DEFAULT_THEME
  current = next
  writeStored(next)
  applyToDocument(next)
  bindSystemChanges()
  notify(next)
  return next
}

/**
 * Advances the preference: light → dark → system → light.
 *
 * Pass `'binary'` to skip 'system' and flip between light and dark only,
 * which is what a two-state control wants.
 */
export function toggleTheme(mode: 'cycle' | 'binary' = 'cycle'): ThemePreference {
  const preference = getThemePreference()
  if (mode === 'binary') {
    return setTheme(resolveTheme(preference) === 'dark' ? 'light' : 'dark')
  }
  const index = CYCLE.indexOf(preference)
  return setTheme(CYCLE[(index + 1) % CYCLE.length] ?? DEFAULT_THEME)
}

/**
 * Applies the stored preference to the document. Idempotent, and safe to call
 * before React mounts — it touches nothing but `<html>`.
 */
export function initTheme(): ThemePreference {
  const preference = getThemePreference()
  applyToDocument(preference)
  bindSystemChanges()
  return preference
}

/** Subscribes to preference changes. Returns the unsubscribe function. */
export function subscribeToTheme(listener: Listener): () => void {
  listeners.add(listener)
  bindSystemChanges()
  return () => {
    listeners.delete(listener)
  }
}

/**
 * A blocking snippet for `index.html`, to be inlined in `<head>` ahead of
 * every stylesheet, e.g.
 *
 * ```html
 * <script>/* … themeInitScript … *\/</script>
 * ```
 *
 * It writes the same attribute {@link initTheme} would, before first paint,
 * so a user whose preference is dark never sees a light frame first.
 */
export const themeInitScript = `(function(){try{var p=localStorage.getItem('${THEME_STORAGE_KEY}');var r=document.documentElement;if(p==='light'||p==='dark'){r.setAttribute('data-theme',p);r.style.colorScheme=p;}else if(p==='system'){r.removeAttribute('data-theme');r.style.colorScheme=matchMedia('${DARK_QUERY}').matches?'dark':'light';}else{r.setAttribute('data-theme','${DEFAULT_THEME}');r.style.colorScheme='${DEFAULT_THEME}';}}catch(e){}})();`

/* Apply on first import so an entry point only has to import this module
   ahead of `createRoot`. Calling initTheme() explicitly is still supported
   and does no extra work. */
if (hasDom()) initTheme()
