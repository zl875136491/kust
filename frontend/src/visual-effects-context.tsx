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
}

const STORAGE_KEY = 'kust-visual-effects';
const defaultEffects: VisualEffects = {
  pointerHighlight: true,
  refraction: true,
  backdropBlur: true,
  hoverMotion: true,
};

const VisualEffectsContext = createContext<VisualEffectsContextValue | null>(null);

function readEffects() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Partial<VisualEffects>;
    return { ...defaultEffects, ...stored };
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(effects));
  }, [effects]);

  const setEffect = useCallback((effect: keyof VisualEffects, enabled: boolean) => {
    setEffects((current) => ({ ...current, [effect]: enabled }));
  }, []);

  const value = useMemo(() => ({ effects, setEffect }), [effects, setEffect]);
  return <VisualEffectsContext.Provider value={value}>{children}</VisualEffectsContext.Provider>;
}

export function useVisualEffects() {
  const value = useContext(VisualEffectsContext);
  if (!value) throw new Error('useVisualEffects must be used inside VisualEffectsProvider');
  return value;
}
