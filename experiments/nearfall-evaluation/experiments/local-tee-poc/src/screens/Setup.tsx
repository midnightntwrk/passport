import React, {useState, useEffect} from 'react';
import {Box, Text, useInput} from 'ink';
import TextInput from 'ink-text-input';
import type {ComplianceSyncState} from '../hooks/useCompliance.js';
import TxStatus from '../components/TxStatus.js';

// ---------------------------------------------------------------------------
// Setup screen — deploy a new contract or connect to an existing one.
// ---------------------------------------------------------------------------

type Step =
  | 'menu'
  | 'deploy-confirm'
  | 'deploying'
  | 'connect-input'
  | 'done';

interface Props {
  mnemonic:       string | null;
  compliance:     ComplianceSyncState;
  onContractSaved:(address: string) => void;
  onComplete:     () => void;
}

export default function Setup({mnemonic, compliance, onContractSaved, onComplete}: Props) {
  const [step,        setStep]        = useState<Step>('menu');
  const [menuIdx,     setMenuIdx]     = useState(0);
  const [connectAddr, setConnectAddr] = useState('');

  const {deployTxStatus, deploy, connect, walletReady, contractAddress} = compliance;

  // Advance to 'done' once deploy confirms and the contract address is set.
  useEffect(() => {
    if (step !== 'deploying') return;
    if (deployTxStatus.stage === 'confirmed' && contractAddress) {
      onContractSaved(contractAddress);
      setStep('done');
    }
  }, [deployTxStatus, contractAddress, step]); // eslint-disable-line react-hooks/exhaustive-deps

  useInput((_input, key) => {
    if (step === 'menu') {
      if (key.upArrow)   { setMenuIdx(i => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setMenuIdx(i => Math.min(1, i + 1)); return; }
      if (key.return) {
        if (menuIdx === 0) setStep('deploy-confirm');
        else               setStep('connect-input');
        return;
      }
    }
    if (step === 'deploy-confirm') {
      if (key.return) {
        setStep('deploying');
        void deploy();
        return;
      }
      if (key.escape) { setStep('menu'); return; }
    }
    if (step === 'done') {
      if (key.return || key.escape) { onComplete(); return; }
    }
  }, {isActive: step !== 'connect-input'});

  // ── Render ────────────────────────────────────────────────────────────────

  if (!mnemonic) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="red">No mnemonic loaded.</Text>
        <Text dimColor>Enter a mnemonic on the Network screen before setting up the contract.</Text>
      </Box>
    );
  }

  if (step === 'menu') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Setup — Deploy or Connect</Text>
        <Text dimColor>Choose how to use the compliance contract:</Text>
        <Box flexDirection="column" marginTop={1}>
          {(['Deploy new contract', 'Connect to existing address'] as const).map((label, i) => (
            <Text key={i} color={menuIdx === i ? 'cyan' : undefined}>
              {menuIdx === i ? '▶ ' : '  '}{label}
            </Text>
          ))}
        </Box>
        <Box marginTop={1}><Text dimColor>↑/↓ select  Enter confirm</Text></Box>
      </Box>
    );
  }

  if (step === 'deploy-confirm') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Deploy New Contract</Text>
        <Text>This will deploy a new compliance contract on <Text color="yellow">{compliance.contractAddress ?? 'network'}</Text>.</Text>
        <Text>A ZK proof will be generated (30–60 s) and DUST will be consumed for fees.</Text>
        <Text dimColor>Press Enter to proceed, Esc to cancel.</Text>
      </Box>
    );
  }

  if (step === 'deploying') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Deploying…</Text>
        <TxStatus status={deployTxStatus} label="Deploy" />
        {deployTxStatus.stage === 'failed' && (
          <Text dimColor>Press Esc to go back.</Text>
        )}
      </Box>
    );
  }

  if (step === 'connect-input') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Connect to Existing Contract</Text>
        <Box gap={1}>
          <Text dimColor>Contract address:</Text>
          <TextInput
            value={connectAddr}
            onChange={setConnectAddr}
            onSubmit={async (addr) => {
              if (!addr.trim()) return;
              await connect(addr.trim());
              onContractSaved(addr.trim());
              onComplete();
            }}
          />
        </Box>
        <Text dimColor>Enter the contract address (hex) and press Enter.</Text>
      </Box>
    );
  }

  // done
  return (
    <Box flexDirection="column" gap={1}>
      <Text color="green">✓ Contract ready</Text>
      <Text dimColor>{compliance.contractAddress}</Text>
      <Text dimColor>Press Enter to go to Dashboard.</Text>
    </Box>
  );
}
