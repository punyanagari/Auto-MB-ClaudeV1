// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyThemePreference,
  initTheme,
  setThemePreference,
  storedThemePreference,
} from '../src/lib/theme.js';
import { AppearanceSettings } from '../src/views/AppearanceSettings.js';

const KEY = 'auto-mb.theme';

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset['theme'];
});

afterEach(() => {
  cleanup();
});

describe('theme preference', () => {
  it('defaults to system when nothing is stored', () => {
    expect(storedThemePreference()).toBe('system');
  });

  it('treats an unknown stored value as system', () => {
    localStorage.setItem(KEY, 'sepia');
    expect(storedThemePreference()).toBe('system');
  });

  it('persists an explicit choice and applies the root attribute', () => {
    setThemePreference('dark');
    expect(localStorage.getItem(KEY)).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(storedThemePreference()).toBe('dark');
  });

  it('system removes both the stored value and the attribute', () => {
    setThemePreference('light');
    setThemePreference('system');
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(document.documentElement.dataset['theme']).toBeUndefined();
  });

  it('initTheme applies a stored choice before render', () => {
    localStorage.setItem(KEY, 'dark');
    initTheme();
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('applyThemePreference alone does not persist', () => {
    applyThemePreference('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe('AppearanceSettings', () => {
  it('offers the three states with System selected by default', () => {
    render(<AppearanceSettings />);
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeTruthy();
    const system = screen.getByRole('radio', { name: 'System' });
    expect((system as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('radio', { name: 'Light' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeTruthy();
  });

  it('choosing Dark persists and applies immediately', () => {
    render(<AppearanceSettings />);
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(localStorage.getItem(KEY)).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('returning to System clears the choice', () => {
    localStorage.setItem(KEY, 'dark');
    document.documentElement.dataset['theme'] = 'dark';
    render(<AppearanceSettings />);
    const dark = screen.getByRole('radio', { name: 'Dark' });
    expect((dark as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'System' }));
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(document.documentElement.dataset['theme']).toBeUndefined();
  });
});
