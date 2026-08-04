/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ThemeMode } from './types';

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
  hydrateMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const value = localStorage.getItem('kust-theme');
    return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
  });
  const [systemDark, setSystemDark] = useState(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemDark(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const resolved = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    themeColor?.setAttribute('content', resolved === 'dark' ? '#050606' : '#edf0ee');
  }, [resolved]);

  const setMode = (nextMode: ThemeMode) => {
    localStorage.setItem('kust-theme', nextMode);
    setModeState(nextMode);
  };

  const hydrateMode = useCallback((nextMode: ThemeMode) => {
    localStorage.setItem('kust-theme', nextMode);
    setModeState(nextMode);
  }, []);
  const value = useMemo(() => ({ mode, resolved, setMode, hydrateMode }), [hydrateMode, mode, resolved]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useThemeMode() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useThemeMode must be used inside ThemeProvider');
  return value;
}
