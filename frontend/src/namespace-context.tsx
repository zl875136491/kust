/* eslint-disable react-refresh/only-export-components */
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

const STORAGE_KEY = 'kust-selected-namespaces';

interface NamespaceContextValue {
  getNamespace: (clusterId: string) => string;
  setNamespace: (clusterId: string, namespace: string) => void;
}

function loadSelections() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0),
    );
  } catch {
    return {};
  }
}

const NamespaceContext = createContext<NamespaceContextValue | null>(null);

export function NamespaceProvider({ children }: { children: ReactNode }) {
  const [selections, setSelections] = useState<Record<string, string>>(loadSelections);
  const getNamespace = useCallback((clusterId: string) => selections[clusterId] || 'all', [selections]);
  const setNamespace = useCallback((clusterId: string, namespace: string) => {
    if (!clusterId) return;
    setSelections((current) => {
      const next = { ...current, [clusterId]: namespace || 'all' };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  const value = useMemo(() => ({ getNamespace, setNamespace }), [getNamespace, setNamespace]);

  return <NamespaceContext.Provider value={value}>{children}</NamespaceContext.Provider>;
}

export function useNamespaceSelection() {
  const value = useContext(NamespaceContext);
  if (!value) throw new Error('useNamespaceSelection must be used inside NamespaceProvider');
  return value;
}
