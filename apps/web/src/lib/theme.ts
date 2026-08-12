/** Three-state theming for the workspace.
 *
 * The default follows the operating system: globals.css declares
 * `color-scheme: light dark` and every token is a light-dark() pair. An
 * explicit choice is personal, not tenant data — it lives in localStorage
 * and is applied as `data-theme` on <html>, which pins color-scheme and
 * therefore wins over the media query. Applying happens at module import
 * time in main.tsx, before the first render, so a stored choice does not
 * flash the system theme first. The production CSP forbids inline scripts
 * (deploy/Caddyfile: script-src 'self'), so this runs from the bundle
 * rather than an inline <head> script.
 */
export type ThemePreference = 'system' | 'light' | 'dark';

const THEME_STORAGE_KEY = 'auto-mb.theme';

export function storedThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyThemePreference(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === 'system') {
    delete root.dataset['theme'];
  } else {
    root.dataset['theme'] = preference;
  }
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') {
      localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      localStorage.setItem(THEME_STORAGE_KEY, preference);
    }
  } catch {
    // Storage may be unavailable (private mode, quota). The choice still
    // applies for this page view; it simply will not survive a reload.
  }
  applyThemePreference(preference);
}

export function initTheme(): void {
  applyThemePreference(storedThemePreference());
}
