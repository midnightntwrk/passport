import React from 'react';
import {Box, Text} from 'ink';
import type {TxStatus as TxStatusType} from '../types.js';

interface Props {
  status: TxStatusType;
  label?: string;  // optional prefix label (e.g. "Deploy", "Register")
}

export default function TxStatus({status, label}: Props) {
  const prefix = label ? `${label}: ` : '';
  switch (status.stage) {
    case 'idle':
      return null;

    case 'building':
      return (
        <Box gap={1}>
          <Text color="yellow">○</Text>
          <Text>{prefix}Building transaction…</Text>
        </Box>
      );

    case 'proving':
      return (
        <Box gap={1}>
          <Text color="yellow">○</Text>
          <Text>{prefix}Generating ZK proof… (30–60 s)</Text>
        </Box>
      );

    case 'submitting':
      return (
        <Box gap={1}>
          <Text color="yellow">○</Text>
          <Text>{prefix}Submitting to node…</Text>
        </Box>
      );

    case 'pending':
      return (
        <Box flexDirection="column">
          <Box gap={1}>
            <Text color="green">●</Text>
            <Text>{prefix}Pending…</Text>
          </Box>
          <Text dimColor>{status.txHash}</Text>
        </Box>
      );

    case 'confirmed':
      return (
        <Box flexDirection="column">
          <Box gap={1}>
            <Text color="green">✓</Text>
            <Text>{prefix}Done</Text>
          </Box>
          <Text dimColor>{status.txHash}</Text>
        </Box>
      );

    case 'failed':
      return (
        <Box flexDirection="column">
          <Text color="red">✗ {prefix}Failed</Text>
          <Text dimColor>{status.error}</Text>
        </Box>
      );
  }
}
