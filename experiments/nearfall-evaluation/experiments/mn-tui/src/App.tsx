import React, {useState, useEffect} from 'react';
import {Box, Text, useApp, useStdout, useInput} from 'ink';
import NavMenu   from './components/NavMenu.js';
import Dashboard from './screens/Dashboard.js';
import Network   from './screens/Network.js';
import Send      from './screens/Send.js';
import Mint      from './screens/Mint.js';
import Contract  from './screens/Contract.js';
import Deploy    from './screens/Deploy.js';
import Keys      from './screens/Keys.js';
import Designate from './screens/Designate.js';
import Logs      from './screens/Logs.js';
import type {Screen, NetworkConfig} from './types.js';
import {loadConfig, saveConfig, buildNetworkConfig, configFileExists} from './config.js';
import {useWallet}                  from './hooks/useWallet.js';
import {useWalletSync}              from './hooks/useWalletSync.js';
import {logger}                    from './logger.js';
import pkg                         from '../package.json';

export default function App() {
  const {exit}   = useApp();
  const {stdout} = useStdout();

  const [screen,            setScreen]           = useState<Screen>(() => configFileExists() ? 'dashboard' : 'network');
  const [network,           setNetworkConfig]     = useState<NetworkConfig>(() => {
    const cfg = loadConfig();
    return buildNetworkConfig(cfg.lastNetwork, cfg.networkOverrides);
  });
  const [paused,            setPaused]           = useState(false);
  const [lineCount,         setLineCount]        = useState(() => logger.lineCount);
  const [lastSeenLineCount, setLastSeenLineCount] = useState(() => logger.lineCount);
  const [menuActive,        setMenuActive]       = useState(false);
  const [workInProgress,    setWorkInProgress]   = useState(false);

  const {activeIndex, getMnemonic, setNetwork} = useWallet();
  const mnemonic   = getMnemonic(activeIndex);
  const walletSync = useWalletSync(mnemonic, network, paused);

  // Poll for new log lines every 5 s; only updates state when count actually changes.
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
    if (input === 'p') { setPaused(p => !p); return; }
    if (input === 'm' && !workInProgress) { setMenuActive(a => !a); return; }
  });

  const navigate = (s: Screen) => {
    setWorkInProgress(false);
    if (s === 'logs') setLastSeenLineCount(logger.lineCount);
    setScreen(s);
  };
  const toDash     = () => navigate('dashboard');
  const applyNetwork = (cfg: NetworkConfig) => {
    setNetworkConfig(cfg);
    setNetwork(cfg.name);
    const stored = loadConfig();
    saveConfig({
      ...stored,
      lastNetwork:      cfg.name,
      networkOverrides: {
        ...stored.networkOverrides,
        [cfg.name]: {nodeUrl: cfg.nodeUrl, indexerUrl: cfg.indexerUrl, proofServerUrl: cfg.proofServerUrl},
      },
    });
  };

  return (
    <Box flexDirection="column" height={stdout.rows}>

      {/* Title bar */}
      <Box borderStyle="single" paddingX={1} justifyContent="space-between">
        <Box gap={2}>
          <Text bold color="cyan">Midnight TUI</Text>
          <Text dimColor>v{pkg.version}</Text>
          <Text dimColor>|</Text>
          <Text color="yellow">{network.name}</Text>
        </Box>
        <Box gap={2}>
          {paused && <Text color="yellow">PAUSED</Text>}
          <Text dimColor>M-m — menu  M-p — {paused ? 'resume' : 'pause'}  M-q — exit</Text>
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
        {screen === 'network'   && (
          <Network
            current={network}
            onSave={applyNetwork}
            onComplete={toDash}
          />
        )}
        {screen === 'dashboard' && <Dashboard network={network} paused={paused} walletSync={walletSync} />}
        {screen === 'send'      && <Send      onComplete={toDash} walletSync={walletSync} onWorkInProgress={setWorkInProgress} />}
        {screen === 'mint'      && <Mint      onComplete={toDash} walletSync={walletSync} onWorkInProgress={setWorkInProgress} />}
        {screen === 'contract'  && <Contract  network={network} />}
        {screen === 'deploy'    && <Deploy    onComplete={toDash} walletSync={walletSync} onWorkInProgress={setWorkInProgress} />}
        {screen === 'keys'      && <Keys network={network} />}
        {screen === 'designate' && <Designate onComplete={toDash} walletSync={walletSync} onWorkInProgress={setWorkInProgress} />}
        {screen === 'logs'      && <Logs />}
      </Box>

      {/* Footer */}
      <Box justifyContent="center">
        <Text color="yellow" bold>⚠️  Only minimal quality assurance has been performed on this app.  ⚠️</Text>
      </Box>

      {/* Source URL */}
      <Box justifyContent="center">
        <Text dimColor>https://github.com/input-output-hk/arc-nearfall-evaluation/tree/main/experiments/mn-tui/</Text>
      </Box>

    </Box>
  );
}
