/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export interface VisualEffects {
  pointerHighlight: boolean;
  refraction: boolean;
  backdropBlur: boolean;
  hoverMotion: boolean;
}

interface VisualEffectsContextValue {
  effects: VisualEffects;
  setEffect: (effect: keyof VisualEffects, enabled: boolean) => void;
  hydrateEffects: (effects: VisualEffects) => void;
}

const STORAGE_KEY = 'kust-visual-effects';
const STORAGE_VERSION = 2;
const defaultEffects: VisualEffects = {
  pointerHighlight: false,
  refraction: false,
  backdropBlur: true,
  hoverMotion: true,
};

const VisualEffectsContext = createContext<VisualEffectsContextValue | null>(null);

function readEffects() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Partial<VisualEffects> & { version?: number };
    if (stored.version !== STORAGE_VERSION) return defaultEffects;
    return {
      pointerHighlight: stored.pointerHighlight ?? defaultEffects.pointerHighlight,
      refraction: stored.refraction ?? defaultEffects.refraction,
      backdropBlur: stored.backdropBlur ?? defaultEffects.backdropBlur,
      hoverMotion: stored.hoverMotion ?? defaultEffects.hoverMotion,
    };
  } catch {
    return defaultEffects;
  }
}

export function VisualEffectsProvider({ children }: { children: React.ReactNode }) {
  const [effects, setEffects] = useState<VisualEffects>(readEffects);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.glassHighlight = effects.pointerHighlight ? 'on' : 'off';
    root.dataset.glassRefraction = effects.refraction ? 'on' : 'off';
    root.dataset.glassBlur = effects.backdropBlur ? 'on' : 'off';
    root.dataset.glassMotion = effects.hoverMotion ? 'on' : 'off';
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, ...effects }));
  }, [effects]);

  const setEffect = useCallback((effect: keyof VisualEffects, enabled: boolean) => {
    setEffects((current) => ({ ...current, [effect]: enabled }));
  }, []);
  const hydrateEffects = useCallback((next: VisualEffects) => setEffects(next), []);

  const value = useMemo(() => ({ effects, setEffect, hydrateEffects }), [effects, hydrateEffects, setEffect]);
  return <VisualEffectsContext.Provider value={value}>{children}</VisualEffectsContext.Provider>;
}

export function useVisualEffects() {
  const value = useContext(VisualEffectsContext);
  if (!value) throw new Error('useVisualEffects must be used inside VisualEffectsProvider');
  return value;
}
