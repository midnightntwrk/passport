import React, {useState}  from 'react';
import {Box, Text, useInput} from 'ink';
import Spinner              from 'ink-spinner';
import TextInput            from 'ink-text-input';
import {encryptMnemonic, decryptMnemonic} from '../keys.js';

// ---------------------------------------------------------------------------
// Keys screen — mnemonic entry and persistence
//
// Separates mnemonic management from network configuration.
//
// Three operational modes:
//   (a) No stored mnemonic → enter a new one.
//   (b) Encrypted mnemonic stored in config → unlock with passphrase.
//   (c) Mnemonic loaded in session → show status; allow replace or forget.
//
// Persistence: when the user provides a non-blank passphrase, the mnemonic is
// encrypted (OpenPGP symmetric, AES-256) and stored in ~/.local-tee-poc-config.json.
// Only the ciphertext is persisted; the plaintext lives in React state only.
// If the user leaves the passphrase blank, the mnemonic is loaded into the
// session only and will be forgotten when the app exits.
// ---------------------------------------------------------------------------

type Step =
  | {kind: 'status'}
  | {kind: 'enter-mnemonic'; draft: string}
  | {kind: 'enter-passphrase'; mnemonic: string; draft: string}
  | {kind: 'unlock'; draft: string}
  | {kind: 'working'; msg: string}
  | {kind: 'error'; msg: string};

interface Props {
  mnemonic:          string | null;   // current session plaintext mnemonic
  encryptedMnemonic: string | null;   // stored ciphertext from config (null = not saved)
  onMnemonicLoaded:  (mn: string) => void;
  onMnemonicCleared: () => void;
  onEncryptedSaved:  (encrypted: string) => void;
  onEncryptedDeleted:() => void;
  onComplete:        () => void;
}

export default function Keys({
  mnemonic, encryptedMnemonic,
  onMnemonicLoaded, onMnemonicCleared, onEncryptedSaved, onEncryptedDeleted,
  onComplete,
}: Props) {
  const [step, setStep] = useState<Step>({kind: 'status'});

  // ── Global key handler ───────────────────────────────────────────────────

  useInput((_input, key) => {
    // Dismiss errors on any key
    if (step.kind === 'error') { setStep({kind: 'status'}); return; }

    if (key.escape) {
      if (step.kind !== 'status') { setStep({kind: 'status'}); return; }
      onComplete();
      return;
    }

    if (step.kind === 'status') {
      if (_input === 'e' || _input === 'n') {
        setStep({kind: 'enter-mnemonic', draft: ''});
        return;
      }
      if (_input === 'u' && encryptedMnemonic && !mnemonic) {
        setStep({kind: 'unlock', draft: ''});
        return;
      }
      if (_input === 'c' && mnemonic) {
        onMnemonicCleared();
        return;
      }
      if (_input === 'd' && encryptedMnemonic) {
        onEncryptedDeleted();
        return;
      }
    }
  });

  // ── Submit handlers ──────────────────────────────────────────────────────

  function handleMnemonicSubmit(value: string) {
    const mn = value.trim();
    if (!mn) return;
    setStep({kind: 'enter-passphrase', mnemonic: mn, draft: ''});
  }

  function handlePassphraseSubmit(value: string) {
    if (step.kind !== 'enter-passphrase') return;
    const passphrase = value.trim();
    const {mnemonic: mn} = step;

    if (!passphrase) {
      // Session-only: load but don't save
      onMnemonicLoaded(mn);
      setStep({kind: 'status'});
      return;
    }

    setStep({kind: 'working', msg: 'Encrypting mnemonic…'});
    void (async () => {
      try {
        const encrypted = await encryptMnemonic(mn, passphrase);
        onEncryptedSaved(encrypted);
        onMnemonicLoaded(mn);
        setStep({kind: 'status'});
      } catch (e) {
        setStep({kind: 'error', msg: e instanceof Error ? e.message : String(e)});
      }
    })();
  }

  function handleUnlockSubmit(value: string) {
    if (step.kind !== 'unlock') return;
    const passphrase = value.trim();
    if (!passphrase || !encryptedMnemonic) return;

    setStep({kind: 'working', msg: 'Decrypting mnemonic…'});
    void (async () => {
      try {
        const mn = await decryptMnemonic(encryptedMnemonic, passphrase);
        onMnemonicLoaded(mn);
        setStep({kind: 'status'});
      } catch {
        setStep({kind: 'error', msg: 'Wrong passphrase or corrupt data.'});
      }
    })();
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="cyan">Key Management</Text>

      {/* ── Status ──────────────────────────────────────────────────── */}
      {(step.kind === 'status' || step.kind === 'error') && (
        <>
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Box gap={2}>
              <Text dimColor>Session mnemonic</Text>
              {mnemonic
                ? <Text color="green">loaded</Text>
                : <Text color="yellow">not loaded</Text>
              }
            </Box>
            <Box gap={2}>
              <Text dimColor>Saved in config </Text>
              {encryptedMnemonic
                ? <Text color="cyan">encrypted (OpenPGP)</Text>
                : <Text dimColor>none</Text>
              }
            </Box>
          </Box>

          <Box flexDirection="column" gap={0}>
            {!mnemonic && !encryptedMnemonic && (
              <Text dimColor>[e] enter mnemonic</Text>
            )}
            {!mnemonic && encryptedMnemonic && (
              <Text dimColor>[u] unlock (decrypt saved mnemonic)  [e] enter different mnemonic</Text>
            )}
            {mnemonic && (
              <Text dimColor>[e] replace mnemonic  [c] clear from session</Text>
            )}
            {encryptedMnemonic && (
              <Text dimColor>[d] delete saved mnemonic from config</Text>
            )}
            <Text dimColor>[Esc] back to dashboard</Text>
          </Box>

          {step.kind === 'error' && (
            <Text color="red">⚠ {step.msg}  (press any key)</Text>
          )}
        </>
      )}

      {/* ── Enter mnemonic ──────────────────────────────────────────── */}
      {step.kind === 'enter-mnemonic' && (
        <Box flexDirection="column" gap={1}>
          <Text>Enter your 24-word BIP-39 mnemonic:</Text>
          <TextInput
            value={step.draft}
            onChange={d => setStep({...step, draft: d})}
            onSubmit={handleMnemonicSubmit}
            mask="•"
            placeholder="word1 word2 … word24"
          />
          <Text dimColor>Enter to continue.  [Esc] cancel</Text>
        </Box>
      )}

      {/* ── Enter passphrase ────────────────────────────────────────── */}
      {step.kind === 'enter-passphrase' && (
        <Box flexDirection="column" gap={1}>
          <Text>Encryption passphrase <Text dimColor>(blank = session only, not saved)</Text></Text>
          <TextInput
            value={step.draft}
            onChange={d => setStep({...step, draft: d})}
            onSubmit={handlePassphraseSubmit}
            mask="•"
            placeholder="passphrase — or Enter to skip"
          />
          <Text dimColor>
            Non-blank: mnemonic is encrypted (OpenPGP AES-256) and saved to config.
          </Text>
          <Text dimColor>
            Blank: mnemonic is loaded into the session only; forgotten on exit.
          </Text>
          <Text dimColor>[Esc] cancel</Text>
        </Box>
      )}

      {/* ── Unlock ──────────────────────────────────────────────────── */}
      {step.kind === 'unlock' && (
        <Box flexDirection="column" gap={1}>
          <Text>Passphrase to decrypt saved mnemonic:</Text>
          <TextInput
            value={step.draft}
            onChange={d => setStep({...step, draft: d})}
            onSubmit={handleUnlockSubmit}
            mask="•"
            placeholder="passphrase"
          />
          <Text dimColor>[Esc] cancel</Text>
        </Box>
      )}

      {/* ── Working ─────────────────────────────────────────────────── */}
      {step.kind === 'working' && (
        <Box gap={1}>
          <Text color="yellow"><Spinner type="dots" /></Text>
          <Text>{step.msg}</Text>
        </Box>
      )}

    </Box>
  );
}
