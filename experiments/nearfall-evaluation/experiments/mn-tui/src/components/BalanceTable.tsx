import React from 'react';
import {Box, Text} from 'ink';
import type {TokenBalance} from '../types.js';

interface Props {
  balances: TokenBalance[];
}

function formatAmount(amount: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole   = amount / divisor;
  const frac    = amount % divisor;
  return `${whole}.${frac.toString().padStart(decimals, '0')}`;
}

export default function BalanceTable({balances}: Props) {
  if (balances.length === 0) {
    return <Text dimColor>No balances available.</Text>;
  }

  return (
    <Box flexDirection="column">
      <Box gap={2}>
        <Box width={10}><Text bold color="cyan">Token</Text></Box>
        <Box width={8}><Text bold color="cyan">Type</Text></Box>
        <Text bold color="cyan">Amount</Text>
      </Box>
      <Box>
        <Text dimColor>{'─'.repeat(40)}</Text>
      </Box>
      {balances.map(b => (
        <Box key={`${b.symbol}-${b.kind}`} gap={2}>
          <Box width={10}><Text bold>{b.symbol}</Text></Box>
          <Box width={8}><Text dimColor>{b.kind}</Text></Box>
          <Text>{formatAmount(b.amount, b.decimals)}</Text>
        </Box>
      ))}
    </Box>
  );
}
