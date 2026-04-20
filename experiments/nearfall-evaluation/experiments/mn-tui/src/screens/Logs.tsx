import React, {useState, useEffect, useRef} from 'react';
import {Box, Text, useInput} from 'ink';
import TextInput from 'ink-text-input';
import {logger}  from '../logger.js';
import type {LogEntry} from '../logger.js';

type Mode = 'view' | 'rename';

function entryColor(level: LogEntry['level']): string | undefined {
  if (level === 'ERROR') return 'red';
  if (level === 'WARN')  return 'yellow';
  return undefined;
}

function formatEntry(e: LogEntry): string {
  const time = e.ts ? e.ts.slice(11, 19) : '        ';
  const lvl  = e.level ? e.level.padEnd(5) : 'INFO ';
  const body = e.cause && e.cause !== e.msg ? `${e.msg}: ${e.cause}` : e.msg;
  return `${time} [${lvl}] ${body}`;
}

export default function Logs() {
  const [mode,    setMode]    = useState<Mode>('view');
  const [lines,   setLines]   = useState<LogEntry[]>([]);
  const [draft,   setDraft]   = useState(logger.getPath());
  const [message, setMessage] = useState('');
  const seenCountRef          = useRef(-1);

  // Load on mount / return to view mode; capture the current lineCount.
  useEffect(() => {
    if (mode !== 'view') return;
    seenCountRef.current = logger.lineCount;
    setLines(logger.tail(40));
  }, [mode]);

  // Poll every 2 s but only re-render when new entries have appeared.
  useEffect(() => {
    if (mode !== 'view') return;
    const id = setInterval(() => {
      if (logger.lineCount !== seenCountRef.current) {
        seenCountRef.current = logger.lineCount;
        setLines(logger.tail(40));
      }
    }, 2_000);
    return () => clearInterval(id);
  }, [mode]);

  useInput((input, key) => {
    if (mode !== 'view') return;
    if (input === 'r') { setDraft(logger.getPath()); setMode('rename'); }
    if (input === 'c') {
      logger.clear();
      seenCountRef.current = 0;
      setLines([]);
      setMessage('Log cleared.');
      setTimeout(() => setMessage(''), 2_000);
    }
  });

  function commitRename(value: string) {
    const trimmed = value.trim();
    if (trimmed) {
      logger.setPath(trimmed);
      setMessage(`Log path set to "${trimmed}".`);
      setTimeout(() => setMessage(''), 3_000);
    }
    setMode('view');
  }

  return (
    <Box flexDirection="column" gap={1}>

      <Box gap={2}>
        <Text bold color="cyan">Logs</Text>
        <Text dimColor>{logger.getPath()}</Text>
      </Box>

      {mode === 'rename' ? (
        <Box gap={1}>
          <Text>New path: </Text>
          <TextInput
            value={draft}
            onChange={setDraft}
            onSubmit={commitRename}
          />
        </Box>
      ) : (
        <Text dimColor>[r] rename log file  [c] clear log</Text>
      )}

      {message && <Text color="green">{message}</Text>}

      <Box flexDirection="column" borderStyle="single" paddingX={1}>
        {lines.length === 0
          ? <Text dimColor>(log is empty)</Text>
          : lines.map((entry, i) => (
              <Text key={i} color={entryColor(entry.level)} wrap="truncate">
                {formatEntry(entry)}
              </Text>
            ))
        }
      </Box>

    </Box>
  );
}
