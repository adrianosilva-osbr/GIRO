import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, getToken, setToken } from './api';
import type { Me } from './types';

interface AuthState {
  user: Me | null;
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  register(name: string, email: string, password: string): Promise<void>;
  logout(): void;
  /** After profile edits. */
  setUser(user: Me): void;
  /** After a password change, which revokes the old token. */
  replaceToken(token: string): void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(() => !!getToken());
  const queryClient = useQueryClient();

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    if (!getToken()) return;
    api<{ user: Me }>('/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => setToken(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    window.addEventListener('giro:unauthorized', logout);
    return () => window.removeEventListener('giro:unauthorized', logout);
  }, [logout]);

  const login = async (email: string, password: string) => {
    const r = await api<{ token: string; user: Me }>('/auth/login', { method: 'POST', body: { email, password } });
    setToken(r.token);
    setUser(r.user);
  };

  const register = async (name: string, email: string, password: string) => {
    const r = await api<{ token: string; user: Me }>('/auth/register', {
      method: 'POST',
      body: { name, email, password },
    });
    setToken(r.token);
    setUser(r.user);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, setUser, replaceToken: setToken }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

export function useMe(): Me {
  const { user } = useAuth();
  if (!user) throw new Error('useMe called while logged out');
  return user;
}
