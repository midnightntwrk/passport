import React, {useState, useEffect} from 'react';
import {Box, Text, useInput}         from 'ink';
import TextInput                     from 'ink-text-input';
import SelectInput                   from 'ink-select-input';
import TxStatusComponent             from '../components/TxStatus.js';
import type {WalletSyncState}        from '../hooks/useWalletSync.js';

type Step = 'contract' | 'deploying' | 'amount' | 'confirm' | 'minting';

interface Props {
  onComplete:        () => void;
  walletSync:        WalletSyncState;
  onWorkInProgress?: (wip: boolean) => void;
}

export default function Mint({onComplete, walletSync, onWorkInProgress}: Props) {
  const {mintTxStatus, mintResult, mint, resetMint, deployFT} = walletSync;

  const [step,            setStep]            = useState<Step>('contract');
  const [contractAddress, setContractAddress] = useState('');
  const [amountStr,       setAmountStr]       = useState('');
  const [deployError,     setDeployError]     = useState<string | null>(null);

  useEffect(() => { resetMint(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Notify parent when past the initial contract-address entry step.
  useEffect(() => {
    onWorkInProgress?.(step !== 'contract');
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { onWorkInProgress?.(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useInput((_, key) => {
    if (step === 'minting') {
      if ((mintTxStatus.stage === 'pending' || mintTxStatus.stage === 'failed') && key.return) {
        onComplete();
      }
      return;
    }
    if (step === 'deploying') return; // no escape while deploying
    if (key.escape) {
      if (step === 'amount')  { setStep('contract'); return; }
      if (step === 'confirm') { setStep('amount');   return; }
    }
  });

  function handleContractSubmit(value: string) {
    const p = value.trim();
    if (!p) {
      // Empty → deploy a new fungible-token contract.
      setDeployError(null);
      setStep('deploying');
      void deployFT().then(addr => {
        setContractAddress(addr);
        setStep('amount');
      }).catch((e: unknown) => {
        setDeployError(e instanceof Error ? e.message : String(e));
        setStep('contract');
      });
      return;
    }
    setContractAddress(p);
    setStep('amount');
  }

  function handleAmountSubmit(value: string) {
    const v = value.trim();
    if (!v || isNaN(Number(v))) return;
    setAmountStr(v);
    setStep('confirm');
  }

  async function handleMint() {
    setStep('minting');
    await mint(contractAddress, BigInt(amountStr));
  }

  if (step === 'minting') {
    return (
      <Box flexDirection="column" gap={1}>
        {mintTxStatus.stage === 'pending' ? (
          <Box flexDirection="column" gap={1}>
            <Text color="green">● Minted</Text>
            <Text dimColor>Token type:</Text>
            <Text>{mintResult?.tokenType ?? ''}</Text>
            <Text dimColor>Tx hash: <Text color="white">{mintTxStatus.txHash}</Text></Text>
            <Text dimColor>Press Enter to return to dashboard.</Text>
          </Box>
        ) : (
          <>
            <TxStatusComponent status={mintTxStatus} />
            {mintTxStatus.stage === 'failed' && (
              <Text dimColor>Press Enter to return to dashboard.</Text>
            )}
          </>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="cyan">Mint Shielded Tokens</Text>
      <Text dimColor>Mints shielded tokens to the calling wallet's ZSwap address.</Text>

      {step === 'contract' && (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>Enter a contract address, or press Enter to deploy a new one.</Text>
          <Box gap={1}>
            <Text>Contract address: </Text>
            <TextInput
              value={contractAddress}
              onChange={setContractAddress}
              onSubmit={handleContractSubmit}
              placeholder="(blank = deploy new)"
            />
          </Box>
          {deployError && <Text color="red">Deploy failed: {deployError}</Text>}
        </Box>
      )}

      {step === 'deploying' && (
        <Box flexDirection="column" gap={1}>
          <Text>Deploying new fungible-token contract…</Text>
          <Text dimColor>ZK proof generation will take 30–60 seconds.</Text>
        </Box>
      )}

      {step === 'amount' && (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>Contract <Text color="white">{contractAddress}</Text></Text>
          <Box gap={1}>
            <Text>Amount: </Text>
            <TextInput
              value={amountStr}
              onChange={setAmountStr}
              onSubmit={handleAmountSubmit}
              placeholder="1000"
            />
          </Box>
          <Text dimColor>[Esc] back</Text>
        </Box>
      )}

      {step === 'confirm' && (
        <Box flexDirection="column" gap={1}>
          <Text bold>Confirm mint</Text>
          <Text dimColor>Contract  <Text color="white">{contractAddress}</Text></Text>
          <Text dimColor>Amount    <Text color="white">{amountStr}</Text></Text>
          <Text dimColor>Recipient <Text color="white">this wallet's shielded address</Text></Text>
          <Text dimColor>ZK proof generation will take 30–60 seconds.</Text>
          <SelectInput
            items={[
              {label: 'Mint',   value: 'mint'},
              {label: 'Cancel', value: 'cancel'},
            ]}
            onSelect={item => {
              if (item.value === 'mint') void handleMint();
              else onComplete();
            }}
          />
          <Text dimColor>[Esc] back</Text>
        </Box>
      )}
    </Box>
  );
}
