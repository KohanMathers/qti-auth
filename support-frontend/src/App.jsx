import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import ThemeToggle from './components/ThemeToggle';
import Header from './components/Header';
import Footer from './components/Footer';
import Home from './pages/Home';
import KnowledgeBase from './pages/KnowledgeBase';
import ArticleView from './pages/ArticleView';
import CategoryView from './pages/CategoryView';
import SubmitTicket from './pages/SubmitTicket';
import MyTickets from './pages/MyTickets';
import TicketView from './pages/TicketView';
import OAuthCallback from './pages/OAuthCallback';
import AdminDashboard from './pages/admin/AdminDashboard';
import TicketQueue from './pages/admin/TicketQueue';
import TicketDetail from './pages/admin/TicketDetail';
import ArticleEditor from './pages/admin/ArticleEditor';
import ArticleList from './pages/admin/ArticleList';
import { apiGet } from './lib/api';
import { startLogin, logout as authLogout, isLoggedIn } from './lib/auth';

function PageShell({ children, user, onLogout }) {
  return (
    <div className="app-shell">
      <Header user={user} onLogout={onLogout} />
      <main className="page-content">
        {children}
      </main>
      <Footer />
      <ThemeToggle />
    </div>
  );
}

function RequireAuth({ user, loading, children }) {
  if (loading) {
    return (
      <section className="page-card">
        <p className="muted">Checking your session...</p>
      </section>
    );
  }

  if (!user) {
    return (
      <section className="page-card auth-gate">
        <h1>Sign in required</h1>
        <p>Log in with your QTI account to submit and manage support tickets.</p>
        <button className="pill primary" onClick={() => startLogin()}>Sign in with QTI</button>
      </section>
    );
  }

  return children;
}

function RequireStaff({ user, loading, children }) {
  if (loading) {
    return (
      <section className="page-card">
        <p className="muted">Checking your session...</p>
      </section>
    );
  }

  if (!user) {
    return <Navigate to="/" />;
  }

  if (user.role !== 'admin' && user.role !== 'support') {
    return <Navigate to="/" />;
  }

  return children;
}

function App() {
  const [user, setUser] = React.useState(null);
  const [authLoading, setAuthLoading] = React.useState(true);

  const checkAuth = React.useCallback(async () => {
    // Only check if we have a token
    if (!isLoggedIn()) {
      setUser(null);
      setAuthLoading(false);
      return;
    }

    try {
      const data = await apiGet('/me');
      setUser(data.user || null);
    } catch (error) {
      setUser(null);
      // If unauthorized, clear tokens
      if (error.status === 401) {
        authLogout();
      }
    } finally {
      setAuthLoading(false);
    }
  }, []);

  React.useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const handleLogout = () => {
    authLogout();
    setUser(null);
  };

  const handleLoginSuccess = () => {
    // Re-check auth after OAuth callback
    setAuthLoading(true);
    checkAuth();
  };

  return (
    <BrowserRouter>
      <Routes>
        <Route
          path="/"
          element={(
            <PageShell user={user} onLogout={handleLogout}>
              <Home />
            </PageShell>
          )}
        />
        <Route
          path="/kb"
          element={(
            <PageShell user={user} onLogout={handleLogout}>
              <KnowledgeBase />
            </PageShell>
          )}
        />
        <Route
          path="/kb/:slug"
          element={(
            <PageShell user={user} onLogout={handleLogout}>
              <ArticleView />
            </PageShell>
          )}
        />
        <Route
          path="/kb/category/:slug"
          element={(
            <PageShell user={user} onLogout={handleLogout}>
              <CategoryView />
            </PageShell>
          )}
        />
        <Route
          path="/tickets/new"
          element={(
            <PageShell user={user} onLogout={handleLogout}>
              <RequireAuth user={user} loading={authLoading}>
                <SubmitTicket user={user} />
              </RequireAuth>
            </PageShell>
          )}
        />
        <Route
          path="/tickets"
          element={(
            <PageShell user={user} onLogout={handleLogout}>
              <RequireAuth user={user} loading={authLoading}>
                <MyTickets user={user} />
              </RequireAuth>
            </PageShell>
          )}
        />
        <Route
          path="/tickets/:id"
          element={(
            <PageShell user={user} onLogout={handleLogout}>
              <RequireAuth user={user} loading={authLoading}>
                <TicketView user={user} />
              </RequireAuth>
            </PageShell>
          )}
        />
        <Route
          path="/admin"
          element={(
            <PageShell user={user} onLogout={handleLogout}>
              <RequireStaff user={user} loading={authLoading}>
                <AdminDashboard user={user} />
              </RequireStaff>
            </PageShell>
          )}
        />
        <Route
          path="/admin/tickets"
          element={(
            <PageShell user={user} onLogout={handleLogout}>
              <RequireStaff user={user} loading={authLoading}>
                <TicketQueue user={user} />
              </RequireStaff>
            </PageShell>
          )}
        />
        <Route
          path="/admin/tickets/:id"
          element={(
            <PageShell user={user} onLogout={handleLogout}>
              <RequireStaff user={user} loading={authLoading}>
                <TicketDetail user={user} />
              </RequireStaff>
            </PageShell>
          )}
        />
        <Route
          path="/admin/articles"
          element={(
            <PageShell user={user} onLogout={handleLogout}>
              <RequireStaff user={user} loading={authLoading}>
                <ArticleList user={user} />
              </RequireStaff>
            </PageShell>
          )}
        />
        <Route
          path="/admin/articles/new"
          element={(
            <PageShell user={user} onLogout={handleLogout}>
              <RequireStaff user={user} loading={authLoading}>
                <ArticleEditor user={user} />
              </RequireStaff>
            </PageShell>
          )}
        />
        <Route
          path="/admin/articles/:id/edit"
          element={(
            <PageShell user={user} onLogout={handleLogout}>
              <RequireStaff user={user} loading={authLoading}>
                <ArticleEditor user={user} />
              </RequireStaff>
            </PageShell>
          )}
        />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
