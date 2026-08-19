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

/* The offline shell (`src/service-worker.ts`, `docs/UX.md` § 23).
 *
 * Registered only from a built bundle. The dev server hands out modules
 * under names the worker's asset rules do not describe, and a worker
 * holding a dev cache is a debugging trap rather than a feature.
 *
 * Registration is deliberately after `load`: the worker's install
 * fetches the whole shell, and starting that while the first screen is
 * still painting competes with the very requests it is caching. A
 * failure costs the offline shell and nothing else, so it is caught and
 * the application carries on. */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

const root = document.getElementById('root');
if (!root) throw new Error('root element not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
