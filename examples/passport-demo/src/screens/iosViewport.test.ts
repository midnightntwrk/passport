/**
 * Two rules about iOS that a stylesheet can break silently, drilled against
 * the stylesheets themselves.
 *
 * Neither is a matter of taste, and neither shows up in a browser that is not
 * an iPhone — which is why they are asserted here rather than left to a review
 * that has to remember them:
 *
 *   - A form control under 16px makes iOS Safari zoom the whole viewport on
 *     focus, and it never zooms back out on blur. The reader is left pinching
 *     their way out of a page mid-payment. The Send sheet had three such
 *     fields, the worst of them the address box at 12.5px.
 *   - `100vh` on iOS is the viewport with the address bar COLLAPSED. A root
 *     measured that way is 60–90px taller than any `100svh` screen inside it,
 *     so every screen scrolls when it looks like it fits and the fixed bottom
 *     nav appears to drift as the bar comes and goes.
 *
 * And one that is about reachability rather than measurement: the bottom nav
 * sits over the home indicator unless it is told about the safe area.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

/**
 * The stylesheet with its prose taken out.
 *
 * Every rule here explains itself in a comment, and several of those comments
 * quote the very thing they replaced (`100vh`, `12.5px`). Scanning the raw
 * file would fail on its own documentation.
 */
const declarationsOf = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The same, with `@media` preludes dropped so a breakpoint is not read as a rule. */
const rulesOf = (css: string): string =>
  declarationsOf(css).replace(/@media[^{]*\{/g, '');

const homeCss = read('./home.css');
const navCss = read('./nav.css');
const rootCss = read('../styles.css');
const stylesheets = [rootCss, homeCss, navCss];

/** Every `font-size` declared inside the rule for `selector`. */
function fontSizesOf(css: string, selector: string): number[] {
  const sizes: number[] = [];
  const pattern = new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'g');
  for (const rule of css.matchAll(pattern)) {
    for (const declaration of rule[1].matchAll(/font-size:\s*([0-9.]+)px/g)) {
      sizes.push(Number(declaration[1]));
    }
  }
  return sizes;
}

describe('the Send sheet does not zoom the page on focus', () => {
  it('sets every send field at or above the 16px floor', () => {
    /* `.mnhome-send-input` is the asset select, the recipient field, and the
       amount field; `.mnhome-send-input-mono` is the address box layered on
       top of it. All four are things a thumb lands in. */
    for (const selector of ['.mnhome-send-input', '.mnhome-send-input-mono']) {
      const sizes = fontSizesOf(declarationsOf(homeCss), selector);
      expect(sizes.length).toBeGreaterThan(0);
      for (const size of sizes) expect(size).toBeGreaterThanOrEqual(16);
    }
  });

  it('keeps the rule written down beside the number', () => {
    /* A bare `16px` is a number somebody tidies away. The reason has to travel
       with it, exactly as `apps.css` already does. */
    expect(homeCss).toContain('16px IS THE FLOOR');
  });
});

describe('the root wrapper agrees with the screens inside it', () => {
  it('measures itself in the same viewport unit its children do', () => {
    expect(rootCss).toContain('.passport-experience { min-height: 100svh;');
    expect(homeCss).toContain('min-height: 100svh');
  });

  it('leaves no `100vh` in the stylesheets that paint the mobile app', () => {
    /* `dvh` and `svh` are both fine; the bare unit is the one that disagrees
       with everything around it. */
    for (const css of stylesheets) {
      expect(declarationsOf(css)).not.toMatch(/(?<![sd])100vh/);
    }
  });
});

describe('the bottom nav clears the home indicator', () => {
  it('measures both the pill and the surface behind it against the safe area', () => {
    /* Two rules, and both matter: the pill would sit on the indicator without
       the first, and the surface behind it would stop short without the
       second, leaving a strip of page showing through under the bar. */
    const safeArea = navCss.match(/env\(safe-area-inset-bottom\)/g) ?? [];
    expect(safeArea.length).toBeGreaterThanOrEqual(2);
    expect(navCss).toContain('bottom: max(8px, env(safe-area-inset-bottom))');
  });
});

describe('nothing forces the page wider than the narrowest phone', () => {
  it('asks for no more width than a 390px viewport has', () => {
    /* 390 CSS pixels is an iPhone 14/15/16 in portrait, and the narrowest
       screen the demo is walked on. A `min-width` above it, anywhere in the
       mobile stylesheets, is a horizontal scrollbar. */
    for (const css of stylesheets) {
      for (const declaration of rulesOf(css).matchAll(/min-width:\s*([0-9.]+)px/g)) {
        expect(Number(declaration[1])).toBeLessThanOrEqual(390);
      }
    }
  });
});
