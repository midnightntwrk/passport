import React, {useState, useCallback}           from 'react';
import {Box, Text, useInput}                     from 'ink';
import TextInput                                  from 'ink-text-input';
import * as path                                  from 'node:path';
import {pathToFileURL}                            from 'node:url';
import {getPublicStates}                          from '@midnight-ntwrk/midnight-js-contracts';
import {indexerPublicDataProvider}                from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import type {NetworkConfig}                       from '../types.js';

type Step = 'address' | 'managed' | 'loading' | 'result';

interface Props {
  network: NetworkConfig;
}

/** Pretty-print any value as JSON, handling BigInt and binary types. */
function serialize(v: unknown): string {
  return JSON.stringify(v, (_key, val) => {
    if (typeof val === 'bigint')    return val.toString();
    if (val instanceof Uint8Array)  return '0x' + Buffer.from(val).toString('hex');
    if (val instanceof Map)         return Object.fromEntries(val.entries());
    if (val instanceof Set)         return [...val];
    return val;
  }, 2) ?? 'null';
}

export default function Contract({network}: Props) {
  const [step,         setStep]         = useState<Step>('address');
  const [addrInput,    setAddrInput]    = useState('');
  const [managedInput, setManagedInput] = useState('');
  const [lastAddr,     setLastAddr]     = useState('');
  const [lastManaged,  setLastManaged]  = useState('');
  const [json,         setJson]         = useState('');
  const [error,        setError]        = useState<string | null>(null);

  const doFetch = useCallback(async (addr: string, managedPath: string) => {
    const clean = addr.trim().replace(/^0x/i, '');
    if (!clean) return;
    setLastAddr(clean);
    setLastManaged(managedPath.trim());
    setStep('loading');
    setError(null);
    try {
      const httpUrl = network.indexerUrl;
      const wsUrl   = httpUrl.replace(/^https/, 'wss').replace(/^http/, 'ws') + '/ws';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const provider = indexerPublicDataProvider(httpUrl, wsUrl) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const {contractState} = await (getPublicStates as any)(provider, clean) as any;

      if (managedPath.trim()) {
        // Decode with the contract's own ledger() function.
        const contractJs = path.join(managedPath.trim(), 'contract', 'index.js');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mod: any = await import(pathToFileURL(contractJs).href);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        setJson(serialize((mod.ledger as any)(contractState.data)));
      } else {
        // No decoder — display raw state bytes as hex.
        const raw = contractState?.data as Uint8Array | undefined;
        setJson(serialize(raw ? {'raw_bytes': '0x' + Buffer.from(raw).toString('hex')} : null));
      }
      setError(null);
    } catch (e) {
      setJson('');
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStep('result');
    }
  }, [network]); // eslint-disable-line react-hooks/exhaustive-deps

  useInput((input, key) => {
    if (step === 'managed' && key.escape) { setStep('address'); return; }
    if (step !== 'result') return;
    if (input === 'r')               { void doFetch(lastAddr, lastManaged); return; }
    if (input === 'n' || key.escape) { setAddrInput(lastAddr); setStep('address'); }
  });

  function handleAddressSubmit(v: string) {
    const clean = v.trim().replace(/^0x/i, '');
    if (!clean) return;
    setAddrInput(clean);
    setStep('managed');
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="cyan">Contract State</Text>
      <Text dimColor>Reads the public ledger state of any deployed contract.</Text>

      {step === 'address' && (
        <Box gap={1}>
          <Text>Contract address: </Text>
          <TextInput
            value={addrInput}
            onChange={setAddrInput}
            onSubmit={handleAddressSubmit}
            placeholder="hex contract address"
          />
        </Box>
      )}

      {step === 'managed' && (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>Address <Text color="white">{addrInput}</Text></Text>
          <Box gap={1}>
            <Text>managed/ path (optional): </Text>
            <TextInput
              value={managedInput}
              onChange={setManagedInput}
              onSubmit={v => { void doFetch(addrInput, v); }}
              placeholder="path/to/managed/contract  or  Enter for raw bytes"
            />
          </Box>
          <Text dimColor>
            The contract's compiled managed/ directory, used to decode the ledger state.
            Leave blank to display raw bytes.
          </Text>
          <Text dimColor>[Enter] fetch  [Esc] back</Text>
        </Box>
      )}

      {step === 'loading' && (
        <Text dimColor>Fetching state…</Text>
      )}

      {step === 'result' && (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>address <Text color="white">{lastAddr}</Text></Text>
          {lastManaged && <Text dimColor>managed <Text color="white">{lastManaged}</Text></Text>}
          {error
            ? <Text color="red">{error}</Text>
            : <Text>{json}</Text>
          }
          <Text dimColor>[r] refresh  [n / Esc] new address</Text>
        </Box>
      )}
    </Box>
  );
}
