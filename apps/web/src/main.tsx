import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/ibm-plex-sans';
// Devanagari joins the same family so bilingual station names —
// Mumbai CST / मुंबई सीएसटी — set in one voice, as IR signage requires.
import '@fontsource/ibm-plex-sans-devanagari/400.css';
import '@fontsource/ibm-plex-sans-devanagari/500.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import { App } from './App.js';
import { initTheme } from './lib/theme.js';
import './globals.css';

// Apply any stored explicit theme choice before the first render so the
// workspace does not flash the system theme first.
initTheme();

const root = document.getElementById('root');
if (!root) throw new Error('root element not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
