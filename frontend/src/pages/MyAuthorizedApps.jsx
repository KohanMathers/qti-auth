import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle';

function MyAuthorizedApps({ user }) {
  const navigate = useNavigate();
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    fetchApps();
  }, []);

  const fetchApps = async () => {
    const token = localStorage.getItem('qti_token');

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/oauth/authorized-apps`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      const data = await res.json();

      if (res.ok) {
        setApps(data.apps);
      } else {
        setError(data.error || 'Failed to load authorized apps');
      }
    } catch (err) {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleRevoke = async (clientId, appName) => {
    if (!confirm(`Are you sure you want to revoke access for "${appName}"? You'll need to authorize it again to use it.`)) {
      return;
    }

    const token = localStorage.getItem('qti_token');

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/oauth/authorized-apps/${clientId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (res.ok) {
        setSuccess(`Access revoked for ${appName}`);
        fetchApps();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to revoke access');
      }
    } catch (err) {
      setError('Network error. Please try again.');
    }
  };

  const getScopeDescription = (scope) => {
    const descriptions = {
      openid: 'Verify your identity',
      profile: 'Access your profile information',
      email: 'Access your email address',
    };
    return descriptions[scope] || scope;
  };

  if (loading) {
    return (
      <div className="dashboard-container">
        <ThemeToggle />
        <div className="loading-screen">
          <div className="spinner"></div>
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="dashboard-container">
      <ThemeToggle />
      <header className="dashboard-header">
        <div className="header-content">
          <h1>Authorized Applications</h1>
          <div className="user-info">
            <span className="username">{user?.username_original || 'User'}</span>
            <button onClick={() => navigate('/dashboard')} className="btn-secondary">
              Back to Dashboard
            </button>
          </div>
        </div>
      </header>

      <div className="dashboard-content">
        <div className="dashboard-main full-width">
          {error && <div className="error-message">{error}</div>}
          {success && <div className="success-message">{success}</div>}

          <div className="info-box">
            <p>
              These are third-party applications you've authorized to access your QTI account.
              You can revoke access at any time.
            </p>
          </div>

          {apps.length === 0 ? (
            <div className="empty-state">
              <p>You haven't authorized any third-party applications yet.</p>
              <p className="help-text">
                When you sign in to other services using "Sign in with QTI", they'll appear here.
              </p>
            </div>
          ) : (
            <div className="apps-list">
              {apps.map((app) => (
                <div key={app.client_id} className="app-card">
                  <div className="app-header">
                    {app.logo_url && (
                      <img src={app.logo_url} alt={app.name} className="app-logo" />
                    )}
                    <div className="app-info">
                      <h3>{app.name}</h3>
                      {app.description && (
                        <p className="app-description">{app.description}</p>
                      )}
                    </div>
                  </div>

                  <div className="app-details">
                    <div className="detail-section">
                      <h4>Permissions granted:</h4>
                      <ul className="permissions-list">
                        {app.scope.map((scope) => (
                          <li key={scope}>{getScopeDescription(scope)}</li>
                        ))}
                      </ul>
                    </div>

                    <div className="detail-row">
                      <span className="label">Authorized on</span>
                      <span>{new Date(app.created_at * 1000).toLocaleDateString()}</span>
                    </div>

                    {app.homepage_url && (
                      <div className="detail-row">
                        <span className="label">Website</span>
                        <a href={app.homepage_url} target="_blank" rel="noopener noreferrer">
                          {app.homepage_url}
                        </a>
                      </div>
                    )}
                  </div>

                  <div className="app-actions">
                    <button
                      onClick={() => handleRevoke(app.client_id, app.name)}
                      className="btn-danger"
                    >
                      Revoke Access
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default MyAuthorizedApps;
