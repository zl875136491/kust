import { LoaderCircle } from 'lucide-react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth-context';

export function AuthGate() {
  const { user, next, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="auth-loading"><LoaderCircle className="spin" size={24} /><span>正在恢复会话</span></div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  if (next === 'enroll') return <Navigate to="/two-factor?mode=enroll" replace />;
  if (next === 'two_factor') return <Navigate to="/two-factor" replace />;
  return <Outlet />;
}

export function GuestGate() {
  const { user, next, loading } = useAuth();
  if (loading) return <div className="auth-loading"><LoaderCircle className="spin" size={24} /></div>;
  if (user && next === 'authenticated') return <Navigate to="/" replace />;
  if (user && next !== 'authenticated') return <Navigate to={`/two-factor${next === 'enroll' ? '?mode=enroll' : ''}`} replace />;
  return <Outlet />;
}
