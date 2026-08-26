import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { initTheme } from './theme';
import './styles.css';

/* index.html inlines the same attribute write ahead of first paint; this call
   simply keeps the module's view of the preference in step. */
initTheme();

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
