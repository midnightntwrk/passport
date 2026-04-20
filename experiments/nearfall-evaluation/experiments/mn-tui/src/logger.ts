import {appendFileSync, readFileSync, writeFileSync} from 'fs';

// ---------------------------------------------------------------------------
// Singleton logger — writes one NDJSON line per entry to a file.
// The log path can be changed at runtime via setPath().
// The Logs screen calls tail() to get structured LogEntry objects for
// human-readable display; the raw file is machine-readable NDJSON.
// ---------------------------------------------------------------------------

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface LogEntry {
  ts:      string;
  level:   LogLevel;
  msg:     string;
  cause?:  string;   // error.message (or String(cause)) when a cause is supplied
  stack?:  string;   // error.stack when the cause is an Error object
}

class Logger {
  private path = 'mn-tui.log';

  /** Cumulative count of all log lines since startup or last clear(). */
  lineCount = 0;
  /** Cumulative count of warn/error calls since startup or last clear(). */
  issueCount = 0;

  getPath(): string { return this.path; }

  setPath(p: string) { this.path = p; }

  private write(level: LogLevel, msg: string, cause?: unknown) {
    const entry: LogEntry = {ts: new Date().toISOString(), level, msg};
    if (cause != null) {
      entry.cause = cause instanceof Error ? cause.message : String(cause);
      if (cause instanceof Error && cause.stack) entry.stack = cause.stack;
    }
    try {
      appendFileSync(this.path, JSON.stringify(entry) + '\n', 'utf8');
      this.lineCount++;
    } catch {
      // swallow — we never want logging to crash the TUI
    }
  }

  info (msg: string)                    { this.write('INFO',  msg); }
  warn (msg: string, cause?: unknown)   { this.issueCount++; this.write('WARN',  msg, cause); }
  error(msg: string, cause?: unknown)   { this.issueCount++; this.write('ERROR', msg, cause); }

  /** Read the last `n` log entries as parsed LogEntry objects. */
  tail(n = 200): LogEntry[] {
    try {
      const raw   = readFileSync(this.path, 'utf8');
      const lines = raw.split('\n').filter(l => l.length > 0);
      return lines.slice(-n).map(l => {
        try {
          return JSON.parse(l) as LogEntry;
        } catch {
          // Legacy plain-text line — wrap it so the screen can still render it.
          return {ts: '', level: 'INFO' as LogLevel, msg: l};
        }
      });
    } catch {
      return [];
    }
  }

  /** Truncate / clear the log file and reset counters. */
  clear() {
    try { writeFileSync(this.path, '', 'utf8'); } catch { /* swallow */ }
    this.lineCount  = 0;
    this.issueCount = 0;
  }
}

export const logger = new Logger();
