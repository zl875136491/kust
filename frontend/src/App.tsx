import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { LiquidGlassSystem } from './components/LiquidGlassSystem';
import { ToastProvider } from './components/ui';
import { DataProvider } from './data-context';
import { HomePage } from './pages/HomePage';
import { MapPage } from './pages/MapPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { OverviewPage } from './pages/OverviewPage';
import { ResourcePage } from './pages/ResourcePage';
import { SettingsPage } from './pages/SettingsPage';
import { SystemSettingsPage } from './pages/SystemSettingsPage';
import { WorkloadsPage } from './pages/WorkloadsPage';
import { WebFilePage } from './pages/WebFilePage';
import { WebShellPage } from './pages/WebShellPage';
import { ThemeProvider } from './theme-context';
import { VisualEffectsProvider } from './visual-effects-context';
import { AuthProvider } from './auth-context';
import { AdminGate, AuthGate, GuestGate } from './components/AuthGate';
import { ForgotPasswordPage, LoginPage, RegisterPage, ResetPasswordPage, TwoFactorPage } from './pages/AuthPages';
import { PreferencesProvider } from './preferences-context';
import { APP_BASE_PATH } from './runtime-config';
import { NamespaceProvider } from './namespace-context';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false },
  },
});

export default function App() {
  return (
    <ThemeProvider>
      <VisualEffectsProvider>
        <LiquidGlassSystem />
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <DataProvider>
              <PreferencesProvider>
                <ToastProvider>
                  <BrowserRouter basename={APP_BASE_PATH || undefined}>
                    <NamespaceProvider>
                      <Routes>
                        <Route element={<GuestGate />}>
                          <Route path="login" element={<LoginPage />} />
                          <Route path="register" element={<RegisterPage />} />
                          <Route path="forgot-password" element={<ForgotPasswordPage />} />
                          <Route path="reset-password" element={<ResetPasswordPage />} />
                        </Route>
                        <Route path="two-factor" element={<TwoFactorPage />} />
                        <Route element={<AuthGate />}>
                          <Route element={<AppLayout />}>
                            <Route index element={<HomePage />} />
                            <Route path="notifications" element={<NotificationsPage />} />
                            <Route path="settings" element={<SettingsPage />} />
                            <Route element={<AdminGate />}>
                              <Route path="system-settings" element={<SystemSettingsPage />} />
                            </Route>
                            <Route path="cluster/:clusterId" element={<OverviewPage />} />
                            <Route path="cluster/:clusterId/map" element={<MapPage />} />
                            <Route path="cluster/:clusterId/workloads" element={<WorkloadsPage />} />
                            <Route path="cluster/:clusterId/resources/:kind" element={<ResourcePage />} />
                            <Route path="cluster/:clusterId/pods/:namespace/:pod/shell" element={<WebShellPage />} />
                            <Route path="cluster/:clusterId/pods/:namespace/:pod/files" element={<WebFilePage />} />
                            <Route path="*" element={<NotFoundPage />} />
                          </Route>
                        </Route>
                      </Routes>
                    </NamespaceProvider>
                  </BrowserRouter>
                </ToastProvider>
              </PreferencesProvider>
            </DataProvider>
          </AuthProvider>
        </QueryClientProvider>
      </VisualEffectsProvider>
    </ThemeProvider>
  );
}
