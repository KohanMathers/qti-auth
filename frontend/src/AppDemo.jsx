import React from 'react';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import Login from './pages/Login';
import Signup from './pages/Signup';
import ClaimUsername from './pages/ClaimUsername';
import Dashboard from './pages/Dashboard';
import ModQueue from './pages/ModQueue';
import Privacy from './pages/Privacy';
import Terms from './pages/Terms';
import './App.css';

// Mock user for demo
const mockUser = {
  id: 'demo-user-123',
  username_original: 'DemoUser',
  email: 'demo@example.com',
  role: 'user',
  is_child: false,
  created_at: Math.floor(Date.now() / 1000) - 86400 * 30, // 30 days ago
};

const mockAdminUser = {
  id: 'demo-admin-123',
  username_original: 'QTI_Admin',
  email: 'admin@example.com',
  role: 'admin',
  is_child: false,
  created_at: Math.floor(Date.now() / 1000) - 86400 * 90,
};

function DemoNav() {
  return (
    <div style={{
      background: '#BC6DE0',
      padding: '1rem',
      color: 'white',
      textAlign: 'center',
      position: 'sticky',
      top: 0,
      zIndex: 1000,
    }}>
      <div style={{ maxWidth: '1200px', margin: '0 auto' }}>
        <strong>🎨 DEMO MODE - Frontend Preview</strong>
        <div style={{ marginTop: '0.5rem', display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
          <Link to="/login" style={{ color: 'white' }}>Login</Link>
          <Link to="/signup" style={{ color: 'white' }}>Signup</Link>
          <Link to="/claim-username" style={{ color: 'white' }}>Claim Username</Link>
          <Link to="/dashboard" style={{ color: 'white' }}>Dashboard (User)</Link>
          <Link to="/dashboard-admin" style={{ color: 'white' }}>Dashboard (Admin)</Link>
          <Link to="/mod-queue" style={{ color: 'white' }}>Moderation Queue</Link>
        </div>
      </div>
    </div>
  );
}

function AppDemo() {
  const [user, setUser] = React.useState(null);

  return (
    <BrowserRouter>
      <DemoNav />
      <Routes>
        <Route path="/login" element={<Login setUser={setUser} />} />
        <Route path="/signup" element={<Signup setUser={setUser} />} />

        <Route
          path="/claim-username"
          element={<ClaimUsername user={mockUser} setUser={setUser} />}
        />

        <Route
          path="/dashboard"
          element={<Dashboard user={mockUser} setUser={setUser} />}
        />

        <Route
          path="/dashboard-admin"
          element={<Dashboard user={mockAdminUser} setUser={setUser} />}
        />

        <Route
          path="/mod-queue"
          element={<ModQueue user={mockAdminUser} />}
        />

        <Route path="/privacy" element={<Privacy />} />
        <Route path="/terms" element={<Terms />} />

        <Route path="/" element={<Login setUser={setUser} />} />
      </Routes>
    </BrowserRouter>
  );
}

export default AppDemo;
