import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import Signup from './pages/Signup';
import ClaimUsername from './pages/ClaimUsername';
import Dashboard from './pages/Dashboard';
import ModQueue from './pages/ModQueue';
import Stats from './pages/Stats';
import JagSMP from './pages/JagSMP';
import Privacy from './pages/Privacy';
import Terms from './pages/Terms';
import Verify from './pages/Verify';
import AgeVerify from './pages/AgeVerify';
import './App.css';

function App() {
  const [user, setUser] = React.useState(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    // Check if user is logged in
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

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner"></div>
        <p>Loading QTI Auth...</p>
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
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/" element={<Navigate to={user ? "/dashboard" : "/login"} />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
