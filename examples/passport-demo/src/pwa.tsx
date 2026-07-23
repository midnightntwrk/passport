import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Download, RefreshCw, WifiOff } from 'lucide-react';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{
    outcome: 'accepted' | 'dismissed';
    platform: string;
  }>;
}

interface NavigatorWithStandalone extends Navigator {
  standalone?: boolean;
}

function isStandaloneDisplay(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    Boolean((navigator as NavigatorWithStandalone).standalone)
  );
}

function pwaRegistrationEnabled(): boolean {
  return import.meta.env.PROD || import.meta.env.VITE_ENABLE_PWA_DEV === 'true';
}

export async function requestPassportStoragePersistence(): Promise<boolean | null> {
  if (!navigator.storage?.persist) return null;
  try {
    if (await navigator.storage.persisted?.()) return true;
    return navigator.storage.persist();
  } catch {
    return null;
  }
}

export function PassportPwaShell({ children }: { children: ReactNode }) {
  const [online, setOnline] = useState(() => navigator.onLine);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [updateRegistration, setUpdateRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [reloadingForUpdate, setReloadingForUpdate] = useState(false);
  const [standalone, setStandalone] = useState(isStandaloneDisplay);
  const reloadOnControllerChange = useRef(false);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstallPrompt(null);
      setStandalone(true);
    };

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('beforeinstallprompt', onInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('beforeinstallprompt', onInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  useEffect(() => {
    if (!pwaRegistrationEnabled() || !('serviceWorker' in navigator)) return;

    let disposed = false;
    let updateTimer: number | undefined;

    const inspectInstallingWorker = (registration: ServiceWorkerRegistration) => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        if (
          !disposed &&
          installing.state === 'installed' &&
          navigator.serviceWorker.controller
        ) {
          setUpdateRegistration(registration);
        }
      });
    };

    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js', {
          scope: '/',
          updateViaCache: 'none',
        });
        if (disposed) return;
        if (registration.waiting) setUpdateRegistration(registration);
        inspectInstallingWorker(registration);
        registration.addEventListener('updatefound', () => inspectInstallingWorker(registration));
        updateTimer = window.setInterval(() => void registration.update(), 60 * 60 * 1_000);
      } catch (error) {
        console.error('Midnight Passport service worker registration failed.', error);
      }
    };

    const onControllerChange = () => {
      if (reloadOnControllerChange.current) window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    if (document.readyState === 'complete') {
      void register();
    } else {
      window.addEventListener('load', register, { once: true });
    }

    return () => {
      disposed = true;
      if (updateTimer) window.clearInterval(updateTimer);
      window.removeEventListener('load', register);
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);

  const install = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === 'accepted') setInstallPrompt(null);
  };

  const activateUpdate = () => {
    const waiting = updateRegistration?.waiting;
    if (!waiting) return;
    reloadOnControllerChange.current = true;
    setReloadingForUpdate(true);
    waiting.postMessage({ type: 'SKIP_WAITING' });
  };

  return (
    <>
      {children}

      {!online && (
        <div className="pwa-offline-bar" role="status" aria-live="polite">
          <WifiOff size={15} aria-hidden="true" />
          <span>
            Offline shell. Sign-in, wallet sync, proofs, and transactions require a connection.
          </span>
        </div>
      )}

      <div className="pwa-actions" aria-live="polite">
        {updateRegistration && (
          <button
            type="button"
            className="pwa-action"
            onClick={activateUpdate}
            disabled={reloadingForUpdate}
          >
            <RefreshCw className={reloadingForUpdate ? 'spin' : undefined} size={15} />
            {reloadingForUpdate ? 'Updating' : 'Update Passport'}
          </button>
        )}
        {installPrompt && !standalone && (
          <button type="button" className="pwa-action" onClick={() => void install()}>
            <Download size={15} />
            Install Passport
          </button>
        )}
      </div>
    </>
  );
}
