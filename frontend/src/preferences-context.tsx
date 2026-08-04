/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { useAuth } from './auth-context';
import { useThemeMode } from './theme-context';
import type { UserSettings } from './types';
import { useVisualEffects } from './visual-effects-context';

interface PreferencesContextValue {
  settings?: UserSettings;
  loading: boolean;
  save: (settings: UserSettings) => Promise<UserSettings>;
  reload: () => Promise<void>;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({ children }: { children: React.ReactNode }) {
  const { user, next } = useAuth();
  const { hydrateMode } = useThemeMode();
  const { hydrateEffects } = useVisualEffects();
  const [settings, setSettings] = useState<UserSettings>();
  const [loading, setLoading] = useState(false);

  const apply = useCallback((value: UserSettings) => {
    hydrateMode(value.theme);
    hydrateEffects({ pointerHighlight: value.pointerHighlight, refraction: value.refraction, backdropBlur: value.backdropBlur, hoverMotion: value.hoverMotion });
    localStorage.setItem('kust-auto-refresh', String(value.autoRefresh));
    localStorage.setItem('kust-page-size', String(value.pageSize));
    setSettings(value);
  }, [hydrateEffects, hydrateMode]);

  const reload = useCallback(async () => {
    if (!user || next !== 'authenticated') return;
    setLoading(true);
    try { apply(await api.settings()); } finally { setLoading(false); }
  }, [apply, next, user]);

  useEffect(() => { if (user && next === 'authenticated') void reload(); else setSettings(undefined); }, [next, reload, user]);

  const save = useCallback(async (value: UserSettings) => {
    const saved = await api.updateSettings(value);
    apply(saved);
    return saved;
  }, [apply]);
  const context = useMemo(() => ({ settings, loading, save, reload }), [settings, loading, save, reload]);
  return <PreferencesContext.Provider value={context}>{children}</PreferencesContext.Provider>;
}

export function usePreferences() {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error('usePreferences must be used inside PreferencesProvider');
  return value;
}
