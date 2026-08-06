"use strict";

/* ------------------------------------------------------------------ *
 * p256-gate WebAuthn capture harness.
 * Vanilla JS, no dependencies, fully offline. Captures a real passkey
 * assertion (ES256 / P-256 only) and exports vector.json for the
 * in-circuit Rust verifier. The Rust side recomputes every derived
 * value from the raw fields; nothing here is trusted.
 * ------------------------------------------------------------------ */

const CHALLENGE_SOURCE = "midnight:p256-gate:test-challenge:v1";
const VECTOR_FORMAT = "p256-gate-webauthn-v1";

/* ----------------------------- helpers ---------------------------- */

function bytesToHex(bytes) {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function hexToBytes(hex) {
  if (hex.length % 2 !== 0) throw new Error("hexToBytes: odd length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
    if (Number.isNaN(byte)) throw new Error("hexToBytes: bad hex at " + i);
    out[i] = byte;
  }
  return out;
}

// base64url without padding (WebAuthn convention).
function bytesToB64url(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(s) {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) b64 += "=";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* --------------------------- SPKI parsing ------------------------- */

// A P-256 SPKI with an uncompressed point is always exactly 91 bytes:
//   SEQUENCE(89)
//     SEQUENCE(19)
//       OID 1.2.840.10045.2.1      (id-ecPublicKey)
//       OID 1.2.840.10045.3.1.7    (prime256v1)
//     BIT STRING(66) = 0x00 unused-bits || 0x04 || x(32) || y(32)
// We verify the entire 27-byte prefix (both OIDs, the BIT STRING header,
// the 0x00 unused-bits byte, and the 0x04 uncompressed-point tag) before
// trusting the point offsets, and fail loudly on any mismatch.
const SPKI_P256_PREFIX = hexToBytes(
  "3059301306072a8648ce3d020106082a8648ce3d03010703420004"
);

function parseSpkiP256(spki) {
  const bytes = new Uint8Array(spki);
  if (bytes.length !== 91) {
    throw new Error(
      "SPKI is " + bytes.length + " bytes, expected 91 for an uncompressed " +
      "P-256 key. The credential is not P-256 (or the point is compressed)."
    );
  }
  const prefix = bytes.slice(0, SPKI_P256_PREFIX.length);
  if (!bytesEqual(prefix, SPKI_P256_PREFIX)) {
    throw new Error(
      "SPKI prefix mismatch: expected id-ecPublicKey + prime256v1 + " +
      "uncompressed point header (" + bytesToHex(SPKI_P256_PREFIX) +
      "), got " + bytesToHex(prefix) + ". Refusing to parse."
    );
  }
  const x = bytes.slice(27, 59);
  const y = bytes.slice(59, 91);
  return { x, y };
}

/* ------------------------ DER signature parsing -------------------- */

// ECDSA-Sig-Value ::= SEQUENCE { r INTEGER, s INTEGER }
// Returns r and s left-padded to 32 bytes. Rejects non-minimal and
// out-of-range encodings. The vector keeps the raw DER; this parser is
// for on-screen sanity display and the self-test only.
function parseDerEcdsaSig(der) {
  const bytes = new Uint8Array(der);
  if (bytes.length < 8) throw new Error("DER sig too short");
  if (bytes[0] !== 0x30) throw new Error("DER sig: expected SEQUENCE (0x30)");
  const seqLen = bytes[1];
  if (seqLen >= 0x80) throw new Error("DER sig: long-form length not expected");
  if (bytes.length !== 2 + seqLen) {
    throw new Error("DER sig: declared length " + seqLen +
      " does not match actual " + (bytes.length - 2));
  }
  let off = 2;
  const ints = [];
  for (const name of ["r", "s"]) {
    if (bytes[off] !== 0x02) {
      throw new Error("DER sig: expected INTEGER for " + name);
    }
    const len = bytes[off + 1];
    if (len < 1 || len > 33) {
      throw new Error("DER sig: " + name + " length " + len + " out of range");
    }
    const val = bytes.slice(off + 2, off + 2 + len);
    if (val.length !== len) throw new Error("DER sig: truncated " + name);
    if (val[0] & 0x80) {
      throw new Error("DER sig: " + name + " negative (missing 0x00 pad?)");
    }
    if (len > 1 && val[0] === 0x00 && !(val[1] & 0x80)) {
      throw new Error("DER sig: " + name + " not minimally encoded");
    }
    let start = 0;
    while (start < val.length - 1 && val[start] === 0x00) start++;
    const trimmed = val.slice(start);
    if (trimmed.length > 32) {
      throw new Error("DER sig: " + name + " wider than 32 bytes");
    }
    const padded = new Uint8Array(32);
    padded.set(trimmed, 32 - trimmed.length);
    ints.push(padded);
    off += 2 + len;
  }
  if (off !== bytes.length) throw new Error("DER sig: trailing bytes");
  return { r: ints[0], s: ints[1] };
}

/* ---------------------- display helpers --------------------------- */

function decodeAuthDataFlags(flagsByte) {
  const bits = [
    [0x01, "UP (user present)"],
    [0x04, "UV (user verified)"],
    [0x08, "BE (backup eligible)"],
    [0x10, "BS (backed up)"],
    [0x40, "AT (attested credential data)"],
    [0x80, "ED (extension data)"],
  ];
  const set = bits.filter(([mask]) => flagsByte & mask).map(([, name]) => name);
  return "0x" + flagsByte.toString(16).padStart(2, "0") +
    (set.length ? " = " + set.join(", ") : " = (none)");
}

function show(id, text, cls) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = cls || "";
}

/* --------------------------- state -------------------------------- */

const state = {
  credentialIdB64url: null,
  pkX: null, // Uint8Array(32)
  pkY: null, // Uint8Array(32)
  challenge: null, // Uint8Array(32)
};

/* ------------------------ button A: create ------------------------ */

async function createPasskey() {
  try {
    if (!navigator.credentials || !navigator.credentials.create) {
      throw new Error("WebAuthn is not available in this browser context.");
    }
    const userId = crypto.getRandomValues(new Uint8Array(16));
    const cred = await navigator.credentials.create({
      publicKey: {
        rp: { name: "p256-gate", id: "localhost" },
        user: {
          id: userId,
          name: "p256-gate-test",
          displayName: "P256 Gate Test",
        },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256 only
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          userVerification: "required",
        },
        attestation: "none",
      },
    });
    if (!cred) throw new Error("credentials.create returned null.");

    const resp = cred.response;
    if (typeof resp.getPublicKeyAlgorithm === "function") {
      const alg = resp.getPublicKeyAlgorithm();
      if (alg !== -7) {
        throw new Error(
          "Authenticator returned COSE alg " + alg +
          ", expected -7 (ES256). Refusing this credential."
        );
      }
    }
    if (typeof resp.getPublicKey !== "function") {
      throw new Error(
        "response.getPublicKey() is unavailable in this browser. " +
        "Use a browser that implements it (Safari 16+, Chrome 85+); " +
        "this harness does not parse attestationObject CBOR."
      );
    }
    const spki = resp.getPublicKey();
    if (!spki) throw new Error("getPublicKey() returned null.");
    const { x, y } = parseSpkiP256(spki);

    state.credentialIdB64url = bytesToB64url(new Uint8Array(cred.rawId));
    state.pkX = x;
    state.pkY = y;

    show(
      "out-create",
      [
        "credential id (b64url): " + state.credentialIdB64url,
        "SPKI length: " + spki.byteLength + " bytes (prefix verified: " +
          "id-ecPublicKey + prime256v1 + uncompressed point)",
        "pk.x: " + bytesToHex(x),
        "pk.y: " + bytesToHex(y),
      ].join("\n"),
      "ok"
    );
    document.getElementById("btn-sign").disabled = false;
  } catch (e) {
    show("out-create", "FAILED: " + e.message, "err");
  }
}

/* ------------------------- button B: sign ------------------------- */

async function computeChallenge() {
  const ascii = new TextEncoder().encode(CHALLENGE_SOURCE);
  const digest = await crypto.subtle.digest("SHA-256", ascii);
  return new Uint8Array(digest);
}

async function signChallenge() {
  try {
    if (!state.credentialIdB64url) {
      throw new Error("Create a passkey first (button A).");
    }
    const challenge = state.challenge;
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [
          {
            type: "public-key",
            id: b64urlToBytes(state.credentialIdB64url),
          },
        ],
        userVerification: "required",
        rpId: "localhost",
      },
    });
    if (!assertion) throw new Error("credentials.get returned null.");

    const resp = assertion.response;
    const authData = new Uint8Array(resp.authenticatorData);
    const clientDataJSON = new Uint8Array(resp.clientDataJSON);
    const sigDer = new Uint8Array(resp.signature);

    // Sanity display only; the vector carries the raw bytes.
    const { r, s } = parseDerEcdsaSig(sigDer);
    const clientDataText = new TextDecoder().decode(clientDataJSON);
    const clientDataPretty = JSON.stringify(
      JSON.parse(clientDataText), null, 2
    );
    const flags = authData.length > 32 ? authData[32] : null;

    const vector = {
      format: VECTOR_FORMAT,
      credential_id_b64url: state.credentialIdB64url,
      pk_x_hex: bytesToHex(state.pkX),
      pk_y_hex: bytesToHex(state.pkY),
      signature_der_hex: bytesToHex(sigDer),
      authenticator_data_hex: bytesToHex(authData),
      client_data_json_b64url: bytesToB64url(clientDataJSON),
      challenge_hex: bytesToHex(challenge),
    };
    const vectorText = JSON.stringify(vector, null, 2);

    show(
      "out-sign",
      [
        "authenticatorData: " + authData.length + " bytes, flags " +
          (flags === null ? "(too short!)" : decodeAuthDataFlags(flags)),
        "signature (DER): " + sigDer.length + " bytes",
        "  r: " + bytesToHex(r),
        "  s: " + bytesToHex(s),
        "clientDataJSON (" + clientDataJSON.length + " bytes):",
        clientDataPretty,
      ].join("\n"),
      "ok"
    );
    show("out-vector", vectorText, "ok");

    // Trigger the download.
    const blob = new Blob([vectorText + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "vector.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    show("out-sign", "FAILED: " + e.message, "err");
  }
}

/* --------------------------- self-test ----------------------------- */

// Known-good vector generated offline with the openssl CLI:
//   openssl ecparam -name prime256v1 -genkey -noout -out key.pem
//   openssl ec -in key.pem -pubout -outform DER -out pub.der
//   printf 'p256-gate self-test message v1' > msg.bin
//   openssl dgst -sha256 -sign key.pem -out sig.der msg.bin
// Structure independently verified with a python3 DER walker; the
// public key point was checked to lie on the P-256 curve and r, s to
// lie in [1, n-1].
const SELFTEST = {
  spkiHex:
    "3059301306072a8648ce3d020106082a8648ce3d030107034200" +
    "04d84d45b39fc45933b94f08acd619eceb4d9ded56c80eb4b6f6e36d63a55d63ba" +
    "d5c45db946489428ab7e0d89c9d4265c02db022cb6bec312c3ab57c906a1f9a0",
  expectedX: "d84d45b39fc45933b94f08acd619eceb4d9ded56c80eb4b6f6e36d63a55d63ba",
  expectedY: "d5c45db946489428ab7e0d89c9d4265c02db022cb6bec312c3ab57c906a1f9a0",
  sigDerHex:
    "3046" +
    "022100" + "82350d1e4a4d3310bcd734f09be127e03fe148b9175d5a486acc60b7774cd867" +
    "022100" + "c71a417d9827d4f6841c81a77db48f17ac09bc98e5db65f741ab2b61f68fc029",
  expectedR: "82350d1e4a4d3310bcd734f09be127e03fe148b9175d5a486acc60b7774cd867",
  expectedS: "c71a417d9827d4f6841c81a77db48f17ac09bc98e5db65f741ab2b61f68fc029",
};

function runSelfTest() {
  const results = [];
  let failed = 0;
  const check = (name, fn) => {
    try {
      fn();
      results.push("PASS  " + name);
    } catch (e) {
      failed++;
      results.push("FAIL  " + name + ": " + e.message);
    }
  };
  const assertEq = (got, want, what) => {
    if (got !== want) {
      throw new Error(what + "\n  got  " + got + "\n  want " + want);
    }
  };

  check("hex round-trip", () => {
    const v = new Uint8Array([0x00, 0x01, 0x7f, 0x80, 0xff]);
    assertEq(bytesToHex(hexToBytes(bytesToHex(v))), "00017f80ff", "hex");
  });

  check("base64url round-trip, no padding", () => {
    const v = hexToBytes("fbff0001");
    const b = bytesToB64url(v);
    if (b.includes("=") || b.includes("+") || b.includes("/")) {
      throw new Error("not base64url or padded: " + b);
    }
    assertEq(bytesToHex(b64urlToBytes(b)), "fbff0001", "b64url");
  });

  check("SPKI parser extracts x and y", () => {
    const { x, y } = parseSpkiP256(hexToBytes(SELFTEST.spkiHex).buffer);
    assertEq(bytesToHex(x), SELFTEST.expectedX, "x");
    assertEq(bytesToHex(y), SELFTEST.expectedY, "y");
  });

  check("SPKI parser rejects a corrupted OID", () => {
    const bad = hexToBytes(SELFTEST.spkiHex);
    bad[10] ^= 0x01; // flip a bit inside id-ecPublicKey
    let threw = false;
    try { parseSpkiP256(bad.buffer); } catch { threw = true; }
    if (!threw) throw new Error("accepted a corrupted SPKI prefix");
  });

  check("SPKI parser rejects a wrong-length key", () => {
    let threw = false;
    try { parseSpkiP256(hexToBytes(SELFTEST.spkiHex).buffer.slice(0, 90)); }
    catch { threw = true; }
    if (!threw) throw new Error("accepted a 90-byte SPKI");
  });

  check("DER parser extracts r and s", () => {
    const { r, s } = parseDerEcdsaSig(hexToBytes(SELFTEST.sigDerHex).buffer);
    assertEq(bytesToHex(r), SELFTEST.expectedR, "r");
    assertEq(bytesToHex(s), SELFTEST.expectedS, "s");
  });

  check("DER parser pads a short r to 32 bytes", () => {
    // r = 0x05 (1 byte), s = 32 bytes with high bit set (0x00-padded).
    const der =
      "3026" +
      "0201" + "05" +
      "022100" + SELFTEST.expectedS;
    const { r, s } = parseDerEcdsaSig(hexToBytes(der).buffer);
    assertEq(bytesToHex(r), "00".repeat(31) + "05", "short r padded");
    assertEq(bytesToHex(s), SELFTEST.expectedS, "s");
  });

  check("DER parser rejects trailing bytes", () => {
    let threw = false;
    try { parseDerEcdsaSig(hexToBytes(SELFTEST.sigDerHex + "00").buffer); }
    catch { threw = true; }
    if (!threw) throw new Error("accepted trailing bytes");
  });

  check("DER parser rejects non-minimal integers", () => {
    // 0x00 pad before a byte without the high bit set. Content is
    // 02 02 00 05 (4 bytes) + 02 01 01 (3 bytes) = 7 bytes.
    const der = "3007" + "0202" + "0005" + "0201" + "01";
    let threw = false;
    try { parseDerEcdsaSig(hexToBytes(der).buffer); }
    catch { threw = true; }
    if (!threw) throw new Error("accepted non-minimal INTEGER");
  });

  show(
    "out-selftest",
    results.join("\n") + "\n\n" +
      (failed === 0 ? "ALL PASS" : failed + " FAILURE(S)"),
    failed === 0 ? "ok" : "err"
  );
}

/* ----------------------------- wiring ------------------------------ */

document.getElementById("btn-create").addEventListener("click", createPasskey);
document.getElementById("btn-sign").addEventListener("click", signChallenge);
document.getElementById("btn-selftest").addEventListener("click", runSelfTest);
document.getElementById("challenge-src").textContent = CHALLENGE_SOURCE;

computeChallenge().then((c) => {
  state.challenge = c;
  show("out-challenge", bytesToHex(c), "field");
}).catch((e) => {
  show("out-challenge", "FAILED to compute challenge: " + e.message, "err");
});
