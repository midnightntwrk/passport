import React from 'react';
import {Box, Text, useInput} from 'ink';
import type {Screen} from '../types.js';

const SCREEN_ITEMS: {key: string; label: string; screen: Screen}[] = [
  {key: '1', label: 'Dashboard', screen: 'dashboard'},
  {key: '2', label: 'Setup',     screen: 'setup'},
  {key: '3', label: 'Register',  screen: 'register'},
  {key: '4', label: 'Update',    screen: 'update'},
  {key: '5', label: 'Keys',      screen: 'keys'},
  {key: '6', label: 'Network',   screen: 'network'},
  {key: '7', label: 'Logs',      screen: 'logs'},
];

interface Props {
  current:      Screen;
  onNavigate:   (screen: Screen) => void;
  hasNewLogs:   boolean;
  menuActive:   boolean;
  onMenuToggle: () => void;
  locked?:      boolean;
}

export default function NavMenu(
  {current, onNavigate, hasNewLogs, menuActive, onMenuToggle, locked}: Props,
) {
  useInput((input) => {
    const item = SCREEN_ITEMS.find(s => s.key === input);
    if (item) { onNavigate(item.screen); onMenuToggle(); }
  }, {isActive: menuActive});

  return (
    <Box
      borderStyle="single"
      borderColor={menuActive ? 'cyan' : undefined}
      paddingX={1}
      gap={2}
      flexWrap="wrap"
    >
      {SCREEN_ITEMS.map(({key, label, screen}) => (
        <Box key={screen} gap={0}>
          <Text
            bold={current === screen}
            color={current === screen ? 'cyan' : undefined}
            dimColor={current !== screen}
          >
            {key}:{label}
          </Text>
          {screen === 'logs' && hasNewLogs && current !== 'logs' && (
            <Text color="yellow"> ●</Text>
          )}
        </Box>
      ))}
      {locked
        ? <Text color="yellow">[nav locked — Esc to cancel]</Text>
        : <Text dimColor>{menuActive ? '[1-7 navigate]' : '[M-m]'}</Text>
      }
    </Box>
  );
}
