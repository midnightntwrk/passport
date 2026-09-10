# WebAuthn capture harness (p256-gate)

Captures a real passkey assertion (macOS Touch ID, or an iPhone passkey via
the cross-device flow) and saves the raw material as `vector.json`. The Rust
side of the experiment verifies that assertion's ECDSA P-256 signature inside
a midnight-zk circuit.

Vanilla JS, no frameworks, no CDN, fully offline. Python 3 stdlib server only.

## How to run

```sh
python3 serve.py
```

Open <http://localhost:8973> in Safari or Chrome (localhost is a secure
context, so WebAuthn works without TLS). Then:

1. Click **Create passkey**. Touch ID prompts. The harness requests an
   ES256-only (`alg: -7`) platform credential and extracts the public key via
   `response.getPublicKey()` (SPKI DER). It verifies the full SPKI prefix
   (id-ecPublicKey and prime256v1 OIDs, uncompressed point header) before
   trusting any byte offsets, and fails loudly if the credential is not P-256.
2. Click **Sign challenge**. Touch ID prompts again. The challenge is the
   SHA-256 of the ASCII string `midnight:p256-gate:test-challenge:v1`,
   computed at runtime with WebCrypto and shown as hex on the page.
3. The browser downloads `vector.json` (and renders the same JSON in a
   `<pre>` block for copy-paste). Move it into place:

```sh
mv ~/Downloads/vector.json experiments/p256-in-circuit/webauthn/vector.json
```

The **Self-test** button exercises the SPKI and DER parsers against a
known-good vector generated with the openssl CLI, without touching any
authenticator. Run it if the capture output looks suspicious.

## What the challenge binding means

WebAuthn authenticators never sign the challenge directly. The authenticator
signs `authenticatorData || SHA-256(clientDataJSON)`, and the browser embeds
the challenge (base64url) inside `clientDataJSON` together with the origin
and operation type. A verifier that checks the signature alone has proven
nothing about the challenge: it must also decode `clientDataJSON`, confirm
`challenge` matches the expected 32 bytes, confirm `type` is
`webauthn.get`, and confirm the `rpIdHash` in `authenticatorData` is the
SHA-256 of the expected relying-party identifier. Only then is the signature
bound to this specific challenge from this specific origin.

Two relations consume the capture. `P256EcdsaWebAuthn` verifies the
signature over the envelope and leaves those binding checks to the proof's
consumer (the `passkey` subcommand performs them natively on the public
inputs). `P256EcdsaWebAuthnEnvelope` performs every one of them inside the
circuit — clientDataJSON and authenticatorData become witnesses, and the
proof's public inputs shrink to the public key, the rpIdHash, and the
challenge.

## Trust model of vector.json

The JSON carries only raw captured bytes: public key coordinates, the DER
signature, `authenticatorData`, `clientDataJSON`, and the challenge. The
Rust verifier recomputes every derived value from those raw fields (the
signed message `authenticatorData || SHA-256(clientDataJSON)`, its SHA-256
digest, the challenge embedded in `clientDataJSON`, and the parsed `r` and
`s`), and does not trust anything the JS computed. The on-page decodes
(flags byte, pretty-printed clientDataJSON, r and s) are for human
eyeballing only.

## Vector format

```json
{
  "format": "p256-gate-webauthn-v1",
  "credential_id_b64url": "<string>",
  "pk_x_hex": "<64 hex chars, big-endian x coordinate>",
  "pk_y_hex": "<64 hex chars, big-endian y coordinate>",
  "signature_der_hex": "<hex, ASN.1 DER ECDSA-Sig-Value as returned by WebAuthn>",
  "authenticator_data_hex": "<hex, raw authenticatorData bytes>",
  "client_data_json_b64url": "<base64url of the raw clientDataJSON bytes>",
  "challenge_hex": "<64 hex chars, the 32-byte challenge passed to navigator.credentials.get>"
}
```

All base64url values are unpadded (WebAuthn convention).
