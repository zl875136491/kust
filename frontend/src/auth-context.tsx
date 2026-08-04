/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { AuthState, User } from './types';

interface AuthContextValue {
  user?: User;
  next?: AuthState['next'];
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, passwordConfirmation: string) => Promise<void>;
  completeAuth: (state: AuthState) => void;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function persistState(state: AuthState) {
  if (state.token) localStorage.setItem('kust-session-token', state.token);
  if (state.trustedDeviceToken) localStorage.setItem('kust-trusted-device', state.trustedDeviceToken);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<User>();
  const [next, setNext] = useState<AuthState['next']>();
  const [loading, setLoading] = useState(Boolean(localStorage.getItem('kust-session-token')));

  const completeAuth = useCallback((state: AuthState) => {
    persistState(state);
    setUser(state.user);
    setNext(state.next);
  }, []);

  const refresh = useCallback(async () => {
    if (!localStorage.getItem('kust-session-token')) { setLoading(false); return; }
    try { completeAuth(await api.me()); } catch {
      localStorage.removeItem('kust-session-token');
      localStorage.removeItem('kust-trusted-device');
      queryClient.clear();
      setUser(undefined);
      setNext(undefined);
    } finally { setLoading(false); }
  }, [completeAuth, queryClient]);

  useEffect(() => { void refresh(); }, [refresh]);

  const login = useCallback(async (username: string, password: string) => {
    completeAuth(await api.login(username, password));
  }, [completeAuth]);
  const register = useCallback(async (username: string, password: string, passwordConfirmation: string) => {
    completeAuth(await api.register(username, password, passwordConfirmation));
  }, [completeAuth]);
  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* Expired sessions are already logged out locally. */ }
    localStorage.removeItem('kust-session-token');
    localStorage.removeItem('kust-trusted-device');
    queryClient.clear();
    setUser(undefined);
    setNext(undefined);
  }, [queryClient]);

  const value = useMemo(() => ({ user, next, loading, login, register, completeAuth, logout, refresh }), [user, next, loading, login, register, completeAuth, logout, refresh]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
