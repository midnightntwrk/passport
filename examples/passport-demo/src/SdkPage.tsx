import {
  ArrowUpRight,
  Box,
  Database,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  ShieldCheck,
  WalletCards,
} from 'lucide-react';
import type { ReactNode } from 'react';

const integrationSnippet = `const store = new EncryptedPassportPrivateStateStore(
  new IndexedDbPassportEncryptedRecordStore(),
  new WebAuthnPrfKeyProvider(passkeyReference),
);

const { privateState } = await PassportStateInjection({
  store,
  scope: { appId, accountId },
  initialPrivateState,
});

await join({ initialPrivateState: privateState });`;

function ArchitectureStep({
  number,
  title,
  detail,
  icon,
}: {
  number: string;
  title: string;
  detail: string;
  icon: ReactNode;
}) {
  return (
    <article className="sdk-architecture-step">
      <span className="sdk-step-number">{number}</span>
      <span className="sdk-step-icon">{icon}</span>
      <div><h3>{title}</h3><p>{detail}</p></div>
    </article>
  );
}

export default function SdkPage() {
  return (
    <main className="sdk-page">
      <header className="sdk-header">
        <a className="sdk-brand" href="/" aria-label="Open Midnight Passport">
          <img src="/midnight-wordmark.svg" alt="Midnight" />
          <span />
          <strong>Passport SDK</strong>
        </a>
        <a className="sdk-open-portal" href="/">Open Passport <ArrowUpRight size={16} /></a>
      </header>

      <section className="sdk-hero" aria-labelledby="sdk-title">
        <img className="sdk-hero-art" src="/passport-sdk-architecture.png" alt="" aria-hidden="true" />
        <div className="sdk-hero-copy">
          <p className="sdk-eyebrow">Passport SDK</p>
          <h1 id="sdk-title">Private state,<br />one honest boundary.</h1>
          <p>The SDK keeps app-owned private state encrypted and scoped to a Passport account. Dynamic provides identity and the Midnight wallet; Passport protects local state before a contract join or deploy boundary.</p>
        </div>
        <div className="sdk-hero-proof">
          <span><LockKeyhole size={16} /> AES-GCM envelope</span>
          <span><Fingerprint size={16} /> WebAuthn PRF unlock</span>
          <span><Database size={16} /> IndexedDB only</span>
        </div>
      </section>

      <section className="sdk-architecture" aria-labelledby="architecture-title">
        <div className="sdk-section-heading"><p className="sdk-eyebrow">Architecture</p><h2 id="architecture-title">Four clear responsibilities.</h2></div>
        <div className="sdk-architecture-grid">
          <ArchitectureStep number="01" icon={<WalletCards size={20} />} title="Dynamic wallet" detail="Social login, embedded Midnight wallet, the three address surfaces, balance sync, message signing and supported transfers." />
          <ArchitectureStep number="02" icon={<KeyRound size={20} />} title="Passport key" detail="A user-gesture WebAuthn PRF passkey derives a non-exportable encryption key. It is not the wallet key." />
          <ArchitectureStep number="03" icon={<LockKeyhole size={20} />} title="Private-state vault" detail="A versioned encrypted envelope is isolated by app and Passport account. No plaintext, raw PRF output or witness is persisted." />
          <ArchitectureStep number="04" icon={<Box size={20} />} title="Contract boundary" detail="PassportStateInjection provides typed state only at the app's initialPrivateState join or deploy boundary." />
        </div>
      </section>

      <section className="sdk-code-section" aria-labelledby="integration-title">
        <div className="sdk-code-copy"><p className="sdk-eyebrow">Integration</p><h2 id="integration-title">A narrow API surface.</h2><p>The app owns the private-state schema. Passport owns encryption, scope isolation and the unlock boundary.</p><div className="sdk-code-notes"><span><ShieldCheck size={15} /> No localStorage secrets</span><span><ShieldCheck size={15} /> No cloud witness sync</span><span><ShieldCheck size={15} /> No wallet-seed ownership</span></div></div>
        <pre className="sdk-code"><code>{integrationSnippet}</code></pre>
      </section>

      <section className="sdk-boundaries" aria-labelledby="boundaries-title">
        <div className="sdk-section-heading"><p className="sdk-eyebrow">Readiness</p><h2 id="boundaries-title">What the SDK does not pretend to solve.</h2></div>
        <div className="sdk-boundary-grid">
          <article><span>Live now</span><h3>Wallet surfaces</h3><p>Dynamic exposes the unshielded, shielded and DUST addresses, balance sync, signing and supported transfers.</p></article>
          <article><span>Live now</span><h3>Private-state encryption</h3><p>Passport encrypts app-owned state with a WebAuthn PRF-derived AES-GCM key in IndexedDB.</p></article>
          <article><span>Testnet pilot</span><h3>C1 Compact deployment</h3><p>Passport builds a Compact C1 deployment from the Dynamic wallet's shielded public keys, then asks Dynamic to sign and submit it. It stays testnet-only until a real transaction is confirmed on-chain.</p></article>
          <article><span>Deferred</span><h3>Cloud recovery and Sig settlement</h3><p>Encrypted sync, recovery design and external settlement stay outside this SDK foundation until their security and network dependencies are defined.</p></article>
        </div>
      </section>
    </main>
  );
}
