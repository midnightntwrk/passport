/**
 * The scanner lets the camera go — on every way out of the sheet.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * On the call of 2026/08/31 the scan button took the camera and the microphone
 * away from a screen share, and the presenter's video and audio were gone for
 * two minutes. A capture device is exclusive on most platforms: whatever holds
 * it is the only thing that has it, so a sheet that keeps a track alive one
 * second longer than it needs is taking that second from something else.
 *
 * Four walks below. The first pins the request itself — video, and explicitly
 * never a microphone, which is the half of the incident that took the
 * presenter's audio. The other three are the ways out of the sheet a reader
 * actually takes, and each asserts the same thing: `stop()` was called exactly
 * once on the track the browser handed out.
 *
 *   close        the Close button;
 *   Escape       which must close the scanner and NOT the Send sheet under it;
 *   a scan       the payload found, the sheet finishing — driven through the
 *                image path, since a fake camera cannot be pointed at a code.
 *
 * The remaining exit, a `pagehide` while the sheet is open, is the one a
 * browser test cannot observe without destroying the page it is asserting
 * about; it is held by the listener in `QrScanSheet` and reviewed there.
 *
 * THE CAMERA IS FAKE, AND REAL ENOUGH
 * -----------------------------------
 * `navigator.mediaDevices.getUserMedia` is replaced before the app loads with
 * one that hands back a genuine `MediaStream` from `canvas.captureStream` — a
 * real stream with a real track, because the sheet assigns it to a `<video>`
 * element's `srcObject` and that setter refuses anything that is not one. Only
 * `stop` is wrapped, and the wrapper still calls through, so what is counted is
 * the app's call on a track that really does stop.
 *
 * The tally lives in `sessionStorage` rather than on `window`, so it survives a
 * reload and is readable as a plain number rather than as a live object graph
 * the walk would have to keep hold of.
 */

import { Buffer } from 'node:buffer';

import { expect, test, type Page } from '@playwright/test';
import { renderSVG } from 'uqr';

import { installNetworkBoundary, PASSPORT_ACCOUNT_ADDRESS, RESOLVABLE_NAME } from './mocks.js';
import { installVirtualAuthenticator } from './passkey.js';

test.describe.configure({ mode: 'serial' });

let page: Page;

/** A label that is free in the recorded registry snapshot. */
const NAME = 'camerawalk';

/** Where the fake camera keeps its tally, so a navigation cannot erase it. */
const STOPS_KEY = 'walk:camera-stops';
const CONSTRAINTS_KEY = 'walk:camera-constraints';

/**
 * Replaces the camera before any application script runs.
 *
 * Installed with `addInitScript` so it survives every reload and navigation in
 * the walk — the app asks for a camera on a sheet that can be opened after any
 * of them.
 */
async function installFakeCamera(target: Page): Promise<void> {
  await target.addInitScript(
    ({ stopsKey, constraintsKey }) => {
      const bump = (key: string) => {
        try {
          sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) ?? '0') + 1));
        } catch {
          /* Storage disabled: the assertions below will say so plainly. */
        }
      };
      const media = navigator.mediaDevices ?? ({} as MediaDevices);
      Object.defineProperty(navigator, 'mediaDevices', { value: media, configurable: true });
      Object.defineProperty(media, 'getUserMedia', {
        configurable: true,
        value: async (constraints: MediaStreamConstraints) => {
          try {
            sessionStorage.setItem(constraintsKey, JSON.stringify(constraints ?? null));
          } catch {
            /* See above. */
          }
          const canvas = document.createElement('canvas');
          canvas.width = 64;
          canvas.height = 64;
          const context = canvas.getContext('2d');
          if (context) {
            context.fillStyle = '#000000';
            context.fillRect(0, 0, 64, 64);
          }
          const stream = (canvas as HTMLCanvasElement & {
            captureStream(frameRate?: number): MediaStream;
          }).captureStream(0);
          for (const track of stream.getTracks()) {
            const through = track.stop.bind(track);
            track.stop = () => {
              bump(stopsKey);
              through();
            };
          }
          return stream;
        },
      });
    },
    { stopsKey: STOPS_KEY, constraintsKey: CONSTRAINTS_KEY },
  );
}

/** How many tracks the app has stopped since the tally was last cleared. */
async function stops(): Promise<number> {
  return page.evaluate((key) => Number(sessionStorage.getItem(key) ?? '0'), STOPS_KEY);
}

async function clearTally(): Promise<void> {
  await page.evaluate((key) => sessionStorage.setItem(key, '0'), STOPS_KEY);
}

/**
 * Opens the Send sheet's scanner and waits for the camera to be live.
 *
 * Located by class and text rather than by role: the control sits inside the
 * `<label>` that names the recipient field, and a button nested in a label has
 * no accessible name of its own to ask for.
 */
async function openScanner(): Promise<void> {
  await page.locator('.mnhome-send-max', { hasText: /Scan QR/i }).first().click();
  await expect(page.locator('.mnhome-qrscan')).toBeVisible();
  /* The camera is only OPEN once `getUserMedia` has answered, which is what
     writes the constraints. Asserting a stop before that would be asserting
     about a track that had not been handed out yet. */
  await expect
    .poll(() => page.evaluate((key) => sessionStorage.getItem(key), CONSTRAINTS_KEY))
    .not.toBeNull();
  /* Cleared HERE, once the camera is open, so what each walk counts is the
     stops its own exit caused. Opening is allowed to have stopped tracks of
     its own: React's development double-invoke mounts the camera effect, tears
     it down, and mounts it again, which is a legitimate release nobody is
     asserting about. */
  await clearTally();
}

/** A PNG of a real Passport code, drawn outside the browser. */
async function codeImage(payload: string): Promise<Buffer> {
  const svg = renderSVG(payload, { ecc: 'M', border: 4, pixelSize: 8 });
  const dataUrl = await page.evaluate(
    async ({ source, side }) => {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('the code did not rasterise'));
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
      });
      const canvas = document.createElement('canvas');
      canvas.width = side;
      canvas.height = side;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('no 2d context');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, side, side);
      context.drawImage(image, 0, 0, side, side);
      return canvas.toDataURL('image/png');
    },
    { source: svg, side: 512 },
  );
  return Buffer.from(dataUrl.split(',')[1] ?? '', 'base64');
}

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  page = await context.newPage();
  await installFakeCamera(page);
  await installNetworkBoundary(page);
  await installVirtualAuthenticator(context, page);

  /* A Passport that already exists — the state a scanner is opened from. The
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
  await page.getByRole('button', { name: /^Send$/ }).first().click();
});

test.afterAll(async () => {
  await page.context().close();
});

test('the scanner asks for video and never for a microphone', async () => {
  await openScanner();

  const asked = JSON.parse(
    (await page.evaluate((key) => sessionStorage.getItem(key), CONSTRAINTS_KEY)) ?? 'null',
  );

  /* THE ONE LINE THAT DECIDES WHETHER OPENING A SCANNER TAKES A MICROPHONE.
     `audio: false` explicitly, not merely absent: the browser treats the two
     the same, a reader does not, and this is the constraint the incident of
     2026/08/31 was about. */
  expect(asked).not.toBeNull();
  expect(asked.audio).toBe(false);
  expect(asked.video).toBeTruthy();
  // And nothing anywhere in the request asks for audio by another spelling.
  expect(JSON.stringify(asked)).not.toMatch(/"audio":\s*(true|\{)/);

  await page.locator('.mnhome-qrscan').getByRole('button', { name: /^Close$/ }).click();
  await expect(page.locator('.mnhome-qrscan')).toHaveCount(0);
});

test('closing the sheet stops the track', async () => {
  await openScanner();

  await page.locator('.mnhome-qrscan').getByRole('button', { name: /^Close$/ }).click();
  await expect(page.locator('.mnhome-qrscan')).toHaveCount(0);
  await expect.poll(stops).toBe(1);
});

test('Escape stops the track', async () => {
  await openScanner();

  await page.keyboard.press('Escape');
  await expect(page.locator('.mnhome-qrscan')).toHaveCount(0);
  await expect.poll(stops).toBe(1);

  /* And the Send sheet behind it is still open: Escape closed the scanner, not
     everything. The camera going is not allowed to cost the reader their
     place. */
  await expect(page.locator('.mnhome-send-max', { hasText: /Scan QR/i }).first()).toBeVisible();
});

test('a successful scan stops the track', async () => {
  await openScanner();

  await page.locator('.mnhome-qrdrop-input').setInputFiles({
    name: 'passport-code.png',
    mimeType: 'image/png',
    buffer: await codeImage(`midnight:${RESOLVABLE_NAME}.night`),
  });

  // The sheet closes itself on a read, and the name lands in the field.
  await expect(page.locator('.mnhome-qrscan')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByRole('textbox').first()).toHaveValue(`${RESOLVABLE_NAME}.night`);
  await expect.poll(stops).toBe(1);
});
