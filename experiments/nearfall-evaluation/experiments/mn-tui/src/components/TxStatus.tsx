import React from 'react';
import {Box, Text} from 'ink';
import type {TxStatus as TxStatusType} from '../types.js';

interface Props {
  status: TxStatusType;
}

export default function TxStatus({status}: Props) {
  switch (status.stage) {
    case 'idle':
      return null;

    case 'building':
      return (
        <Box gap={1}>
          <Text color="yellow">○</Text>
          <Text>Building transaction…</Text>
        </Box>
      );

    case 'proving':
      return (
        <Box gap={1}>
          <Text color="yellow">○</Text>
          <Text>Generating ZK proof…</Text>
        </Box>
      );

    case 'submitting':
      return (
        <Box gap={1}>
          <Text color="yellow">○</Text>
          <Text>Submitting to node…</Text>
        </Box>
      );

    case 'pending':
      return (
        <Box flexDirection="column">
          <Box gap={1}>
            <Text color="green">●</Text>
            <Text>Submitted</Text>
          </Box>
          <Text dimColor>{status.txHash}</Text>
        </Box>
      );

    case 'confirmed':
      return (
        <Box flexDirection="column">
          <Box gap={1}>
            <Text color="green">✓ Confirmed at block {status.blockHeight}</Text>
          </Box>
          <Text dimColor>{status.txHash}</Text>
        </Box>
      );

    case 'failed':
      return (
        <Box flexDirection="column">
          <Text color="red">✗ Transaction failed</Text>
          <Text dimColor>{status.error}</Text>
        </Box>
      );
  }
}
