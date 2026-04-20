import React, {useState, useEffect} from 'react';
import {Box, Text, useInput}         from 'ink';
import TextInput                     from 'ink-text-input';
import SelectInput                   from 'ink-select-input';
import TxStatusComponent             from '../components/TxStatus.js';
import type {WalletSyncState}        from '../hooks/useWalletSync.js';

type Step = 'managed' | 'witnesses' | 'confirm' | 'deploying';

interface Props {
  onComplete:        () => void;
  walletSync:        WalletSyncState;
  onWorkInProgress?: (wip: boolean) => void;
}

export default function Deploy({onComplete, walletSync, onWorkInProgress}: Props) {
  const {deployTxStatus, deploy, resetDeploy} = walletSync;

  const [step,          setStep]          = useState<Step>('managed');
  const [managedPath,   setManagedPath]   = useState('');
  const [witnessesPath, setWitnessesPath] = useState('');

  useEffect(() => { resetDeploy(); }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  // Notify parent when past the initial managed-path entry step.
  useEffect(() => {
    onWorkInProgress?.(step !== 'managed');
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { onWorkInProgress?.(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useInput((_, key) => {
    if (step === 'deploying') {
      if ((deployTxStatus.stage === 'pending' || deployTxStatus.stage === 'failed') && key.return) {
        onComplete();
      }
      return;
    }
    if (key.escape) {
      if (step === 'witnesses') { setStep('managed'); return; }
      if (step === 'confirm')   { setStep('witnesses'); return; }
    }
  });

  function handleManagedSubmit(value: string) {
    const p = value.trim();
    if (!p) return;
    setManagedPath(p);
    setStep('witnesses');
  }

  function handleWitnessesSubmit(value: string) {
    setWitnessesPath(value.trim()); // empty = no witnesses
    setStep('confirm');
  }

  async function handleDeploy() {
    setStep('deploying');
    await deploy(managedPath, witnessesPath || null);
  }

  if (step === 'deploying') {
    return (
      <Box flexDirection="column" gap={1}>
        {deployTxStatus.stage === 'pending' ? (
          <Box flexDirection="column" gap={1}>
            <Text color="green">● Deployed</Text>
            <Text dimColor>Contract address:</Text>
            <Text>{deployTxStatus.txHash}</Text>
            <Text dimColor>Press Enter to return to dashboard.</Text>
          </Box>
        ) : (
          <>
            <TxStatusComponent status={deployTxStatus} />
            {deployTxStatus.stage === 'failed' && (
              <Text dimColor>Press Enter to return to dashboard.</Text>
            )}
          </>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="cyan">Deploy Contract</Text>

      {step === 'managed' && (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>Path to the compiled contract's <Text color="white">managed/</Text> directory:</Text>
          <Box gap={1}>
            <Text>managed/ path: </Text>
            <TextInput
              value={managedPath}
              onChange={setManagedPath}
              onSubmit={handleManagedSubmit}
              placeholder="/path/to/contracts/managed/my-contract"
            />
          </Box>
          <Text dimColor>e.g. contracts/managed/fungible-token</Text>
        </Box>
      )}

      {step === 'witnesses' && (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>managed/ <Text color="white">{managedPath}</Text></Text>
          <Box gap={1}>
            <Text>Witnesses JS (optional): </Text>
            <TextInput
              value={witnessesPath}
              onChange={setWitnessesPath}
              onSubmit={handleWitnessesSubmit}
              placeholder="leave empty for none"
            />
          </Box>
          <Text dimColor>File must export: <Text color="white">default function makeWitnesses(walletProvider)</Text></Text>
          <Text dimColor>[Esc] back  [Enter] continue (empty = no witnesses)</Text>
        </Box>
      )}

      {step === 'confirm' && (
        <Box flexDirection="column" gap={1}>
          <Text bold>Confirm deployment</Text>
          <Text dimColor>Contract  <Text color="white">{managedPath}</Text></Text>
          <Text dimColor>Witnesses <Text color="white">{witnessesPath || '(none)'}</Text></Text>
          <Text dimColor>ZK proof generation will take 30–60 seconds.</Text>
          <SelectInput
            items={[
              {label: 'Deploy', value: 'deploy'},
              {label: 'Cancel', value: 'cancel'},
            ]}
            onSelect={item => {
              if (item.value === 'deploy') void handleDeploy();
              else onComplete();
            }}
          />
          <Text dimColor>[Esc] back</Text>
        </Box>
      )}
    </Box>
  );
}
