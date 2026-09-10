import React, { useMemo, useState } from 'react';

import { PassportAccount } from '../../../src/wallet/account.js';
import { bytesToHex } from '../../../src/wallet/hex.js';
import { recoveryCommitment, deviceCommitment } from '../../../src/wallet/contract.js';

import {
  buss,
  newSessionNonce,
  paramsFromPhi,
  phiBytesFromField,
  encodeGuardianRequest,
  decodeGuardianRequest,
  encodeGuardianReply,
  decodeGuardianReply,
  decodePaperKey,
  encodePaperKey,
  classifyPaste,
  type GuardianReply,
  type PaperKey,
} from '../lib/buss.js';
import { createPasskey, deriveDeviceSecret, deriveDevModeSecret } from '../lib/passkey.js';
import type { Session } from '../lib/session.js';
import { ViewHeader, Panel, ActionButton, Chip, StatTile, Mono } from '../ui.js';
import type { AppContext } from '../App.js';

// ── Ceremony state ────────────────────────────────────────────────────────────

interface PersonSlot {
  kind: 'person';
  index: number;
  reply: GuardianReply | null;
  pasteError: string | null;
}

interface PaperSlot {
  kind: 'paper';
  index: number;
  paper: PaperKey;
  written: boolean;
}

type Slot = PersonSlot | PaperSlot;

interface Ceremony {
  secret: Uint8Array; // freshly rotated recovery secret (never persisted)
  nonce: Uint8Array; // fresh session nonce (BUSS rule: one per publication)
  nonceHex: string;
  threshold: number;
  slots: Slot[];
}

export function RecoveryPanel(props: {
  ctx: AppContext;
  onRecovered: (s: Session, a: PassportAccount, commitment?: string) => void;
}) {
  const { ctx } = props;
  const phiLen = ctx.ledger ? Number(ctx.ledger.recovery_phi_len) : 0;

  return (
    <>
      <ViewHeader
        title="Recovery"
        narration="Guardians derive their share on demand from a key they already hold — a person's passport, or a paper key you wrote down. They store nothing. On-chain there is only a commitment and a few public points that provably leak nothing; a threshold quorum plus those points re-keys the account (P5)."
      />
      <BackupPanel ctx={ctx} phiLen={phiLen} />
      <GuardianModePanel ctx={ctx} />
      <RecoverPanel ctx={ctx} phiLen={phiLen} onRecovered={props.onRecovered} />
    </>
  );
}

// ── Backup: status + enrolment ceremony ───────────────────────────────────────

function BackupPanel({ ctx, phiLen }: { ctx: AppContext; phiLen: number }) {
  const { ledger, account, log } = ctx;
  const [people, setPeople] = useState(1);
  const [papers, setPapers] = useState(2);
  const [threshold, setThreshold] = useState(2);
  const [ceremony, setCeremony] = useState<Ceremony | null>(null);

  const live = phiLen > 0;
  const guardians = people + papers;
  const phiNeeded = guardians - threshold + 1;
  const configError =
    guardians < 1
      ? 'enrol at least one guardian'
      : threshold < 1 || threshold > guardians
        ? `threshold must be between 1 and ${guardians}`
        : phiNeeded > 4
          ? 'this contract stores at most 4 public points — raise the threshold or drop guardians'
          : null;

  const begin = () => {
    const nonce = newSessionNonce();
    const slots: Slot[] = [];
    for (let i = 1; i <= people; i++) {
      slots.push({ kind: 'person', index: i, reply: null, pasteError: null });
    }
    for (let i = people + 1; i <= guardians; i++) {
      slots.push({ kind: 'paper', index: i, paper: buss.newPaperKey(i), written: false });
    }
    setCeremony({
      secret: buss.newRecoverySecret(),
      nonce,
      nonceHex: bytesToHex(nonce),
      threshold,
      slots,
    });
  };

  const ready =
    ceremony !== null &&
    ceremony.slots.every((s) => (s.kind === 'person' ? s.reply !== null : s.written));

  // ── No ceremony running: status + launcher ──────────────────────────────
  if (!ceremony) {
    return (
      <Panel
        title="Guardian backup"
        sub={
          live
            ? 'A backup is live on-chain. Its guardians can restore this account after total loss.'
            : 'No backup published yet — enrol guardians so total loss becomes survivable.'
        }
        x="BUSS (bottom-up secret sharing, the ANARKey construction): each guardian's share is derived from their own key and a public session identifier, so nothing is dealt out or stored. The owner publishes a few public points (φ) that, combined with any threshold quorum of shares, reconstruct the recovery secret — and are provably useless below the threshold (I-6.4)."
      >
        {live && ledger && (
          <div className="row backup-stats">
            <StatTile label="public points φ" value={String(phiLen)} />
            <StatTile label="device epoch" value={String(ledger.device_epoch)} />
            <div className="docfield">
              <span className="docfield-k">session nonce</span>
              <span className="docfield-v">
                <Mono v={bytesToHex(ledger.recovery_session)} short />
              </span>
            </div>
          </div>
        )}
        {live && (
          <p className="hint">
            Who the guardians are, and how many, is deliberately <em>not</em> on-chain — only
            these {phiLen} public points and a commitment. Keep remembering your guardians and
            the threshold.
          </p>
        )}

        <div className="ceremony-cfg">
          <label className="field field-inline">
            <span className="field-label">passport guardians</span>
            <CountSelect value={people} onChange={setPeople} max={3} />
          </label>
          <label className="field field-inline">
            <span className="field-label">paper keys</span>
            <CountSelect value={papers} onChange={setPapers} max={3} />
          </label>
          <label className="field field-inline">
            <span className="field-label">needed to recover</span>
            <CountSelect value={threshold} onChange={setThreshold} min={1} max={guardians} />
          </label>
          <ActionButton
            label={live ? 'Replace backup' : 'Begin enrolment'}
            kind={live ? 'ghost' : 'primary'}
            disabled={configError !== null}
            onRun={async () => {
              begin();
            }}
          />
        </div>
        {configError && <p className="paste-err">{configError}</p>}
        {live && (
          <p className="hint">
            Replacing runs a fresh ceremony with a fresh secret and session — every guardian is
            re-asked, and the old backup becomes worthless the moment the new one lands. That is
            also how you add or remove a guardian.
          </p>
        )}
      </Panel>
    );
  }

  // ── Ceremony in progress ─────────────────────────────────────────────────
  return (
    <Panel
      title="Guardian enrolment"
      sub={`${ceremony.slots.length} guardians, any ${ceremony.threshold} recover. One fresh session — finish and publish in one go.`}
      x="Each passport guardian answers the request with σ = H(session ‖ their key) — one message, nothing stored on their side. Paper keys are random field elements: write the slip down and it IS the guardian. Publishing stores the rotated commitment, the session nonce, and the φ points in one transaction."
    >
      <div className="guardian-grid">
        {ceremony.slots.map((slot) =>
          slot.kind === 'person' ? (
            <PersonSlotCard
              key={slot.index}
              slot={slot}
              request={encodeGuardianRequest({
                address: account.address,
                sessionNonce: ceremony.nonceHex,
                index: slot.index,
              })}
              onReply={(raw) => {
                setCeremony((c) => {
                  if (!c) return c;
                  const slots = c.slots.map((s) => {
                    if (s.kind !== 'person' || s.index !== slot.index) return s;
                    if (!raw.trim()) return { ...s, reply: null, pasteError: null };
                    try {
                      const reply = decodeGuardianReply(raw);
                      if (reply.index !== s.index) {
                        return {
                          ...s,
                          reply: null,
                          pasteError: `that reply is for guardian ${reply.index}, this slot is ${s.index}`,
                        };
                      }
                      return { ...s, reply, pasteError: null };
                    } catch (e: any) {
                      return { ...s, reply: null, pasteError: String(e?.message ?? e) };
                    }
                  });
                  return { ...c, slots };
                });
              }}
            />
          ) : (
            <PaperSlotCard
              key={slot.index}
              slot={slot}
              onWritten={(written) => {
                setCeremony((c) =>
                  c
                    ? {
                        ...c,
                        slots: c.slots.map((s) =>
                          s.kind === 'paper' && s.index === slot.index ? { ...s, written } : s,
                        ),
                      }
                    : c,
                );
              }}
            />
          ),
        )}
      </div>

      <div className="row controls">
        <ActionButton
          label="Publish backup on-chain"
          busyLabel="publishing…"
          block
          disabled={!ready}
          task={{ label: 'Publishing the recovery backup', circuit: 'publish_recovery_backup' }}
          onRun={async () => {
            const replies = ceremony.slots.map((s) =>
              s.kind === 'person'
                ? s.reply!
                : buss.paperSigma(s.paper, account.address, ceremony.nonceHex),
            );
            const params = { t: ceremony.threshold - 1, n: ceremony.slots.length + 1 };
            const phi = buss.buildPhi(ceremony.secret, replies, params);
            const r = await account.publishRecoveryBackup(ceremony.secret, ceremony.nonce, phi);
            log(
              `recovery backup published — ${phi.length} public points, rotated commitment → tx ${r.txId}`,
            );
            setCeremony(null); // drops the secret and the paper keys from memory
            await ctx.refreshLedger();
            return r.txId;
          }}
        />
        <button className="linkish" onClick={() => setCeremony(null)}>
          cancel ceremony
        </button>
      </div>
      {!ready && (
        <p className="hint">
          Collect every guardian's reply and tick every paper slip before publishing — a backup
          is one indivisible ceremony.
        </p>
      )}
    </Panel>
  );
}

function CountSelect(props: {
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max: number;
}) {
  const min = props.min ?? 0;
  const options = [];
  for (let i = min; i <= props.max; i++) options.push(i);
  return (
    <select value={props.value} onChange={(e) => props.onChange(Number(e.target.value))}>
      {options.map((i) => (
        <option key={i} value={i}>
          {i}
        </option>
      ))}
    </select>
  );
}

function PersonSlotCard(props: {
  slot: PersonSlot;
  request: string;
  onReply: (raw: string) => void;
}) {
  const { slot, request } = props;
  return (
    <div className={`gslot ${slot.reply ? 'gslot-done' : ''}`}>
      <div className="gslot-head">
        <span className="gslot-n">{slot.index}</span>
        <Chip tone={slot.reply ? 'ok' : 'muted'}>
          {slot.reply ? 'σ received' : 'passport guardian'}
        </Chip>
      </div>
      <span className="gslot-k">hand them this request — click to copy</span>
      <Mono v={request} className="wire" />
      <span className="gslot-k">paste their reply</span>
      <input
        className="paste-input"
        placeholder="buss-sig.v0.…"
        onChange={(e) => props.onReply(e.target.value)}
        spellCheck={false}
      />
      {slot.pasteError && <p className="paste-err">{slot.pasteError}</p>}
    </div>
  );
}

function PaperSlotCard(props: { slot: PaperSlot; onWritten: (w: boolean) => void }) {
  const { slot } = props;
  return (
    <div className={`gslot ${slot.written ? 'gslot-done' : ''}`}>
      <div className="gslot-head">
        <span className="gslot-n">{slot.index}</span>
        <Chip tone={slot.written ? 'ok' : 'muted'}>paper key</Chip>
      </div>
      <span className="gslot-k">write this slip down — it IS the guardian</span>
      <div className="slip">
        <Mono v={encodePaperKey(slot.paper)} className="wire" />
      </div>
      <label className="devmode-row">
        <input
          type="checkbox"
          checked={slot.written}
          onChange={(e) => props.onWritten(e.target.checked)}
        />
        written down, stored away from this device
      </label>
    </div>
  );
}

// ── Guardian mode: answer someone else's request ──────────────────────────────

function GuardianModePanel({ ctx }: { ctx: AppContext }) {
  const { session, log } = ctx;
  const [raw, setRaw] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [reply, setReply] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decoded = useMemo(() => {
    try {
      return decodeGuardianRequest(raw);
    } catch {
      return null;
    }
  }, [raw]);

  return (
    <Panel
      title="Act as a guardian"
      sub="Someone asked this passport to guard theirs. Paste their request; your reply is derived from your own key — you store nothing, at enrolment or years later at recovery."
      x="σ = H(session ‖ your guardian key), where the guardian key is derived from this device's secret. Deterministic: the same request always gets the same answer, which is why a guardian who kept nothing can still help recover. The reply is a share, not a key — it is useless below the owner's threshold."
    >
      <div className="row">
        <input
          className="paste-input grow"
          placeholder="buss-req.v0.…"
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            setReply(null);
            setError(null);
          }}
          spellCheck={false}
        />
      </div>
      {raw.trim() && !decoded && <p className="paste-err">not a valid guardian request</p>}
      {decoded && (
        <p className="hint">
          Request from account <Mono v={decoded.address} short /> — you are their guardian{' '}
          <b>#{decoded.index}</b>.
        </p>
      )}
      {session.devMode && (
        <label className="field">
          <span className="field-label">dev-mode passphrase</span>
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
        </label>
      )}
      <ActionButton
        label={session.devMode ? 'Answer (dev mode)' : 'Answer with your passkey'}
        busyLabel="deriving σ…"
        disabled={!decoded}
        onError={setError}
        onRun={async () => {
          if (!decoded) return;
          const deviceSecret = session.devMode
            ? await deriveDevModeSecret(passphrase)
            : await deriveDeviceSecret(session.passkey);
          const sk = buss.guardianSkFromDeviceSecret(deviceSecret);
          setReply(encodeGuardianReply(buss.computeSigma(decoded, sk)));
          log(`answered a guardian request for ${decoded.address.slice(0, 12)}… (index ${decoded.index})`);
        }}
      />
      {error && <p className="error">{error}</p>}
      {reply && (
        <div className="sigma-out">
          <span className="gslot-k">your reply — click to copy, hand it back</span>
          <Mono v={reply} className="wire" />
        </div>
      )}
    </Panel>
  );
}

// ── Total-loss recovery ───────────────────────────────────────────────────────

function RecoverPanel(props: {
  ctx: AppContext;
  phiLen: number;
  onRecovered: (s: Session, a: PassportAccount, commitment?: string) => void;
}) {
  const { ctx, phiLen } = props;
  const { ledger, log, session } = ctx;
  const [guardianCount, setGuardianCount] = useState(3);
  const [quorum, setQuorum] = useState<{ reply: GuardianReply; kind: 'reply' | 'paper' }[]>([]);
  const [paste, setPaste] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [devMode, setDevMode] = useState(false);
  const [passphrase, setPassphrase] = useState('');

  const params = paramsFromPhi(phiLen, guardianCount);
  const threshold = params.t + 1;
  const countValid = threshold >= 1 && threshold <= guardianCount;
  const enough = countValid && quorum.length >= threshold;

  const addPaste = () => {
    setPasteError(null);
    if (!ledger) return;
    const sessionHex = bytesToHex(ledger.recovery_session);
    try {
      const kind = classifyPaste(paste);
      let entry: { reply: GuardianReply; kind: 'reply' | 'paper' };
      if (kind === 'reply') {
        entry = { reply: decodeGuardianReply(paste), kind: 'reply' };
      } else if (kind === 'paper') {
        const paper = decodePaperKey(paste);
        entry = { reply: buss.paperSigma(paper, ctx.account.address, sessionHex), kind: 'paper' };
      } else if (kind === 'request') {
        throw new Error('that is a request — paste a guardian reply or a paper slip');
      } else {
        throw new Error('paste a buss-sig.v0.… reply or a buss-paper.v0.… slip');
      }
      if (quorum.some((q) => q.reply.index === entry.reply.index)) {
        throw new Error(`guardian ${entry.reply.index} is already in the quorum`);
      }
      setQuorum((q) => [...q, entry]);
      setPaste('');
    } catch (e: any) {
      setPasteError(String(e?.message ?? e));
    }
  };

  return (
    <Panel
      title="Total loss — re-issue this passport"
      sub="Pretend every device is gone. Assemble a guardian quorum, rebuild the recovery secret from the public points, and re-key the account with a brand-new passkey."
      x="Recovery interpolates the polynomial through the on-chain φ points and the quorum's σ values, reads the secret, and checks it against the on-chain commitment. The recover circuit then proves knowledge of it, bumps the device epoch — retiring every device and grant — and clears the spent backup (the secret rotates with it)."
    >
      {phiLen === 0 ? (
        <p className="hint">No backup is published — run the guardian enrolment above first.</p>
      ) : (
        <>
          <div className="row">
            <label className="field field-inline">
              <span className="field-label">guardians enrolled</span>
              <CountSelect value={guardianCount} onChange={setGuardianCount} min={1} max={6} />
            </label>
            <StatTile
              label="quorum needed"
              value={countValid ? `${threshold} of ${guardianCount}` : '—'}
            />
            <StatTile label="collected" value={`${quorum.length}`} />
          </div>
          <p className="hint">
            The guardian count is not on-chain (nothing about your social graph is) — the
            recovering party must know it. Ask a passport guardian via “Act as a guardian” on
            their device, or type a paper slip.
          </p>
          {!countValid && (
            <p className="paste-err">
              {guardianCount} guardians cannot match the {phiLen} public points on-chain — the
              count is wrong.
            </p>
          )}

          <div className="row">
            <input
              className="paste-input grow"
              placeholder="buss-sig.v0.… or buss-paper.v0.…"
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addPaste()}
              spellCheck={false}
            />
            <button className="btn btn-ghost" onClick={addPaste} disabled={!paste.trim()}>
              add to quorum
            </button>
          </div>
          {pasteError && <p className="paste-err">{pasteError}</p>}

          {quorum.length > 0 && (
            <div className="quorum-list">
              {quorum.map((q) => (
                <span className="quorum-item" key={q.reply.index}>
                  <b>#{q.reply.index}</b> {q.kind === 'paper' ? 'paper key' : 'guardian σ'}
                  <button
                    className="quorum-x"
                    title="remove"
                    onClick={() =>
                      setQuorum((qs) => qs.filter((x) => x.reply.index !== q.reply.index))
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <label className="devmode-row">
            <input
              type="checkbox"
              checked={devMode}
              onChange={(e) => setDevMode(e.target.checked)}
            />
            dev mode — recover with a passphrase instead of a passkey
          </label>
          {devMode && (
            <label className="field">
              <span className="field-label">new passphrase</span>
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </label>
          )}

          <ActionButton
            label="Reconstruct & recover"
            busyLabel="recovering…"
            kind="danger"
            block
            disabled={!enough}
            task={{ label: 'Recovering the account', circuit: 'recover' }}
            onRun={async () => {
              if (!ledger) throw new Error('ledger not loaded yet');

              log(`TOTAL LOSS — reconstructing from ${quorum.length} shares + ${phiLen} public points…`);
              const phi = Array.from({ length: phiLen }, (_, i) =>
                phiBytesFromField(ledger.recovery_phi.lookup(BigInt(i + 1))),
              );
              const secret = buss.reconstructRecoverySecret(
                phi,
                quorum.map((q) => q.reply),
                params,
              );
              if (recoveryCommitment(secret) !== ledger.recovery) {
                throw new Error(
                  'quorum does not match the on-chain commitment — wrong guardian count, or a wrong entry?',
                );
              }
              log('reconstructed secret matches the on-chain commitment.');

              let newDeviceSecret: Uint8Array;
              let newSession: Session;
              if (devMode) {
                if (!passphrase) throw new Error('enter a new dev-mode passphrase');
                newDeviceSecret = await deriveDevModeSecret(passphrase);
                newSession = { accountAddress: session.accountAddress, devMode: true };
              } else {
                const ref = await createPasskey('recovered-device');
                newDeviceSecret = await deriveDeviceSecret(ref);
                newSession = { accountAddress: session.accountAddress, passkey: ref };
              }

              const recoverer = await ctx.reconnect({ recoverySecret: secret });
              const r = await recoverer.recover(newDeviceSecret, buss.newRecoverySecret());
              log(
                `recover → tx ${r.txId} — old devices, grants, and the spent backup are dead; enrol new guardians.`,
              );

              const account = await ctx.reconnect({ deviceSecret: newDeviceSecret });
              props.onRecovered(newSession, account, deviceCommitment(newDeviceSecret).toString());
              setQuorum([]);
              await ctx.refreshLedger();
              return r.txId;
            }}
          />
        </>
      )}
    </Panel>
  );
}
