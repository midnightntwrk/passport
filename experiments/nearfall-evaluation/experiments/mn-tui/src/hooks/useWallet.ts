import React, {createContext, useContext, useState, useCallback, useEffect} from 'react';
import type {WalletEntry, TokenBalance, SendParams, TxStatus, NetworkName} from '../types.js';
import {loadConfig, saveConfig}        from '../config.js';
import type {PersistedWallet}          from '../config.js';
import {decryptMnemonic, deriveFromMnemonic} from '../keys.js';

// ---------------------------------------------------------------------------
// Stub balances — replaced when real wallet sync is implemented
// ---------------------------------------------------------------------------

const STUB_BALANCES: TokenBalance[] = [
  {symbol: 'NIGHT', kind: 'NIGHT', amount: 0n, decimals: 6},
  {symbol: 'DUST',  kind: 'DUST',  amount: 0n, decimals: 6},
];

// ---------------------------------------------------------------------------
// Context value type
// ---------------------------------------------------------------------------

interface WalletContextValue {
  wallets:        WalletEntry[];
  persisted:      PersistedWallet[];
  activeIndex:    number;
  activeWallet:   WalletEntry | null;
  networkName:    NetworkName;
  /** Notify the wallet context that the active network changed. */
  setNetwork:     (name: NetworkName) => void;
  addWallet:      (pw: PersistedWallet, plainMnemonic?: string) => void;
  removeWallet:   (idx: number) => void;
  setActiveIndex: (idx: number) => void;
  isCached:       (idx: number) => boolean;
  getMnemonic:    (idx: number) => string | undefined;
  unlockWallet:   (idx: number, passphrase: string) => Promise<void>;
  wallet:         {connected: boolean; address: string; balances: TokenBalance[]};
  txStatus:       TxStatus;
  send:           (params: SendParams) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const WalletContext = createContext<WalletContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider — holds all shared wallet state; mount once near the root
// ---------------------------------------------------------------------------

export function WalletProvider({children}: {children: React.ReactNode}) {
  const [persisted,    setPersisted]    = useState<PersistedWallet[]>(
    () => loadConfig().wallets ?? [],
  );
  const [activeIndex,  setActiveIdx]    = useState<number>(() => {
    const cfg = loadConfig();
    const len = cfg.wallets?.length ?? 0;
    return len === 0 ? 0 : Math.max(0, Math.min(cfg.activeWallet ?? 0, len - 1));
  });
  const [networkName,  setNetworkName]  = useState<NetworkName>(() => loadConfig().lastNetwork);
  const [txStatus,     setTxStatus]     = useState<TxStatus>({stage: 'idle'});

  // Session-only mnemonic cache: wallet index → plaintext mnemonic.
  // Never persisted; cleared when wallets are removed (indices shift).
  const [mnemonicCache, setMnemonicCache] = useState<Map<number, string>>(() => new Map());

  // ---- address derivation -------------------------------------------------
  //
  // Whenever the active network or the mnemonic cache changes, check if any
  // wallet is missing addresses for the current network.  If the mnemonic is
  // available, derive and persist them automatically.

  useEffect(() => {
    let active = true;
    void (async () => {
      const toUpdate: Array<{idx: number; name: NetworkName; unshielded: string; shielded: string; dust: string}> = [];
      for (let i = 0; i < persisted.length; i++) {
        const pw = persisted[i];
        if (pw.addresses[networkName]) continue;   // already have it for this network
        const mnemonic = mnemonicCache.get(i);
        if (!mnemonic) continue;                   // can't derive without mnemonic
        try {
          const addrs = await deriveFromMnemonic(mnemonic, networkName);
          toUpdate.push({idx: i, name: networkName, ...addrs});
        } catch {
          // derivation failure is non-fatal; skip this wallet
        }
      }
      if (!active || toUpdate.length === 0) return;
      setPersisted(prev => {
        const next = [...prev];
        for (const {idx, name, unshielded, shielded, dust} of toUpdate) {
          next[idx] = {
            ...next[idx],
            addresses: {...next[idx].addresses, [name]: {unshielded, shielded, dust}},
          };
        }
        const cfg = loadConfig();
        saveConfig({...cfg, wallets: next});
        return next;
      });
    })();
    return () => { active = false; };
  }, [networkName, mnemonicCache]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- derived wallet list ------------------------------------------------

  const wallets: WalletEntry[] = persisted.map(p => {
    const addrs = p.addresses[networkName];
    return {
      name:       p.name,
      unshielded: addrs?.unshielded ?? '',
      shielded:   addrs?.shielded   ?? '',
      dust:       addrs?.dust        ?? '',
    };
  });

  const activeWallet = wallets[activeIndex] ?? null;

  // ---- mnemonic cache helpers ---------------------------------------------

  const isCached    = useCallback((idx: number) => mnemonicCache.has(idx), [mnemonicCache]);
  const getMnemonic = useCallback((idx: number) => mnemonicCache.get(idx), [mnemonicCache]);

  const unlockWallet = useCallback(async (idx: number, passphrase: string): Promise<void> => {
    const pw = persisted[idx];
    if (!pw?.encryptedMnemonic) throw new Error('Wallet has no encrypted mnemonic');
    const mnemonic = await decryptMnemonic(pw.encryptedMnemonic, passphrase);
    setMnemonicCache(prev => new Map(prev).set(idx, mnemonic));
  }, [persisted]);

  // ---- mutations ---------------------------------------------------------

  const addWallet = useCallback((pw: PersistedWallet, plainMnemonic?: string) => {
    setPersisted(prev => {
      const next    = [...prev, pw];
      const nextIdx = next.length - 1;
      if (plainMnemonic !== undefined) {
        setMnemonicCache(cache => new Map(cache).set(nextIdx, plainMnemonic));
      }
      setActiveIdx(nextIdx);
      const cfg = loadConfig();
      saveConfig({...cfg, wallets: next, activeWallet: nextIdx});
      return next;
    });
  }, []);

  const removeWallet = useCallback((idx: number) => {
    setMnemonicCache(new Map());
    setPersisted(prev => {
      const next    = prev.filter((_, i) => i !== idx);
      const nextIdx = Math.max(0, Math.min(activeIndex, next.length - 1));
      setActiveIdx(nextIdx);
      const cfg = loadConfig();
      saveConfig({...cfg, wallets: next, activeWallet: nextIdx});
      return next;
    });
  }, [activeIndex]);

  const setActiveIndex = useCallback((idx: number) => {
    const clamped = Math.max(0, Math.min(idx, wallets.length - 1));
    setActiveIdx(clamped);
    const cfg = loadConfig();
    saveConfig({...cfg, activeWallet: clamped});
  }, [wallets.length]);

  const setNetwork = useCallback((name: NetworkName) => {
    setNetworkName(name);
    // lastNetwork is already persisted by the caller (App.applyNetwork) along
    // with the network overrides, so we don't duplicate the save here.
  }, []);

  // ---- send (stub) -------------------------------------------------------

  const send = useCallback(async (_params: SendParams) => {
    setTxStatus({stage: 'building'});
    await delay(500);
    setTxStatus({stage: 'proving'});
    await delay(1_500);
    setTxStatus({stage: 'submitting'});
    await delay(500);
    setTxStatus({stage: 'pending', txHash: '0xSTUB_TX_HASH'});
  }, []);

  const wallet = {
    connected: activeWallet !== null,
    address:   activeWallet?.unshielded ?? '',
    balances:  STUB_BALANCES,
  };

  const value: WalletContextValue = {
    wallets, persisted, activeIndex, activeWallet,
    networkName, setNetwork,
    addWallet, removeWallet, setActiveIndex,
    isCached, getMnemonic, unlockWallet,
    wallet, txStatus, send,
  };

  return React.createElement(WalletContext.Provider, {value}, children);
}

// ---------------------------------------------------------------------------
// Hook — consumes the shared context
// ---------------------------------------------------------------------------

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error('useWallet must be used inside <WalletProvider>');
  return ctx;
}

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }
