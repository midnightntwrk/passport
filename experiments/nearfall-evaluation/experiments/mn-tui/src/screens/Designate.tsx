import React, {useState, useEffect} from 'react';
import {Box, Text, useInput}         from 'ink';
import TextInput                      from 'ink-text-input';
import SelectInput                    from 'ink-select-input';
import TxStatusComponent             from '../components/TxStatus.js';
import DustMonitor                   from '../components/DustMonitor.js';
import type {WalletSyncState}        from '../hooks/useWalletSync.js';
import {useWallet}                   from '../hooks/useWallet.js';

type Step =
  | 'view'
  | 'register-addr'
  | 'register-confirm'
  | 'registering'
  | 'deregister-confirm'
  | 'deregistering';

interface Props {
  onComplete:        () => void;
  walletSync:        WalletSyncState;
  onWorkInProgress?: (wip: boolean) => void;
}

export default function Designate({onComplete, walletSync, onWorkInProgress}: Props) {
  const {
    balances,
    dustAddress,
    designateTxStatus,
    designate,
    resetDesignate,
    deregisterTxStatus,
    deregister,
    resetDeregister,
  } = walletSync;
  const {wallets} = useWallet();

  const [step,            setStep]           = useState<Step>('view');
  const [receiverDraft,   setReceiverDraft]  = useState('');

  useEffect(() => {
    resetDesignate();
    resetDeregister();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Notify parent when the user has entered the registration flow.
  useEffect(() => {
    onWorkInProgress?.(step !== 'view');
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { onWorkInProgress?.(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Pre-fill receiver address with the dust address when it becomes available.
  useEffect(() => {
    if (dustAddress && !receiverDraft) setReceiverDraft(dustAddress);
  }, [dustAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  useInput((_, key) => {
    if (step === 'registering') {
      if ((designateTxStatus.stage === 'pending' || designateTxStatus.stage === 'failed') && key.return) {
        onComplete();
      }
      return;
    }
    if (step === 'deregistering') {
      if ((deregisterTxStatus.stage === 'pending' || deregisterTxStatus.stage === 'failed') && key.return) {
        onComplete();
      }
      return;
    }
    if (key.escape) {
      if (step === 'register-addr' || step === 'register-confirm' || step === 'deregister-confirm') {
        setStep('view');
      }
    }
  });

  function handleReceiverSubmit() {
    const rawInput = receiverDraft.trim();
    // Allow a local wallet name as shorthand for its dust address.
    const nameMatch = wallets.find(w => w.name.toLowerCase() === rawInput.toLowerCase());
    if (nameMatch?.dust) setReceiverDraft(nameMatch.dust);
    setStep('register-confirm');
  }

  async function handleRegister() {
    setStep('registering');
    const addr = receiverDraft.trim() || dustAddress || undefined;
    await designate(addr);
  }

  async function handleDeregister() {
    setStep('deregistering');
    await deregister();
  }

  const unregistered = balances?.unregisteredNightUtxos ?? 0;
  const registered   = balances?.registeredNightUtxos   ?? 0;

  // ── Registering ──────────────────────────────────────────────────────────
  if (step === 'registering') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold color="cyan">Designate NIGHT for DUST Generation</Text>
        <TxStatusComponent status={designateTxStatus} />
        {(designateTxStatus.stage === 'pending' || designateTxStatus.stage === 'failed') && (
          <Text dimColor>Press Enter to return to dashboard.</Text>
        )}
      </Box>
    );
  }

  // ── Deregistering ─────────────────────────────────────────────────────────
  if (step === 'deregistering') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold color="cyan">Designate NIGHT for DUST Generation</Text>
        <TxStatusComponent status={deregisterTxStatus} />
        {(deregisterTxStatus.stage === 'pending' || deregisterTxStatus.stage === 'failed') && (
          <Text dimColor>Press Enter to return to dashboard.</Text>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="cyan">Designate NIGHT for DUST Generation</Text>

      <DustMonitor
        balance={balances?.dust ?? null}
        generation={balances?.dustGeneration ?? null}
        registeredNightUtxos={balances?.registeredNightUtxos ?? 0}
        dustAccruing={balances?.dustAccruing ?? null}
      />

      {/* View — main menu */}
      {step === 'view' && (
        <Box flexDirection="column" gap={1}>
          <Box gap={2}>
            <Text dimColor>Unregistered: <Text color="white">{unregistered}</Text></Text>
            <Text dimColor>Registered: <Text color="white">{registered}</Text></Text>
          </Box>
          <SelectInput
            items={[
              ...(unregistered > 0
                ? [{label: `Register ${unregistered} UTXO${unregistered !== 1 ? 's' : ''} for DUST`, value: 'register'}]
                : []),
              ...(registered > 0
                ? [{label: `Deregister ${registered} UTXO${registered !== 1 ? 's' : ''} from DUST`, value: 'deregister'}]
                : []),
              {label: 'Back to dashboard', value: 'back'},
            ]}
            onSelect={item => {
              if (item.value === 'register')   setStep('register-addr');
              else if (item.value === 'deregister') setStep('deregister-confirm');
              else onComplete();
            }}
          />
        </Box>
      )}

      {/* Register — receiver address */}
      {step === 'register-addr' && (
        <Box flexDirection="column" gap={1}>
          <Text bold>DUST receiver address</Text>
          <Text dimColor>
            DUST will accrue to this wallet address. Defaults to your own address.
          </Text>
          <Box gap={1}>
            <Text>Address or wallet name: </Text>
            <TextInput
              value={receiverDraft}
              onChange={setReceiverDraft}
              onSubmit={handleReceiverSubmit}
              placeholder={dustAddress ?? 'dust address or wallet name'}
            />
          </Box>
          {wallets.some(w => w.dust) && (
            <Box flexDirection="column">
              <Text dimColor>Saved wallets:</Text>
              {wallets
                .filter(w => w.dust)
                .map((w, i) => (
                  <Box key={i} gap={2}>
                    <Box width={20}><Text dimColor>{w.name}</Text></Box>
                    <Text dimColor>{w.dust}</Text>
                  </Box>
                ))}
            </Box>
          )}
          <Text dimColor>[Enter] next  [Esc] back</Text>
        </Box>
      )}

      {/* Register — confirm */}
      {step === 'register-confirm' && (
        <Box flexDirection="column" gap={1}>
          <Text bold>Confirm registration</Text>
          <Text dimColor>
            Register <Text color="white">{unregistered} NIGHT UTXO{unregistered !== 1 ? 's' : ''}</Text> for DUST generation.
          </Text>
          <Text dimColor>
            DUST receiver: <Text color="white">{receiverDraft.trim() || dustAddress || '(own wallet)'}</Text>
          </Text>
          <Text dimColor>UTXOs remain in your wallet but are designated to accrue DUST.</Text>
          <SelectInput
            items={[
              {label: 'Register', value: 'confirm'},
              {label: 'Cancel',   value: 'cancel'},
            ]}
            onSelect={item => {
              if (item.value === 'confirm') void handleRegister();
              else setStep('view');
            }}
          />
          <Text dimColor>[Esc] back</Text>
        </Box>
      )}

      {/* Deregister — confirm */}
      {step === 'deregister-confirm' && (
        <Box flexDirection="column" gap={1}>
          <Text bold>Confirm deregistration</Text>
          <Text dimColor>
            Remove <Text color="white">{registered} NIGHT UTXO{registered !== 1 ? 's' : ''}</Text> from DUST generation.
          </Text>
          <Text dimColor>DUST will stop accruing for these UTXOs after the transaction confirms.</Text>
          <SelectInput
            items={[
              {label: 'Deregister', value: 'confirm'},
              {label: 'Cancel',     value: 'cancel'},
            ]}
            onSelect={item => {
              if (item.value === 'confirm') void handleDeregister();
              else setStep('view');
            }}
          />
          <Text dimColor>[Esc] back</Text>
        </Box>
      )}
    </Box>
  );
}
