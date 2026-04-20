import React, {useState} from 'react';
import {Box, Text} from 'ink';
import SelectInput from 'ink-select-input';
import TextInput   from 'ink-text-input';
import type {NetworkConfig, NetworkName} from '../types.js';
import {NETWORK_DEFAULTS} from '../types.js';
import {loadConfig} from '../config.js';

type Step = 'name' | 'nodeUrl' | 'indexerUrl' | 'proofServerUrl' | 'confirm';

interface Props {
  current:    NetworkConfig;
  onSave:     (config: NetworkConfig) => void;
  onComplete: () => void;
}

const NETWORK_ITEMS: {label: string; value: NetworkName}[] = [
  {label: 'mainnet',    value: 'mainnet'},
  {label: 'preprod',    value: 'preprod'},
  {label: 'preview',    value: 'preview'},
  {label: 'undeployed', value: 'undeployed'},
];

export default function Network({current, onSave, onComplete}: Props) {
  const [step,           setStep]           = useState<Step>('name');
  const [name,           setName]           = useState<NetworkName>(current.name);
  const [nodeUrl,        setNodeUrl]        = useState(current.nodeUrl);
  const [indexerUrl,     setIndexerUrl]     = useState(current.indexerUrl);
  const [proofServerUrl, setProofServerUrl] = useState(current.proofServerUrl);

  function handleNameSelect(item: {value: NetworkName}) {
    const n = item.value;
    setName(n);
    // Pre-fill with any previously stored overrides, falling back to defaults.
    const saved = loadConfig().networkOverrides[n] ?? {};
    setNodeUrl(        saved.nodeUrl        ?? NETWORK_DEFAULTS[n].nodeUrl);
    setIndexerUrl(     saved.indexerUrl     ?? NETWORK_DEFAULTS[n].indexerUrl);
    setProofServerUrl( saved.proofServerUrl ?? NETWORK_DEFAULTS[n].proofServerUrl);
    setStep('nodeUrl');
  }

  function handleSave() {
    onSave({name, nodeUrl, indexerUrl, proofServerUrl});
    onComplete();
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="cyan">Network Configuration</Text>

      {/* Current config summary (always visible) */}
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        <Text dimColor>Current: <Text color="white">{current.name}</Text></Text>
        <Text dimColor>Node         <Text color="white">{current.nodeUrl}</Text></Text>
        <Text dimColor>Indexer      <Text color="white">{current.indexerUrl}</Text></Text>
        <Text dimColor>Proof server <Text color="white">{current.proofServerUrl}</Text></Text>
      </Box>

      {/* Step 1 — network name */}
      {step === 'name' && (
        <Box flexDirection="column">
          <Text>Select network:</Text>
          <SelectInput
            items={NETWORK_ITEMS}
            initialIndex={NETWORK_ITEMS.findIndex(i => i.value === current.name)}
            onSelect={handleNameSelect}
          />
        </Box>
      )}

      {/* Step 2 — node URL */}
      {step === 'nodeUrl' && (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>Network: <Text color="white">{name}</Text></Text>
          <Box gap={1}>
            <Text>Node URL: </Text>
            <TextInput
              value={nodeUrl}
              onChange={setNodeUrl}
              onSubmit={() => setStep('indexerUrl')}
            />
          </Box>
          <Text dimColor>Enter to confirm, or edit and press Enter.</Text>
        </Box>
      )}

      {/* Step 3 — indexer URL */}
      {step === 'indexerUrl' && (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>Network: <Text color="white">{name}</Text></Text>
          <Text dimColor>Node:    <Text color="white">{nodeUrl}</Text></Text>
          <Box gap={1}>
            <Text>Indexer URL: </Text>
            <TextInput
              value={indexerUrl}
              onChange={setIndexerUrl}
              onSubmit={() => setStep('proofServerUrl')}
            />
          </Box>
        </Box>
      )}

      {/* Step 4 — proof server URL */}
      {step === 'proofServerUrl' && (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>Network: <Text color="white">{name}</Text></Text>
          <Text dimColor>Node:    <Text color="white">{nodeUrl}</Text></Text>
          <Text dimColor>Indexer: <Text color="white">{indexerUrl}</Text></Text>
          <Box gap={1}>
            <Text>Proof server URL: </Text>
            <TextInput
              value={proofServerUrl}
              onChange={setProofServerUrl}
              onSubmit={() => setStep('confirm')}
            />
          </Box>
        </Box>
      )}

      {/* Step 5 — confirm */}
      {step === 'confirm' && (
        <Box flexDirection="column" gap={1}>
          <Text bold>Confirm new configuration</Text>
          <Text dimColor>Network      <Text color="white">{name}</Text></Text>
          <Text dimColor>Node         <Text color="white">{nodeUrl}</Text></Text>
          <Text dimColor>Indexer      <Text color="white">{indexerUrl}</Text></Text>
          <Text dimColor>Proof server <Text color="white">{proofServerUrl}</Text></Text>
          <SelectInput
            items={[
              {label: 'Save',   value: 'save'},
              {label: 'Cancel', value: 'cancel'},
            ]}
            onSelect={item => {
              if (item.value === 'save') handleSave();
              else onComplete();
            }}
          />
        </Box>
      )}
    </Box>
  );
}
