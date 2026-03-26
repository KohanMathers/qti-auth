import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import Signup from './pages/Signup';
import ClaimUsername from './pages/ClaimUsername';
import Dashboard from './pages/Dashboard';
import ModQueue from './pages/ModQueue';
import UserManagement from './pages/UserManagement';
import AuditLog from './pages/AuditLog';
import Stats from './pages/Stats';
import JagSMP from './pages/JagSMP';
import Privacy from './pages/Privacy';
import Terms from './pages/Terms';
import Verify from './pages/Verify';
import AgeVerify from './pages/AgeVerify';
import OAuthAuthorize from './pages/OAuthAuthorize';
import DeveloperPortal from './pages/DeveloperPortal';
import MyAuthorizedApps from './pages/MyAuthorizedApps';
import OAuthAdmin from './pages/OAuthAdmin';
import Settings from './pages/Settings';
import { BRANDING } from './config/branding';
import './App.css';

function App() {
  const [user, setUser] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  // Prevent the auth check from running twice under StrictMode.
  const authCheckAttempted = React.useRef(false);

  React.useEffect(() => {
    if (authCheckAttempted.current) return;
    authCheckAttempted.current = true;

    // Verification page handles its own token flow.
    if (window.location.pathname === '/verify') {
      setLoading(false);
      return;
    }

    const token = localStorage.getItem('qti_token');
    if (token) {
      fetch(`${import.meta.env.VITE_API_URL}/me`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      })
        .then(res => res.json())
        .then(data => {
          if (data.user) {
            setUser(data.user);
          } else {
            localStorage.removeItem('qti_token');
          }
        })
        .catch(() => {
          localStorage.removeItem('qti_token');
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    document.documentElement.style.setProperty('--auth-bg-light-url', `url('${BRANDING.authBackgroundLightUrl}')`);
    document.documentElement.style.setProperty('--auth-bg-dark-url', `url('${BRANDING.authBackgroundDarkUrl}')`);
  }, []);

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner"></div>
        <p>Loading {BRANDING.productName}...</p>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login setUser={setUser} />} />
        <Route path="/signup" element={<Signup setUser={setUser} />} />
        <Route path="/verify" element={<Verify setUser={setUser} />} />
        <Route path="/age-verify" element={<AgeVerify setUser={setUser} />} />
        <Route
          path="/claim-username"
          element={<ClaimUsername user={user} setUser={setUser} />}
        />
        <Route
          path="/dashboard"
          element={
            user ? <Dashboard user={user} setUser={setUser} /> : <Navigate to="/login" />
          }
        />
        <Route
          path="/mod/queue"
          element={
            user && user.role === 'admin' ? (
              <ModQueue user={user} />
            ) : (
              <Navigate to="/dashboard" />
            )
          }
        />
        <Route
          path="/admin/users"
          element={
            user && user.role === 'admin' ? (
              <UserManagement user={user} />
            ) : (
              <Navigate to="/dashboard" />
            )
          }
        />
        <Route
          path="/admin/audit-logs"
          element={
            user && user.role === 'admin' ? (
              <AuditLog user={user} />
            ) : (
              <Navigate to="/dashboard" />
            )
          }
        />
        <Route
          path="/admin/oauth"
          element={
            user && user.role === 'admin' ? (
              <OAuthAdmin user={user} />
            ) : (
              <Navigate to="/dashboard" />
            )
          }
        />
        <Route
          path="/settings"
          element={
            user ? (
              <Settings user={user} />
            ) : (
              <Navigate to="/login" />
            )
          }
        />
        <Route
          path="/stats"
          element={user ? <Stats user={user} /> : <Navigate to="/login" />}
        />
        <Route
          path="/stats/:gameSlug"
          element={user ? <Stats user={user} /> : <Navigate to="/login" />}
        />
        <Route
          path="/jagsmp"
          element={user ? <JagSMP user={user} /> : <Navigate to="/login" />}
        />
        <Route
          path="/oauth/authorize"
          element={user ? <OAuthAuthorize user={user} /> : <Navigate to="/login" />}
        />
        <Route
          path="/developer"
          element={user ? <DeveloperPortal user={user} /> : <Navigate to="/login" />}
        />
        <Route
          path="/authorized-apps"
          element={user ? <MyAuthorizedApps user={user} /> : <Navigate to="/login" />}
        />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/" element={<Navigate to={user ? "/dashboard" : "/login"} />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
