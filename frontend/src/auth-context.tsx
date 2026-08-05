/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { AuthState, User } from './types';
import { MOCK_MODE } from './runtime-config';

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
const mockUser: User = {
  id: 'mock-admin', username: 'demo', displayName: '演示管理员', realName: '演示管理员', email: 'demo@kust.local',
  source: 'local', roles: ['admin'], disabled: false, passwordUnset: false, twoFactorEnabled: true, twoFactorRequired: true, twoFactorRememberDays: 7,
};
const mockAuth: AuthState = { user: mockUser, next: 'authenticated', token: 'kust-mock-token' };

function persistState(state: AuthState) {
  if (state.token) localStorage.setItem('kust-session-token', state.token);
  if (state.trustedDeviceToken) localStorage.setItem('kust-trusted-device', state.trustedDeviceToken);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<User | undefined>(MOCK_MODE ? mockUser : undefined);
  const [next, setNext] = useState<AuthState['next'] | undefined>(MOCK_MODE ? 'authenticated' : undefined);
  const [loading, setLoading] = useState(!MOCK_MODE && Boolean(localStorage.getItem('kust-session-token')));

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

  useEffect(() => {
    if (MOCK_MODE) completeAuth(mockAuth);
  }, [completeAuth]);

  const login = useCallback(async (username: string, password: string) => {
    if (MOCK_MODE) { completeAuth(mockAuth); return; }
    completeAuth(await api.login(username, password));
  }, [completeAuth]);
  const register = useCallback(async (username: string, password: string, passwordConfirmation: string) => {
    if (MOCK_MODE) { completeAuth(mockAuth); return; }
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
