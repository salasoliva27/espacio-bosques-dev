import { useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { supabase } from './lib/auth';
import { LanguageProvider } from './context/LanguageContext';
import SimulationBanner from './components/SimulationBanner';
import AuthScreen from './components/AuthScreen';
import Navbar from './components/Navbar';
import Landing from './pages/Landing';
import Dashboard from './pages/Dashboard';
import ProjectDetail from './pages/ProjectDetail';
import CreateProject from './pages/CreateProject';
import Reports from './pages/Reports';
import Profile from './pages/Profile';
import Providers from './pages/Providers';
import ProposalSubmit from './pages/ProposalSubmit';
import Feed from './pages/Feed';
import Register from './pages/Register';
import CompleteProfile from './pages/CompleteProfile';
import LegalQueue from './pages/LegalQueue';

const queryClient = new QueryClient();
const SIM = import.meta.env.VITE_SIMULATION_MODE === 'true';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

/** Fire-and-forget: sync user_metadata → eb_profiles after login. */
async function initUserProfile(accessToken: string) {
  try {
    await fetch(`${API_URL}/api/user/profile/init`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    // Non-fatal — profile will be retried on next login
  }
}

function AppInner() {
  const [session, setSession] = useState<any>(undefined);
  const location = useLocation();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session ?? null));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s ?? null);
      // Sync profile to eb_profiles on every sign-in
      if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && s?.access_token) {
        initUserProfile(s.access_token);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  // Loading spinner
  if (session === undefined) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#080c10' }}>
        <div className="w-6 h-6 rounded-full border-2 animate-spin"
          style={{ borderColor: 'rgba(0,229,196,0.3)', borderTopColor: '#00e5c4' }} />
      </div>
    );
  }

  // Public routes — accessible without a session
  if (location.pathname === '/register') {
    return session ? <Navigate to="/dashboard" replace /> : <Register />;
  }
  if (location.pathname === '/auth') {
    return session ? <Navigate to="/dashboard" replace /> : <AuthScreen />;
  }

  // No session → force to sign-in
  if (!session) return <Navigate to="/auth" replace />;

  // Session exists but RFC not collected yet → complete profile
  const hasRfc = Boolean(session.user?.user_metadata?.rfc);
  if (!hasRfc && location.pathname !== '/register/complete') {
    return <Navigate to="/register/complete" replace />;
  }
  if (location.pathname === '/register/complete') {
    return hasRfc
      ? <Navigate to="/dashboard" replace />
      : <CompleteProfile user={session.user} />;
  }

  // Fully authenticated
  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen" style={{ background: '#080c10' }}>
        <Navbar />
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/projects/:id" element={<ProjectDetail />} />
          <Route path="/create" element={<CreateProject />} />
          <Route path="/reports/:projectId" element={<Reports />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/providers" element={<Providers />} />
          <Route path="/projects/:projectId/milestones/:milestoneId/propose" element={<ProposalSubmit />} />
          <Route path="/feed" element={<Feed />} />
          <Route path="/legal-queue" element={<LegalQueue />} />
          <Route path="/auth/callback" element={<Navigate to="/dashboard" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </QueryClientProvider>
  );
}

export default function App() {
  return (
    <LanguageProvider>
      <Router>
        <SimulationBanner />
        <div style={{ paddingTop: SIM ? '28px' : '0' }}>
          <AppInner />
        </div>
      </Router>
    </LanguageProvider>
  );
}
