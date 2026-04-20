import React, {useState, useEffect} from 'react';
import {Box, Text, useApp, useStdout, useInput} from 'ink';
import NavMenu  from './components/NavMenu.js';
import Dashboard from './screens/Dashboard.js';
import Setup    from './screens/Setup.js';
import Register from './screens/Register.js';
import Update   from './screens/Update.js';
import Keys     from './screens/Keys.js';
import Network  from './screens/Network.js';
import Logs     from './screens/Logs.js';
import type {Screen, NetworkConfig} from './types.js';
import {loadConfig, saveConfig, buildNetworkConfig, configFileExists} from './config.js';
import {useCompliance} from './hooks/useCompliance.js';
import {logger}        from './logger.js';
import pkg             from '../package.json';

export default function App() {
  const {exit}   = useApp();
  const {stdout} = useStdout();

  const [screen,            setScreen]           = useState<Screen>(() => {
    if (!configFileExists()) return 'network';
    const cfg = loadConfig();
    if (cfg.encryptedMnemonic) return 'keys';
    return 'dashboard';
  });
  const [network,           setNetworkConfig]     = useState<NetworkConfig>(() => {
    const cfg = loadConfig();
    return buildNetworkConfig(cfg.lastNetwork, cfg.networkOverrides);
  });
  const [mnemonic,          setMnemonic]          = useState<string | null>(null);
  const [encryptedMnemonic, setEncryptedMnemonic] = useState<string | null>(
    () => loadConfig().encryptedMnemonic ?? null,
  );
  const [contractAddress,   setContractAddress]   = useState<string | null>(
    () => {
      const cfg = loadConfig();
      return cfg.contractAddresses[cfg.lastNetwork] ?? null;
    },
  );
  const [lineCount,         setLineCount]        = useState(() => logger.lineCount);
  const [lastSeenLineCount, setLastSeenLineCount] = useState(() => logger.lineCount);
  const [menuActive,        setMenuActive]       = useState(false);
  const [workInProgress,    setWorkInProgress]   = useState(false);

  const compliance = useCompliance(mnemonic, network, contractAddress);

  // Poll for new log lines every 5 s
  useEffect(() => {
    const id = setInterval(() => {
      const n = logger.lineCount;
      setLineCount(prev => prev === n ? prev : n);
    }, 5_000);
    return () => clearInterval(id);
  }, []);

  useInput((input, key) => {
    if (!key.meta) return;
    if (input === 'q') { exit(); return; }
    if (input === 'm' && !workInProgress) { setMenuActive(a => !a); return; }
  });

  const navigate = (s: Screen) => {
    setWorkInProgress(false);
    if (s === 'logs') setLastSeenLineCount(logger.lineCount);
    setScreen(s);
  };
  const toDash = () => navigate('dashboard');

  const applyNetwork = (cfg: NetworkConfig) => {
    setNetworkConfig(cfg);
    // Persist the new network config
    const stored = loadConfig();
    saveConfig({
      ...stored,
      lastNetwork:      cfg.name,
      networkOverrides: {
        ...stored.networkOverrides,
        [cfg.name]: {nodeUrl: cfg.nodeUrl, indexerUrl: cfg.indexerUrl, proofServerUrl: cfg.proofServerUrl},
      },
    });
    // When switching network, reload contract address for the new network
    setContractAddress(stored.contractAddresses[cfg.name] ?? null);
  };

  const handleEncryptedSaved = (encrypted: string) => {
    setEncryptedMnemonic(encrypted);
    const stored = loadConfig();
    saveConfig({...stored, encryptedMnemonic: encrypted});
  };

  const handleEncryptedDeleted = () => {
    setEncryptedMnemonic(null);
    const stored = loadConfig();
    const {encryptedMnemonic: _removed, ...rest} = stored;
    saveConfig(rest as typeof stored);
  };

  const saveContractAddress = (address: string) => {
    setContractAddress(address);
    const stored = loadConfig();
    saveConfig({
      ...stored,
      contractAddresses: {...stored.contractAddresses, [network.name]: address},
    });
  };

  return (
    <Box flexDirection="column" height={stdout.rows}>

      {/* Title bar */}
      <Box borderStyle="single" paddingX={1} justifyContent="space-between">
        <Box gap={2}>
          <Text bold color="cyan">local-tee-poc</Text>
          <Text dimColor>v{pkg.version}</Text>
          <Text dimColor>|</Text>
          <Text color="yellow">{network.name}</Text>
          {contractAddress && (
            <>
              <Text dimColor>|</Text>
              <Text dimColor>{contractAddress.slice(0, 16)}…</Text>
            </>
          )}
        </Box>
        <Box gap={2}>
          <Text dimColor>M-m — menu  M-q — exit</Text>
        </Box>
      </Box>

      {/* Navigation */}
      <NavMenu
        current={screen}
        onNavigate={navigate}
        hasNewLogs={lineCount > lastSeenLineCount}
        menuActive={menuActive}
        onMenuToggle={() => setMenuActive(a => !a)}
        locked={workInProgress}
      />

      {/* Active screen */}
      <Box paddingX={2} paddingY={1} flexGrow={1}>
        {screen === 'keys' && (
          <Keys
            mnemonic={mnemonic}
            encryptedMnemonic={encryptedMnemonic}
            onMnemonicLoaded={setMnemonic}
            onMnemonicCleared={() => setMnemonic(null)}
            onEncryptedSaved={handleEncryptedSaved}
            onEncryptedDeleted={handleEncryptedDeleted}
            onComplete={toDash}
          />
        )}
        {screen === 'network' && (
          <Network
            current={network}
            onSave={applyNetwork}
            onComplete={toDash}
          />
        )}
        {screen === 'dashboard' && (
          <Dashboard network={network} compliance={compliance} />
        )}
        {screen === 'setup' && (
          <Setup
            mnemonic={mnemonic}
            compliance={compliance}
            onContractSaved={saveContractAddress}
            onComplete={toDash}
          />
        )}
        {screen === 'register' && (
          <Register compliance={compliance} onComplete={toDash} />
        )}
        {screen === 'update' && (
          <Update compliance={compliance} onComplete={toDash} />
        )}
        {screen === 'logs' && <Logs />}
      </Box>

      {/* Footer */}
      <Box justifyContent="center">
        <Text dimColor color="yellow">
          PoC only — stub TEE, no real enclave.  sk_device is in plaintext process memory.
        </Text>
      </Box>

    </Box>
  );
}
