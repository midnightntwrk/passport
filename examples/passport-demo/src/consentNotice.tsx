import type { CSSProperties, ReactNode } from 'react';
import { AlertTriangle, X } from 'lucide-react';

/**
 * The NON-MODAL half of the consent surfaces: a strip along the bottom of the
 * screen that says something, and blocks nothing.
 *
 * There are two things a consent surface has to say without taking the screen
 * away from the user, and until 2026/09/08 only one of them had a home:
 *
 *   - a launch this app could not parse, which is a developer's mistake and
 *     must never become a broken screen for the person holding the phone;
 *   - an app waiting on a Passport that is still being set up, where the modal
 *     sheet was the defect — its backdrop sat over the Welcome screen and the
 *     name step, so the one action that would have finished the answer was
 *     behind a locked door, and the app waited out its three minutes.
 *
 * Both are the same object, so they are one component rather than two copies
 * that drift. `pointer-events` is off on the wrapper and on for the strip, so
 * everything around it stays live: the whole point is that the user can carry
 * on with what they were doing.
 *
 * Inline styles rather than a class, for the reason `screens/callbackConsent`
 * gave when it first wrote them: this is not one of the `.profile-consent*`
 * shapes and growing the stylesheet for it would imply it is.
 */

const styles = {
  wrapper: {
    position: 'fixed',
    zIndex: 130,
    right: 16,
    bottom: 16,
    left: 16,
    display: 'flex',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  notice: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 12,
    width: 'min(520px, 100%)',
    padding: '14px 16px',
    border: '1px solid #111',
    borderLeftWidth: 3,
    color: '#111',
    background: '#f8f8f6',
    boxShadow: '0 18px 48px rgba(0, 0, 0, .28)',
    font: 'inherit',
    fontSize: 13,
    lineHeight: 1.5,
    pointerEvents: 'auto',
  },
  dismiss: {
    display: 'grid',
    placeItems: 'center',
    width: 26,
    height: 26,
    flex: '0 0 auto',
    padding: 0,
    border: '1px solid #111',
    color: '#111',
    background: 'transparent',
    cursor: 'pointer',
  },
} as const satisfies Record<string, CSSProperties>;

interface ConsentNoticeProps {
  children: ReactNode;
  /** The lucide glyph to lead with. Defaults to the warning triangle. */
  icon?: ReactNode;
  /**
   * Offered only where dismissing is honest. A notice that says an app is
   * waiting has nothing to dismiss — the wait is real until the Passport is
   * set up — so that one carries no button.
   */
  onDismiss?: () => void;
}

export function ConsentNotice({ children, icon, onDismiss }: ConsentNoticeProps) {
  return (
    <div style={styles.wrapper}>
      <div style={styles.notice} role="status">
        {icon ?? <AlertTriangle size={16} aria-hidden />}
        <span style={{ flex: 1 }}>{children}</span>
        {onDismiss && (
          <button type="button" style={styles.dismiss} aria-label="Dismiss" onClick={onDismiss}>
            <X size={13} aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}
