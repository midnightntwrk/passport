// Shared UI atoms for the demo shell.

import React, { useState } from 'react';

import { beginTask, completeTask, failTask } from './lib/txTracker.js';

/** Card with brand "page furniture" header. `x` adds a hover explainer. */
export function Panel(props: {
  title: string;
  sub?: string;
  children: React.ReactNode;
  tone?: 'default' | 'dapp' | 'scaffold';
  className?: string;
  x?: string;
}) {
  const tone = props.tone ?? 'default';
  return (
    <section className={`panel panel-${tone} ${props.className ?? ''}`}>
      <header className="panel-head" data-x={props.x}>
        <h2 className="eyebrow">{props.title}</h2>
        {props.sub && <p className="panel-sub">{props.sub}</p>}
      </header>
      {props.children}
    </section>
  );
}

/** Numbered view header — the presenter's beat. */
export function ViewHeader(props: { numeral?: string; title: string; narration: string }) {
  return (
    <header className="view-head">
      {props.numeral && <span className="view-num">{props.numeral}</span>}
      <div>
        <h1 className="view-title">{props.title}</h1>
        <p className="view-narration">{props.narration}</p>
      </div>
    </header>
  );
}

/** Hover-explainer wrapper: dashed-underlined when explain mode is on; the
    global ExplainTip tooltip (App.tsx) renders the `x` text on hover. */
export function X(props: { x: string; children: React.ReactNode }) {
  return (
    <span className="x" data-x={props.x}>
      {props.children}
    </span>
  );
}

export function Busy(props: { label: string }) {
  return (
    <span className="busy">
      <span className="spinner" /> {props.label}
    </span>
  );
}

/** Label-over-value document field, passport-data-page style. */
export function Field(props: {
  k: string;
  v: React.ReactNode;
  big?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={`docfield ${props.wide ? 'docfield-wide' : ''}`}>
      <span className="docfield-k">{props.k}</span>
      <span className={`docfield-v ${props.big ? 'docfield-big' : ''}`}>{props.v}</span>
    </div>
  );
}

const group4 = (s: string) => s.replace(/(....)/g, '$1 ').trim().toUpperCase();

/** Copyable hash / address. `group` renders document-number spacing. */
export function Mono(props: { v: string; short?: boolean; group?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false);
  let text: string;
  if (props.group && props.short && props.v.length > 28) {
    text = `${group4(props.v.slice(0, 16))} … ${group4(props.v.slice(-8))}`;
  } else if (props.short && props.v.length > 24) {
    text = `${props.v.slice(0, 12)}…${props.v.slice(-8)}`;
  } else {
    text = props.v;
  }
  if (props.group && !(props.short && props.v.length > 28)) text = group4(text);
  return (
    <code
      className={`mono ${copied ? 'copied' : ''} ${props.className ?? ''}`}
      title={copied ? 'copied' : `${props.v} — click to copy`}
      onClick={() => {
        navigator.clipboard?.writeText(props.v);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? 'copied ✓' : text}
    </code>
  );
}

export function Chip(props: {
  tone: 'ok' | 'muted' | 'danger' | 'warn' | 'info';
  children: React.ReactNode;
  /** Rubber-stamp rendering for document status (tilted when danger). */
  stamp?: boolean;
}) {
  return (
    <span
      className={`chip chip-${props.tone} ${props.stamp ? 'chip-stamp' : ''} ${
        props.stamp && props.tone === 'danger' ? 'chip-tilt' : ''
      }`}
    >
      {props.children}
    </span>
  );
}

export function StatTile(props: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-k">{props.label}</span>
      {/* keyed so a value change re-mounts and replays the pulse animation */}
      <span className="stat-v" key={props.value}>
        {props.value}
      </span>
    </div>
  );
}

/** Spent-against-cap meter for grants. */
export function CapBar(props: { spent: bigint; cap: bigint }) {
  const pct = props.cap > 0n ? Math.min(100, Number((props.spent * 100n) / props.cap)) : 0;
  return (
    <div className="capbar" title={`${props.spent} of ${props.cap} spent`}>
      <div className="capbar-track">
        <div className="capbar-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="capbar-label">
        {String(props.spent)} <span className="dim">/ {String(props.cap)}</span>
      </span>
    </div>
  );
}

/**
 * Async action button. When `task` is given the run is tracked in the
 * proving dock (build → prove → submit); `onRun` may return the landed tx
 * id so the dock can show it.
 */
export function ActionButton(props: {
  label: string;
  busyLabel?: string;
  onRun: () => Promise<string | void>;
  disabled?: boolean;
  kind?: 'primary' | 'ghost' | 'danger';
  block?: boolean;
  task?: { label: string; circuit: string };
  onError?: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const kind = props.kind ?? 'primary';
  return (
    <button
      className={`btn btn-${kind} ${props.block ? 'btn-block' : ''}`}
      disabled={busy || props.disabled}
      onClick={async () => {
        setBusy(true);
        if (props.task) beginTask(props.task.label, props.task.circuit);
        try {
          const txId = await props.onRun();
          if (props.task) completeTask(typeof txId === 'string' ? txId : undefined);
        } catch (e: any) {
          const message = String(e?.message ?? e);
          if (props.task) failTask(message);
          props.onError?.(message);
          console.error(`[passport] action failed: ${message}`, e);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? (
        <>
          <span className="spinner spinner-btn" /> {props.busyLabel ?? 'working…'}
        </>
      ) : (
        props.label
      )}
    </button>
  );
}
