import React from 'react';
import {Box, Text} from 'ink';
import type {ComplianceSyncState} from '../hooks/useCompliance.js';
import type {NetworkConfig} from '../types.js';
import {TIER_LABELS} from '../types.js';
import type {ComplianceTier} from '../types.js';

interface Props {
  network:    NetworkConfig;
  compliance: ComplianceSyncState;
}

const TIER_COLORS: Record<ComplianceTier, string> = {
  0: 'red',
  1: 'yellow',
  2: 'cyan',
  3: 'green',
};

export default function Dashboard({network, compliance}: Props) {
  const {walletReady, walletAddress, contractAddress, onChain, teeKeyLoaded, error} = compliance;

  const tierLabel = onChain ? TIER_LABELS[onChain.tier as ComplianceTier] : '—';
  const tierColor = onChain ? TIER_COLORS[onChain.tier as ComplianceTier] : 'white';

  return (
    <Box flexDirection="column" gap={1}>

      {/* Network status */}
      <Box borderStyle="single" paddingX={1} flexDirection="column">
        <Text bold>Network</Text>
        <Box gap={2}>
          <Text dimColor>Network:</Text>
          <Text color="yellow">{network.name}</Text>
        </Box>
        <Box gap={2}>
          <Text dimColor>Node:   </Text>
          <Text>{network.nodeUrl}</Text>
        </Box>
        <Box gap={2}>
          <Text dimColor>Indexer:</Text>
          <Text>{network.indexerUrl}</Text>
        </Box>
        <Box gap={2}>
          <Text dimColor>Proofs: </Text>
          <Text>{network.proofServerUrl}</Text>
        </Box>
      </Box>

      {/* Wallet status */}
      <Box borderStyle="single" paddingX={1} flexDirection="column">
        <Text bold>Wallet</Text>
        <Box gap={2}>
          <Text dimColor>Status: </Text>
          <Text color={walletReady ? 'green' : 'yellow'}>
            {walletReady ? 'Synced' : 'Syncing…'}
          </Text>
        </Box>
        {walletAddress && (
          <Box gap={2}>
            <Text dimColor>Address:</Text>
            <Text>{walletAddress}</Text>
          </Box>
        )}
        <Box gap={2}>
          <Text dimColor>TEE key:</Text>
          <Text color={teeKeyLoaded ? 'green' : 'red'}>
            {teeKeyLoaded ? 'Loaded (stub)' : 'Not loaded'}
          </Text>
        </Box>
      </Box>

      {/* Contract state */}
      <Box borderStyle="single" paddingX={1} flexDirection="column">
        <Text bold>Contract State</Text>
        {contractAddress ? (
          <>
            <Box gap={2}>
              <Text dimColor>Address:  </Text>
              <Text>{contractAddress}</Text>
            </Box>
            {onChain ? (
              <>
                <Box gap={2}>
                  <Text dimColor>Tier:     </Text>
                  <Text color={tierColor} bold>{onChain.tier} — {tierLabel}</Text>
                </Box>
                <Box gap={2}>
                  <Text dimColor>Device:   </Text>
                  <Text color={onChain.deviceRegistered ? 'green' : 'red'}>
                    {onChain.deviceRegistered ? 'Registered' : 'Not registered'}
                  </Text>
                </Box>
                <Box gap={2}>
                  <Text dimColor>Updates:  </Text>
                  <Text>{String(onChain.updateCount)}</Text>
                </Box>
              </>
            ) : (
              <Text dimColor>Reading state…</Text>
            )}
          </>
        ) : (
          <Text dimColor>No contract connected.  Use Setup screen to deploy or connect.</Text>
        )}
      </Box>

      {error && (
        <Box borderStyle="single" borderColor="red" paddingX={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

    </Box>
  );
}
