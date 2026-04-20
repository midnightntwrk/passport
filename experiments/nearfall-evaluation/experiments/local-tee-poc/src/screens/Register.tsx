import React, {useState, useEffect} from 'react';
import {Box, Text, useInput} from 'ink';
import type {ComplianceSyncState} from '../hooks/useCompliance.js';
import TxStatus from '../components/TxStatus.js';

// ---------------------------------------------------------------------------
// Register screen — register the stub TEE device key on the contract.
//
// This calls `register_device(sk_device)` where sk_device is supplied by the
// stub TEE.  The circuit computes pk = sk*G inside the ZK proof; the scalar
// sk never appears in public output.
// ---------------------------------------------------------------------------

type Step = 'info' | 'registering' | 'done';

interface Props {
  compliance:  ComplianceSyncState;
  onComplete:  () => void;
}

export default function Register({compliance, onComplete}: Props) {
  const [step, setStep] = useState<Step>('info');

  const {registerTxStatus, register, onChain, walletReady, contractAddress, teeKeyLoaded} = compliance;

  useEffect(() => {
    if (step !== 'registering') return;
    if (registerTxStatus.stage === 'confirmed') setStep('done');
  }, [registerTxStatus, step]);

  useInput((_input, key) => {
    if (step === 'info') {
      if (key.return) { setStep('registering'); void register(); }
      if (key.escape) onComplete();
    }
    if (step === 'done') {
      if (key.return || key.escape) onComplete();
    }
    if (step === 'registering' && registerTxStatus.stage === 'failed') {
      if (key.escape) setStep('info');
    }
  });

  if (!contractAddress) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="red">No contract connected.</Text>
        <Text dimColor>Go to Setup first to deploy or connect a contract.</Text>
      </Box>
    );
  }

  if (!walletReady) {
    return <Text dimColor>Waiting for wallet sync…</Text>;
  }

  if (onChain?.deviceRegistered) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="green">Device already registered.</Text>
        <Text dimColor>Use the Reset function on the Dashboard to re-register with a new key.</Text>
        <Text dimColor>Press Esc to go back.</Text>
      </Box>
    );
  }

  if (step === 'info') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Register TEE Device</Text>
        <Text>This will register the stub TEE device key on the contract.</Text>
        <Box flexDirection="column" marginTop={1} gap={0}>
          <Box gap={2}>
            <Text dimColor>Contract:</Text>
            <Text>{contractAddress}</Text>
          </Box>
          <Box gap={2}>
            <Text dimColor>TEE key: </Text>
            <Text color={teeKeyLoaded ? 'green' : 'red'}>
              {teeKeyLoaded ? 'Loaded (stub — in-process memory)' : 'Not loaded'}
            </Text>
          </Box>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            The circuit will compute pk = sk*G inside the ZK proof.
            sk_device never leaves the in-process "enclave".
          </Text>
        </Box>
        <Text dimColor>Press Enter to register, Esc to cancel.</Text>
      </Box>
    );
  }

  if (step === 'registering') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Registering device…</Text>
        <TxStatus status={registerTxStatus} label="Register" />
        {registerTxStatus.stage === 'failed' && (
          <Text dimColor>Press Esc to go back.</Text>
        )}
      </Box>
    );
  }

  // done
  return (
    <Box flexDirection="column" gap={1}>
      <Text color="green">✓ Device registered successfully.</Text>
      <Text dimColor>The device public key is now stored on-chain.</Text>
      <TxStatus status={registerTxStatus} />
      <Text dimColor>Press Enter to go to Dashboard.</Text>
    </Box>
  );
}
