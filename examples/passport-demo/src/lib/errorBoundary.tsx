/**
 * The last line of defence around the whole app.
 *
 * A render that throws below this point leaves React with an empty tree — a
 * blank white screen with no way forward, which is the worst thing a Passport
 * can show. This catches it and offers the one action that reliably helps:
 * reload. Nothing about the failure is displayed or recorded; the message a
 * thrown error carries can name internals, and none of that belongs on screen.
 *
 * A class, because `componentDidCatch` has no hook equivalent. It imports
 * nothing but React on purpose — it has to survive whatever broke.
 */

import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  failed: boolean;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(): void {
    /* Deliberately silent. The boundary's job is to keep a screen on the
       display, not to report — and an error thrown mid-ceremony can carry
       material we will not write anywhere. */
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '1rem',
          padding: '2rem',
          textAlign: 'center',
          font: '400 1rem/1.5 system-ui, sans-serif',
        }}
      >
        <p style={{ margin: 0, maxWidth: '28rem' }}>
          Something went wrong. Your Passport is safe — reload to carry on.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            padding: '0.75rem 1.5rem',
            borderRadius: '999px',
            border: '1px solid currentColor',
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            cursor: 'pointer',
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
