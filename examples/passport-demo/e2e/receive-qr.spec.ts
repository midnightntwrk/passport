/**
 * The Receive code, and reading one back without a camera.
 *
 * "The UI also has a QR code that, when scanned with the scanner, automatically
 * inserts my name and address there" (2026/08/31). Half of that ask is pure and
 * is drilled where it lives, in `src/lib/qrPayload.test.ts`: the format, the
 * upper-case fold, the parameters that are honoured and the ones that are not.
 * What is left over needs pixels, and pixels are what this file has.
 *
 * WHAT A BROWSER PROVES THAT A UNIT TEST CANNOT
 * --------------------------------------------
 * That the square Receive actually paints DECODES. Every part of that sentence
 * is a place to be wrong that no assertion about a string can reach: a matrix
 * transposed row-for-column, a quiet zone left to a stylesheet, a `path` built
 * with a rounding error, an accent colour that looks handsome and reads as
 * grey. So the SVG on screen is rasterised in the page, handed back as pixels,
 * and put through the SAME decoder the scanner uses — and the text that comes
 * out is compared against the name and the account it is supposed to carry.
 *
 * And that a code READS on a machine with no camera at all. That is the whole
 * reason the image path exists: until 2026/08/31 the scanner was `getUserMedia`
 * and nothing else, which is why it had only ever worked on a phone. The walk
 * below never grants a camera. It drops a PNG of a real Receive code onto the
 * scan sheet, and the Send sheet's recipient fills in.
 *
 * THE CROSS-CHECK IS DRILLED HERE TOO
 * -----------------------------------
 * A Passport code carries the account behind the name, and that account is
 * never spent to — the `.night` registry is the sole authority on what a name
 * pays. The code's copy exists so a code that DISAGREES can be refused. Both
 * halves are walked: a code whose account matches what the registry says
 * resolves and offers Review, and one carrying somebody else's account is
 * refused in words, with the control disabled rather than removed.
 *
 * Every read behind that is real. `iamtester` is a name genuinely registered on
 * stagenet, and the account it points at is decoded from recorded ledger bytes
 * by the real Midnames module — only the transport is mocked.
 */

import { Buffer } from 'node:buffer';

import { expect, test, type Page } from '@playwright/test';
import jsQR from 'jsqr';
import { renderSVG } from 'uqr';

import { installNetworkBoundary, PASSPORT_ACCOUNT_ADDRESS, RESOLVABLE_NAME } from './mocks.js';
import { installVirtualAuthenticator } from './passkey.js';

test.describe.configure({ mode: 'serial' });

let page: Page;

/** A label that is free in the recorded registry snapshot. */
const NAME = 'qrwalk';

/** A rasterised code: a PNG to drop, and the pixels to decode. */
interface Raster {
  png: string;
  width: number;
  height: number;
  data: number[];
}

/** How many pixels wide every code in this file is rendered at. */
const SIDE = 512;

/**
 * Draws an SVG string onto a canvas inside the page and hands back both a PNG
 * and its pixels.
 *
 * The page is where this has to happen: Node has no canvas, and the whole point
 * of the first test is to read the square the BROWSER painted rather than one
 * reconstructed from the same inputs. A white ground goes down first, because
 * the plate that provides it in the UI is a `div` and does not travel with a
 * serialised SVG.
 */
async function rasteriseSvg(source: string): Promise<Raster> {
  return page.evaluate(
    async ({ svg, side }) => {
      const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('the code did not rasterise'));
        image.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = side;
      canvas.height = side;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('no 2d context');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, side, side);
      context.drawImage(image, 0, 0, side, side);
      const pixels = context.getImageData(0, 0, side, side);
      return {
        png: canvas.toDataURL('image/png'),
        width: side,
        height: side,
        data: Array.from(pixels.data),
      };
    },
    { svg: source, side: SIDE },
  );
}

/** The code that is on screen right now, rasterised. */
async function rasteriseOnScreen(selector: string): Promise<Raster> {
  const source = await page.evaluate((target) => {
    const svg = document.querySelector(target);
    if (!svg) throw new Error(`no ${target} on screen`);
    if (svg.getBoundingClientRect().width === 0) {
      throw new Error('the code is on screen at zero width');
    }
    return new XMLSerializer().serializeToString(svg);
  }, selector);
  return rasteriseSvg(source);
}

/** A code Passport did not draw, for the walks that need a hostile one. */
function drawCode(payload: string): Promise<Raster> {
  return rasteriseSvg(renderSVG(payload, { ecc: 'M', border: 4, pixelSize: 8 }));
}

/** What the decoder makes of a rasterised code. */
function decode(shot: Raster): string {
  const code = jsQR(new Uint8ClampedArray(shot.data), shot.width, shot.height, {
    inversionAttempts: 'attemptBoth',
  });
  if (!code) throw new Error('the code did not decode');
  return code.data;
}

/** Drops a rasterised code onto the open scan sheet, as a file would land. */
async function dropCode(shot: Raster, name: string): Promise<void> {
  const png = Buffer.from(shot.png.split(',')[1] ?? '', 'base64');
  expect(png.byteLength).toBeGreaterThan(0);
  await page.locator('.mnhome-qrdrop-input').setInputFiles({
    name,
    mimeType: 'image/png',
    buffer: png,
  });
}

/**
 * Opens the Send sheet's scanner, with no camera anywhere in the walk.
 *
 * Located by class and text rather than by role: the control sits inside the
 * `<label>` that names the recipient field, and a button nested in a label has
 * no accessible name of its own to ask for.
 */
async function openScanner(): Promise<void> {
  await page.locator('.mnhome-send-max', { hasText: /Scan QR/i }).first().click();
  await expect(page.locator('.mnhome-qrscan')).toBeVisible();
  await expect(page.locator('.mnhome-qrdrop')).toBeVisible();
}

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  page = await context.newPage();
  await installNetworkBoundary(page);
  await installVirtualAuthenticator(context, page);

  /* A Passport that already exists — the state Receive is opened in. The
     ceremony itself is drilled by `onboarding.spec.ts`. */
  await page.goto('/');
  await page.getByRole('button', { name: /Continue with Passport/i }).click();
  await expect(page.getByRole('heading', { name: /Welcome to Passport/i })).toBeVisible({
    timeout: 90_000,
  });

  const seeded = await page.evaluate(
    ({ alias, address }) => {
      const credentialId = localStorage.getItem('passport-last-passkey');
      if (!credentialId) return null;
      const now = new Date().toISOString();
      localStorage.setItem(
        'passport-alias:v1',
        JSON.stringify({
          stagenet: {
            alias,
            domain: `${alias}.night`,
            network: 'stagenet',
            status: 'registered',
            resolverAddress: 'dd'.repeat(32),
            resolverDeployTxId: 'aa'.repeat(32),
            registerTxId: 'bb'.repeat(32),
            registryConfirmed: true,
            resolverTarget: 'contract',
            resolverTargetHex: address,
            updatedAt: now,
          },
        }),
      );
      localStorage.setItem(
        'passport-contract:v1',
        JSON.stringify({
          [`${credentialId}::stagenet`]: {
            credentialId,
            network: 'stagenet',
            status: 'deployed',
            address,
            deployTxId: 'cc'.repeat(32),
            txIdResolved: true,
            ledgerConfirmed: true,
            feePaidBy: 'sponsored',
            updatedAt: now,
          },
        }),
      );
      return credentialId;
    },
    { alias: NAME, address: PASSPORT_ACCOUNT_ADDRESS },
  );
  expect(seeded).not.toBeNull();

  await page.reload();
  await expect(page.getByRole('button', { name: /^Send$/ }).first()).toBeVisible({
    timeout: 90_000,
  });
});

test.afterAll(async () => {
  await page.context().close();
});

/** This Passport's own code, as the browser painted it. Kept for the drop walk. */
let ownCode: Raster;

test('Receive draws a code, and the code decodes to the name and the account', async () => {
  await page.getByRole('button', { name: /^Receive$/ }).first().click();
  await expect(page.locator('.mnhome-recv-qr-code')).toBeVisible({ timeout: 30_000 });

  ownCode = await rasteriseOnScreen('.mnhome-recv-qr-code');
  expect(decode(ownCode)).toBe(`midnight:${NAME}.night?account=${PASSPORT_ACCOUNT_ADDRESS}`);

  /* THE ADDRESS IS IN THE SQUARE AND NOT ON THE PAGE. Receive is the one
     surface that expresses the account address at all, and it expresses it
     truncated — the full string travels only in a form a camera reads. */
  const sheet = await page.locator('.mnhome-addr-modal').innerText();
  expect(sheet).not.toContain(PASSPORT_ACCOUNT_ADDRESS);
  expect(sheet).toContain(`${NAME}.night`);
  // And no engine vocabulary crept in beside it.
  expect(sheet).not.toMatch(/\b(wallet|contract|registry|indexer|resolver|dust)\b/i);

  await page.locator('.mnhome-addr-modal').getByRole('button', { name: /^Close$/ }).click();
  await expect(page.locator('.mnhome-recv-qr-code')).toHaveCount(0);
});

test('a code dropped as an image fills the recipient, with no camera', async () => {
  /* THE DESKTOP CASE. No camera is ever granted in this walk: the scan sheet
     opens, reports honestly that it has none, and the image path underneath is
     what does the work — which is the whole point of it existing. */
  await page.getByRole('button', { name: /^Send$/ }).first().click();
  await openScanner();
  await dropCode(ownCode, 'passport-code.png');

  // The sheet closes itself on a read, and the name lands in the field.
  await expect(page.locator('.mnhome-qrscan')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole('textbox').first()).toHaveValue(`${NAME}.night`);
});

test('an image with no code in it says so, and keeps the sheet open', async () => {
  await openScanner();
  const blank = Buffer.from(
    // A 1×1 white PNG. Small, valid, and carrying nothing to find.
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await page.locator('.mnhome-qrdrop-input').setInputFiles({
    name: 'blank.png',
    mimeType: 'image/png',
    buffer: blank,
  });

  await expect(page.locator('.mnhome-qrscan')).toBeVisible();
  await expect(page.locator('.mnhome-qrscan .mnhome-send-error')).toContainText(
    /No QR code was found/i,
  );
  await page.locator('.mnhome-qrscan').getByRole('button', { name: /^Close$/ }).click();
  await expect(page.locator('.mnhome-qrscan')).toHaveCount(0);
});

test('a scanned name resolves exactly as a typed one does', async () => {
  /* The point of putting the NAME in the field rather than the account: what
     happens next is the registry read and the confirmation chip, unchanged. */
  const code = await drawCode(
    `midnight:${RESOLVABLE_NAME}.night?account=${PASSPORT_ACCOUNT_ADDRESS}`,
  );

  await page.getByRole('textbox').first().fill('');
  await openScanner();
  await dropCode(code, 'iamtester.png');

  await expect(page.locator('.mnhome-qrscan')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole('textbox').first()).toHaveValue(`${RESOLVABLE_NAME}.night`);

  const chip = page.locator('.mnhome-send-resolved');
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip).toContainText(`${RESOLVABLE_NAME}.night`);
  // Four characters of the account, and not one more — as for a typed name.
  await expect(chip).toContainText(`…${PASSPORT_ACCOUNT_ADDRESS.slice(-4)}`);
  expect(await chip.innerText()).not.toContain(PASSPORT_ACCOUNT_ADDRESS.slice(0, 10));
});

test('a code that disagrees about the account is refused, not obeyed', async () => {
  /* The cross-check. The name resolves perfectly well; the account the CODE
     claims for it is somebody else's. Passport does not quietly pay the name
     and it does not quietly pay the code — it refuses, and says why, because a
     code that disagrees is either stale or hostile and neither is worth
     guessing about. */
  const code = await drawCode(`midnight:${RESOLVABLE_NAME}.night?account=${'ee'.repeat(32)}`);

  await page.getByRole('textbox').first().fill('');
  await openScanner();
  await dropCode(code, 'hostile.png');

  await expect(page.locator('.mnhome-qrscan')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole('textbox').first()).toHaveValue(`${RESOLVABLE_NAME}.night`);

  const refusal = page.locator('#mnhome-send-recipient-error');
  await expect(refusal).toBeVisible({ timeout: 30_000 });
  await expect(refusal).toContainText('does not match what');
  // Disabled with the reason on screen — never removed. The house rule.
  await expect(page.getByRole('button', { name: /^Review$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Review$/ })).toBeDisabled();
  // No hex of anybody's account reached the screen with it.
  expect(await refusal.innerText()).not.toMatch(/\b[0-9a-f]{16,}\b/);

  /* And typing into the field clears the scanned claim: from that keystroke on
     the field is no longer what was scanned, so the same name resolves. */
  await page.getByRole('textbox').first().fill('');
  await page.getByRole('textbox').first().fill(`${RESOLVABLE_NAME}.night`);
  await expect(page.locator('.mnhome-send-resolved')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#mnhome-send-recipient-error')).toHaveCount(0);
});
