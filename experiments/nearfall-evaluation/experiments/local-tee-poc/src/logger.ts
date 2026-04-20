import {appendFileSync, readFileSync, writeFileSync} from 'fs';
import {homedir}                                      from 'os';
import {join}                                         from 'path';

// ---------------------------------------------------------------------------
// Singleton logger — writes one NDJSON line per entry to a file.
// ---------------------------------------------------------------------------

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface LogEntry {
  ts:     string;
  level:  LogLevel;
  msg:    string;
  cause?: string;
  stack?: string;
}

class Logger {
  private path = join(homedir(), '.local-tee-poc.log');

  lineCount  = 0;
  issueCount = 0;

  getPath(): string { return this.path; }
  setPath(p: string) { this.path = p; }

  private write(level: LogLevel, msg: string, cause?: unknown) {
    const entry: LogEntry = {ts: new Date().toISOString(), level, msg};
    if (cause != null) {
      // Recursively unwrap cause chains so ContractRuntimeError / wrapped errors
      // surface their root cause in the log.
      const causeChain: string[] = [];
      let c: unknown = cause;
      while (c != null) {
        causeChain.push(c instanceof Error ? c.message : String(c));
        c = c instanceof Error ? (c as any).cause : undefined;
      }
      entry.cause = causeChain.join(' → ');
      if (cause instanceof Error && cause.stack) entry.stack = cause.stack;
    }
    try {
      appendFileSync(this.path, JSON.stringify(entry) + '\n', 'utf8');
      this.lineCount++;
    } catch {
      // swallow — never crash the TUI
    }
  }

  info (msg: string)                  { this.write('INFO',  msg); }
  warn (msg: string, cause?: unknown) { this.issueCount++; this.write('WARN',  msg, cause); }
  error(msg: string, cause?: unknown) { this.issueCount++; this.write('ERROR', msg, cause); }

  tail(n = 200): LogEntry[] {
    try {
      const raw   = readFileSync(this.path, 'utf8');
      const lines = raw.split('\n').filter(l => l.length > 0);
      return lines.slice(-n).map(l => {
        try { return JSON.parse(l) as LogEntry; }
        catch { return {ts: '', level: 'INFO' as LogLevel, msg: l}; }
      });
    } catch {
      return [];
    }
  }

  clear() {
    try { writeFileSync(this.path, '', 'utf8'); } catch { /* swallow */ }
    this.lineCount  = 0;
    this.issueCount = 0;
  }
}

export const logger = new Logger();
