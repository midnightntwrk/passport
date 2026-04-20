import React, {useState}              from 'react';
import {Box, Text, useInput}           from 'ink';
import Spinner                         from 'ink-spinner';
import TextInput                       from 'ink-text-input';
import * as bip39                      from 'bip39';
import {useWallet}                     from '../hooks/useWallet.js';
import {deriveFromMnemonic, encryptMnemonic} from '../keys.js';
import {clearWalletCache}              from '../walletCache.js';
import type {PersistedWallet}          from '../config.js';
import type {NetworkConfig}            from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props { network: NetworkConfig; }

type Step =
  | {kind: 'list'}
  | {kind: 'create-name';    draft:    string}
  | {kind: 'create-show';    name:     string; mnemonic: string}
  | {kind: 'add-name';       draft:    string}
  | {kind: 'add-mnemonic';   name:     string; draft: string}
  | {kind: 'add-passphrase'; name:     string; mnemonic: string; draft: string}
  | {kind: 'unlock';         idx:      number; draft: string}
  | {kind: 'working';        msg:      string}
  | {kind: 'error';          msg:      string};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Keys({network}: Props) {
  const {
    wallets, persisted, activeIndex,
    addWallet, removeWallet, setActiveIndex,
    isCached, unlockWallet,
  } = useWallet();

  const [step,    setStep]   = useState<Step>({kind: 'list'});
  const [cursor,  setCursor] = useState(activeIndex);
  const [cleared, setCleared] = useState(false);


  const lastIdx = Math.max(0, wallets.length - 1);
  const clamp   = (n: number) => Math.max(0, Math.min(n, lastIdx));

  // ---- global key handler -------------------------------------------------

  useInput((input, key) => {
    // Dismiss errors
    if (step.kind === 'error') { setStep({kind: 'list'}); return; }

    // Escape cancels any add-* step
    if (key.escape && step.kind !== 'list') { setStep({kind: 'list'}); return; }

    // create-show: Enter to advance to passphrase step
    if (step.kind === 'create-show' && key.return) {
      setStep({kind: 'add-passphrase', name: step.name, mnemonic: step.mnemonic, draft: ''});
      return;
    }

    // List navigation
    if (step.kind === 'list') {
      if (key.upArrow)   { setCursor(c => clamp(c - 1)); setCleared(false); return; }
      if (key.downArrow) { setCursor(c => clamp(c + 1)); setCleared(false); return; }
      if (key.return && wallets.length > 0) {
        const pw = persisted[cursor];
        if (pw.encryptedMnemonic && !isCached(cursor)) {
          setStep({kind: 'unlock', idx: cursor, draft: ''});
        } else {
          setActiveIndex(cursor);
        }
        return;
      }
      if (input === 'n') { setStep({kind: 'create-name', draft: ''}); return; }
      if (input === 'a') { setStep({kind: 'add-name',    draft: ''}); return; }
      if (input === 'c' && wallets.length > 0 && wallets[cursor].unshielded) {
        clearWalletCache(network.name, wallets[cursor].unshielded);
        setCleared(true);
        return;
      }
      if (input === 'x' && wallets.length > 0) {
        const next = clamp(cursor === wallets.length - 1 ? cursor - 1 : cursor);
        removeWallet(cursor);
        setCursor(next);
        setCleared(false);
      }
    }
  });

  // ---- submit handlers ----------------------------------------------------

  function handleCreateNameSubmit(value: string) {
    const name = value.trim();
    if (!name) return;
    const mnemonic = bip39.generateMnemonic(256); // 24 words
    setStep({kind: 'create-show', name, mnemonic});
  }

  function handleNameSubmit(value: string) {
    const name = value.trim();
    if (name) setStep({kind: 'add-mnemonic', name, draft: ''});
  }

  function handleMnemonicSubmit(value: string) {
    if (step.kind !== 'add-mnemonic') return;
    const mnemonic = value.trim();
    if (mnemonic) setStep({kind: 'add-passphrase', name: step.name, mnemonic, draft: ''});
  }

  function handlePassphraseSubmit(value: string) {
    if (step.kind !== 'add-passphrase') return;
    const passphrase = value.trim();
    const {name, mnemonic} = step;
    if (!passphrase) return;
    setStep({kind: 'working', msg: 'Deriving addresses and encrypting…'});
    void (async () => {
      try {
        const addrs             = await deriveFromMnemonic(mnemonic, network.name);
        const encryptedMnemonic = await encryptMnemonic(mnemonic, passphrase);
        const entry: PersistedWallet = {
          name,
          addresses: {[network.name]: addrs},
          encryptedMnemonic,
        };
        addWallet(entry, mnemonic);
        setCursor(wallets.length); // new wallet will be appended here
        setStep({kind: 'list'});
      } catch (e) {
        setStep({kind: 'error', msg: e instanceof Error ? e.message : String(e)});
      }
    })();
  }

  function handleUnlockSubmit(value: string) {
    if (step.kind !== 'unlock') return;
    const passphrase = value.trim();
    const idx        = step.idx;
    if (!passphrase) return;
    setStep({kind: 'working', msg: 'Decrypting…'});
    void (async () => {
      try {
        await unlockWallet(idx, passphrase);
        setActiveIndex(idx);
        setCursor(idx);
        setStep({kind: 'list'});
      } catch {
        setStep({kind: 'error', msg: 'Wrong passphrase or corrupt data.'});
      }
    })();
  }

  // ---- helpers ------------------------------------------------------------

  function sourceLabel(pw: PersistedWallet, idx: number): string {
    if (pw.encryptedMnemonic) return isCached(idx) ? 'unlocked' : 'encrypted';
    return 'no mnemonic';
  }

  const active = wallets[activeIndex];

  // ---- render -------------------------------------------------------------

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="cyan">Keys</Text>

      {/* ── List ──────────────────────────────────────────────────────── */}
      {(step.kind === 'list' || step.kind === 'error') && (<>

        <Text dimColor>[n] new  [a] import  [x] delete  [c] clear sync cache  ↑↓ navigate  Enter unlock+activate</Text>

        <Box flexDirection="column">
          {wallets.length === 0
            ? <Text dimColor>No wallets loaded — press [n] to create one or [a] to import.</Text>
            : wallets.map((w, i) => (
                <Box key={i} flexDirection="row">
                  <Text
                    bold={i === cursor}
                    color={i === cursor ? 'cyan' : undefined}
                    dimColor={i !== cursor}
                  >
                    {i === activeIndex ? '●' : '○'}{' '}
                    {String(i).padStart(2)}{'  '}{w.name.padEnd(14)}
                  </Text>
                  <Text color={i === cursor ? (w.unshielded ? 'white' : 'yellow') : undefined} wrap="truncate">
                    {w.unshielded || '(unlock to derive addresses for this network)'}
                  </Text>
                  <Text dimColor>{'  '}{sourceLabel(persisted[i], i)}</Text>
                </Box>
              ))
          }
        </Box>

        {step.kind === 'error' && (
          <Text color="red">⚠ {step.msg}  (press any key)</Text>
        )}
        {cleared && (
          <Text color="green">Sync cache cleared for {wallets[cursor]?.name ?? ''}.</Text>
        )}

        {active && (
          <Box flexDirection="column" borderStyle="single" paddingX={1}>
            <Text bold color="cyan">{active.name}</Text>
            {active.unshielded ? (<>
              <Text dimColor>unshielded  <Text color="white">{active.unshielded}</Text></Text>
              <Text dimColor>shielded    <Text color="white">{active.shielded}</Text></Text>
              <Text dimColor>dust        <Text color="white">{active.dust}</Text></Text>
            </>) : (
              <Text color="yellow">Addresses not yet derived for network {network.name} — unlock to derive.</Text>
            )}
          </Box>
        )}

      </>)}

      {/* ── Create: wallet name ───────────────────────────────────────── */}
      {step.kind === 'create-name' && (
        <Box flexDirection="column" gap={1}>
          <Text>New wallet name:</Text>
          <TextInput
            value={step.draft}
            onChange={d => setStep({...step, draft: d})}
            onSubmit={handleCreateNameSubmit}
            placeholder="alice"
          />
          <Text dimColor>[Esc] cancel</Text>
        </Box>
      )}

      {/* ── Create: show generated seed phrase ────────────────────────── */}
      {step.kind === 'create-show' && (
        <Box flexDirection="column" gap={1}>
          <Text bold color="yellow">⚠ Write down these 24 words in order and store them somewhere safe.</Text>
          <Text bold color="yellow">  They are the only way to recover this wallet. They will not be shown again.</Text>
          <Box gap={4} paddingY={1}>
            {[0, 1, 2].map(col => (
              <Box key={col} flexDirection="column">
                {step.mnemonic.split(' ').slice(col * 8, col * 8 + 8).map((word, i) => (
                  <Box key={i} gap={1}>
                    <Box width={4}><Text dimColor>{String(col * 8 + i + 1).padStart(2)}.</Text></Box>
                    <Text color="white">{word}</Text>
                  </Box>
                ))}
              </Box>
            ))}
          </Box>
          <Text dimColor>[Enter] I have written down all 24 words  [Esc] cancel</Text>
        </Box>
      )}

      {/* ── Add: wallet name ──────────────────────────────────────────── */}
      {step.kind === 'add-name' && (
        <Box flexDirection="column" gap={1}>
          <Text>New wallet name:</Text>
          <TextInput
            value={step.draft}
            onChange={d => setStep({...step, draft: d})}
            onSubmit={handleNameSubmit}
            placeholder="alice"
          />
          <Text dimColor>[Esc] cancel</Text>
        </Box>
      )}

      {/* ── Add: mnemonic ─────────────────────────────────────────────── */}
      {step.kind === 'add-mnemonic' && (
        <Box flexDirection="column" gap={1}>
          <Text>Mnemonic for <Text color="cyan">{step.name}</Text>:</Text>
          <TextInput
            value={step.draft}
            onChange={d => setStep({...step, draft: d})}
            onSubmit={handleMnemonicSubmit}
            mask="*"
            placeholder="word1 word2 … word24"
          />
          <Text dimColor>24 space-separated words — Enter to continue.  [Esc] cancel</Text>
        </Box>
      )}

      {/* ── Add: encryption passphrase ────────────────────────────────── */}
      {step.kind === 'add-passphrase' && (
        <Box flexDirection="column" gap={1}>
          <Text>Encryption passphrase for <Text color="cyan">{step.name}</Text>:</Text>
          <TextInput
            value={step.draft}
            onChange={d => setStep({...step, draft: d})}
            onSubmit={handlePassphraseSubmit}
            mask="*"
            placeholder="strong passphrase"
          />
          <Text dimColor>Mnemonic will be stored encrypted (OpenPGP symmetric).  [Esc] cancel</Text>
        </Box>
      )}

      {/* ── Unlock ────────────────────────────────────────────────────── */}
      {step.kind === 'unlock' && (
        <Box flexDirection="column" gap={1}>
          <Text>Passphrase for <Text color="cyan">{wallets[step.idx]?.name ?? ''}</Text>:</Text>
          <TextInput
            value={step.draft}
            onChange={d => setStep({...step, draft: d})}
            onSubmit={handleUnlockSubmit}
            mask="*"
            placeholder="passphrase"
          />
          <Text dimColor>Decrypt mnemonic to activate wallet.  [Esc] cancel</Text>
        </Box>
      )}

      {/* ── Working ───────────────────────────────────────────────────── */}
      {step.kind === 'working' && (
        <Box gap={1}>
          <Text color="yellow"><Spinner type="dots" /></Text>
          <Text>{step.msg}</Text>
        </Box>
      )}

    </Box>
  );
}
