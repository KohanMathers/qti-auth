import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle';

function AdminSettings({ user }) {
  const navigate = useNavigate();
  const [notifyNewTickets, setNotifyNewTickets] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    const token = localStorage.getItem('qti_token');
    fetch(`${import.meta.env.VITE_API_URL}/admin/settings/notifications`, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
      .then(res => res.json())
      .then(data => {
        setNotifyNewTickets(data.notify_new_tickets !== false);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    const token = localStorage.getItem('qti_token');
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/admin/settings/notifications`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ notify_new_tickets: notifyNewTickets }),
      });
      if (res.ok) {
        setMessage({ type: 'success', text: 'Settings saved.' });
      } else {
        const data = await res.json();
        setMessage({ type: 'error', text: data.error || 'Failed to save settings.' });
      }
    } catch {
      setMessage({ type: 'error', text: 'Network error. Please try again.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dashboard-container">
      <ThemeToggle />
      <header className="dashboard-header">
        <div className="header-content">
          <h1>QTI Auth</h1>
          <div className="user-info">
            <span className="username">{user?.username_original || user?.username || 'Admin'}</span>
            <span className="badge admin-badge">Admin</span>
            <button onClick={() => navigate('/dashboard')} className="btn-secondary">
              Back to Dashboard
            </button>
          </div>
        </div>
      </header>

      <div className="dashboard-content">
        <div className="dashboard-main" style={{ maxWidth: 600 }}>
          <h2>Admin Settings</h2>
          <p className="help-text">These settings apply only to your admin account.</p>

          {loading ? (
            <p>Loading...</p>
          ) : (
            <div className="section">
              <h3>Notification Preferences</h3>

              <div className="info-row" style={{ alignItems: 'center', gap: 16 }}>
                <span className="label">Email me when a new support ticket is created</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={notifyNewTickets}
                    onChange={e => setNotifyNewTickets(e.target.checked)}
                    style={{ width: 18, height: 18, cursor: 'pointer' }}
                  />
                  <span>{notifyNewTickets ? 'On' : 'Off'}</span>
                </label>
              </div>
              <p className="help-text" style={{ marginTop: 8 }}>
                When enabled, you will receive an email at <strong>{user?.email}</strong> each time a user submits a new support ticket.
              </p>

              {message && (
                <div className={message.type === 'success' ? 'info-box' : 'info-box warning'} style={{ marginTop: 16 }}>
                  {message.text}
                </div>
              )}

              <button
                className="btn-primary"
                onClick={handleSave}
                disabled={saving}
                style={{ marginTop: 16 }}
              >
                {saving ? 'Saving...' : 'Save Settings'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default AdminSettings;
