import React, {useState, useEffect, useMemo} from 'react';
import {Box, Text, useInput}                 from 'ink';
import TextInput                              from 'ink-text-input';
import SelectInput                            from 'ink-select-input';
import TxStatusComponent                      from '../components/TxStatus.js';
import type {WalletSyncState, SendRequest}    from '../hooks/useWalletSync.js';
import {useWallet}                            from '../hooks/useWallet.js';

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const NIGHT_ID = '0'.repeat(64);

/** True for an opaque hex contract token (not the native NIGHT token). */
function isRawToken(id: string): boolean {
  return id.length >= 32 && id !== NIGHT_ID;
}

function tokenLabel(id: string): string {
  if (id === NIGHT_ID) return 'NIGHT';
  // Truncate long hex IDs for display.
  return id.length > 12 ? id.slice(0, 8) + '…' + id.slice(-4) : id;
}

/** Format raw bigint for display: 6 decimal places for NIGHT, integer for others. */
function fmtAmount(id: string, raw: bigint): string {
  if (isRawToken(id)) return String(raw);
  const whole = raw / 1_000_000n;
  const frac  = raw % 1_000_000n;
  return `${whole}.${String(frac).padStart(6, '0')}`;
}

/**
 * Parse a user-entered amount string to raw bigint.
 * NIGHT uses 6 implied decimal places; raw-token amounts are integers.
 */
function parseAmount(s: string, id: string): bigint {
  s = s.trim();
  if (isRawToken(id)) return BigInt(s);
  const [whole, frac = ''] = s.split('.');
  const f6 = frac.padEnd(6, '0').slice(0, 6);
  if (!/^\d+$/.test(whole) || !/^\d+$/.test(f6)) throw new Error('invalid');
  return BigInt(whole) * 1_000_000n + BigInt(f6);
}

function amtPlaceholder(id: string): string {
  return isRawToken(id) ? '0' : '0.000000';
}

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

interface TokenChoice {
  type:    'shielded' | 'unshielded';
  tokenId: string;
  label:   string;
  max:     bigint;
}

interface Draft {
  type:     'shielded' | 'unshielded';
  tokenId:  string;
  label:    string;
  to:       string;
  amount:   bigint;   // raw units
  amtStr:   string;   // for display
}

type Step = 'list' | 'token' | 'recipient' | 'amount' | 'submitting';

interface Props {
  onComplete:        () => void;
  walletSync:        WalletSyncState;
  onWorkInProgress?: (wip: boolean) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Send({onComplete, walletSync, onWorkInProgress}: Props) {
  const {balances, txStatus, send, resetTx} = walletSync;
  const {wallets} = useWallet();

  const [step,     setStep]    = useState<Step>('list');
  const [drafts,   setDrafts]  = useState<Draft[]>([]);
  const [choice,   setChoice]  = useState<TokenChoice | null>(null);
  const [to,       setTo]      = useState('');
  const [toError,  setToError] = useState('');
  const [amtStr,   setAmtStr]  = useState('');
  const [amtError, setAmtError] = useState('');

  // Reset tx state when the screen is first shown.
  useEffect(() => { resetTx(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // Notify parent when work is in progress (step other than list, or queued drafts).
  useEffect(() => {
    onWorkInProgress?.(step !== 'list' || drafts.length > 0);
  }, [step, drafts.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { onWorkInProgress?.(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps


  // Handle Enter after a terminal tx state.
  useInput((_, key) => {
    if (step === 'submitting') {
      if ((txStatus.stage === 'pending' || txStatus.stage === 'failed') && key.return) {
        onComplete();
      }
      return;
    }
    if (key.escape) {
      if (step === 'recipient' || step === 'amount') { setStep('token'); return; }
      if (step === 'token')    { setStep('list'); return; }
    }
  });

  // ── Available tokens (non-zero balances, unshielded before shielded, NIGHT first) ──

  const available = useMemo((): TokenChoice[] => {
    if (!balances) return [];
    // Subtract amounts already committed in the current batch from each token's balance.
    const committed = new Map<string, bigint>();
    for (const d of drafts) {
      const key = d.type + ':' + d.tokenId;
      committed.set(key, (committed.get(key) ?? 0n) + d.amount);
    }
    const tokens: TokenChoice[] = [];
    const addGroup = (type: 'shielded' | 'unshielded', rec: Record<string, bigint>) => {
      // NIGHT first, then other tokens alphabetically.
      const sorted = Object.entries(rec).sort(([a], [b]) =>
        a === NIGHT_ID ? -1 : b === NIGHT_ID ? 1 : a.localeCompare(b));
      for (const [id, amt] of sorted) {
        const net = amt - (committed.get(type + ':' + id) ?? 0n);
        if (net > 0n) tokens.push({
          type, tokenId: id, max: net,
          label: `${tokenLabel(id)} (${type})`,
        });
      }
    };
    addGroup('unshielded', balances.unshielded);
    addGroup('shielded',   balances.shielded);
    return tokens;
  }, [balances, drafts]);

  // ── Action handlers ──

  function startAddTransfer() {
    setChoice(null);
    setTo('');
    setToError('');
    setAmtStr('');
    setAmtError('');
    setStep('token');
  }

  function handleTokenSelect(item: {value: string}) {
    if (item.value === '__back__') { setStep('list'); return; }
    const tok = available.find(t => t.type + ':' + t.tokenId === item.value);
    if (!tok) return;
    setChoice(tok);
    setTo('');
    setToError('');
    setStep('recipient');
  }

  function handleRecipientSubmit(value: string) {
    const rawInput = value.trim();
    if (!rawInput) { setToError('Address is required.'); return; }
    // Allow a local wallet name as shorthand for its address.
    const nameMatch = wallets.find(w => w.name.toLowerCase() === rawInput.toLowerCase());
    const addr = nameMatch
      ? (choice?.type === 'shielded' ? nameMatch.shielded : nameMatch.unshielded)
      : rawInput;
    if (!addr) { setToError('Wallet has no address for this network.'); return; }
    // Soft address-type hint (SDK will reject definitively on submit).
    if (choice?.type === 'shielded' && !addr.includes('shield-addr')) {
      setToError('Expected a shielded address (mn_shield-addr_…).');
      return;
    }
    if (choice?.type === 'unshielded' && addr.includes('shield-addr')) {
      setToError('Expected an unshielded address (mn_addr_…).');
      return;
    }
    setTo(addr);
    setToError('');
    setAmtStr('');
    setAmtError('');
    setStep('amount');
  }

  function handleAmountSubmit(value: string) {
    if (!choice) return;
    try {
      const raw = parseAmount(value, choice.tokenId);
      if (raw <= 0n) { setAmtError('Amount must be positive.'); return; }
      if (raw > choice.max) {
        setAmtError(`Exceeds available balance (${fmtAmount(choice.tokenId, choice.max)}).`);
        return;
      }
      setDrafts(prev => [...prev, {
        type:    choice.type,
        tokenId: choice.tokenId,
        label:   choice.label,
        to:      to.trim(),
        amount:  raw,
        amtStr:  fmtAmount(choice.tokenId, raw),
      }]);
      setStep('list');
    } catch {
      setAmtError('Invalid amount.');
    }
  }

  async function handleSend() {
    setStep('submitting');
    const requests: SendRequest[] = drafts.map(d => ({
      type:    d.type,
      tokenId: d.tokenId,
      amount:  d.amount,
      to:      d.to,
    }));
    await send(requests);
  }

  // ── Render ──

  if (step === 'submitting') {
    return (
      <Box flexDirection="column" gap={1}>
        <TxStatusComponent status={txStatus} />
        {(txStatus.stage === 'pending' || txStatus.stage === 'failed') && (
          <Text dimColor>Press Enter to return to dashboard.</Text>
        )}
      </Box>
    );
  }

  // Guard: wallet not ready.
  if (!balances) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold color="cyan">Send Tokens</Text>
        <Text dimColor>{walletSync.error ?? 'Awaiting wallet sync…'}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="cyan">Send Tokens</Text>
      <Text dimColor>DUST is not directly transferable; only unshielded and shielded tokens are shown.</Text>

      {/* ── List ─────────────────────────────────────────────────────── */}
      {step === 'list' && (
        <>
          {/* Draft table */}
          {drafts.length > 0 && (
            <Box flexDirection="column">
              <Text dimColor>Transfers to send:</Text>
              {drafts.map((d, i) => (
                <Box key={i} gap={2}>
                  <Box width={3}><Text dimColor>{i + 1}.</Text></Box>
                  <Box width={22}><Text color="white">{d.label}</Text></Box>
                  <Box width={48}><Text color="white" wrap="truncate">{d.to}</Text></Box>
                  <Text color="white">{d.amtStr}</Text>
                </Box>
              ))}
              {new Set(drafts.filter(d => d.type === 'shielded').map(d => d.tokenId)).size >= 2 && (
                <Text color="yellow">⚠ Batching more than two shielded token types may fail due to ZK circuit or balancing limitations.</Text>
              )}
            </Box>
          )}

          <SelectInput
            items={[
              {
                label: drafts.length > 0
                  ? `Confirm & send (${drafts.length} transfer${drafts.length > 1 ? 's' : ''})`
                  : 'Send empty transaction (DUST fee only — for benchmarking)',
                value: 'send',
              },
              {label: available.length > 0 ? 'Add transfer' : 'Add transfer (no tokens available)', value: 'add'},
              {label: 'Back to dashboard', value: 'back'},
            ]}
            onSelect={item => {
              if (item.value === 'send')  { void handleSend(); }
              else if (item.value === 'add' && available.length > 0) startAddTransfer();
              else if (item.value === 'back') onComplete();
            }}
          />
        </>
      )}

      {/* ── Token selection ───────────────────────────────────────────── */}
      {step === 'token' && (
        <Box flexDirection="column" gap={1}>
          {new Set(drafts.filter(d => d.type === 'shielded').map(d => d.tokenId)).size >= 2 && (
            <Text color="yellow">⚠ Already 2 shielded token types queued — adding a third may fail due to ZK circuit limits.</Text>
          )}
          <Text>Select token to send:</Text>
          {available.length === 0 ? (
            <Text color="yellow">No tokens available to send.</Text>
          ) : (
            <SelectInput
              items={[
                ...available.map(t => ({
                  label: `${t.label.padEnd(28)} ${fmtAmount(t.tokenId, t.max)} available`,
                  value: t.type + ':' + t.tokenId,
                })),
                {label: '← Back', value: '__back__'},
              ]}
              onSelect={handleTokenSelect}
            />
          )}
          <Text dimColor>[Esc] back</Text>
        </Box>
      )}

      {/* ── Recipient ─────────────────────────────────────────────────── */}
      {step === 'recipient' && choice && (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>Token: <Text color="white">{choice.label}</Text></Text>
          <Box gap={1}>
            <Text>Recipient address or wallet name:</Text>
            <TextInput
              value={to}
              onChange={v => { setTo(v); setToError(''); }}
              onSubmit={handleRecipientSubmit}
              placeholder={choice.type === 'shielded' ? 'mn_shield-addr_… or name' : 'mn_addr_… or name'}
            />
          </Box>
          {toError && <Text color="red">{toError}</Text>}
          {wallets.some(w => choice.type === 'shielded' ? w.shielded : w.unshielded) && (
            <Box flexDirection="column">
              <Text dimColor>Saved wallets:</Text>
              {wallets
                .filter(w => choice.type === 'shielded' ? w.shielded : w.unshielded)
                .map((w, i) => {
                  const addr = choice.type === 'shielded' ? w.shielded : w.unshielded;
                  return (
                    <Box key={i} gap={2}>
                      <Box width={20}><Text dimColor>{w.name}</Text></Box>
                      <Text dimColor>{addr}</Text>
                    </Box>
                  );
                })}
            </Box>
          )}
          <Text dimColor>[Esc] back  [Enter] continue</Text>
        </Box>
      )}

      {/* ── Amount ────────────────────────────────────────────────────── */}
      {step === 'amount' && choice && (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>Token:     <Text color="white">{choice.label}</Text></Text>
          <Text dimColor>Recipient: <Text color="white" wrap="truncate">{to}</Text></Text>
          <Box gap={1}>
            <Text>Amount{isRawToken(choice.tokenId) ? '' : ' (NIGHT)'}:</Text>
            <TextInput
              value={amtStr}
              onChange={v => { setAmtStr(v); setAmtError(''); }}
              onSubmit={handleAmountSubmit}
              placeholder={amtPlaceholder(choice.tokenId)}
            />
          </Box>
          <Text dimColor>Available: <Text color="white">{fmtAmount(choice.tokenId, choice.max)}</Text></Text>
          {amtError && <Text color="red">{amtError}</Text>}
          <Text dimColor>[Esc] back  [Enter] add to transfer list</Text>
        </Box>
      )}
    </Box>
  );
}
