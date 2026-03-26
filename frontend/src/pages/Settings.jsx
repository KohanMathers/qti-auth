import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle';

function Settings({ user }) {
  const navigate = useNavigate();
  const isOAuth = !user?.email;
  const isAdmin = user?.role === 'admin';

  const [notifyTicketUpdates, setNotifyTicketUpdates] = useState(true);
  const [notifyNewTickets, setNotifyNewTickets] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    const token = localStorage.getItem('qti_token');
    fetch(`${import.meta.env.VITE_API_URL}/settings/notifications`, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
      .then(res => res.json())
      .then(data => {
        setNotifyTicketUpdates(data.notify_ticket_updates !== false);
        if (isAdmin) setNotifyNewTickets(data.notify_new_tickets !== false);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isAdmin]);

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);
    const token = localStorage.getItem('qti_token');
    const body = { notify_ticket_updates: notifyTicketUpdates };
    if (isAdmin) body.notify_new_tickets = notifyNewTickets;

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/settings/notifications`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setMessage({ type: 'success', text: 'Your settings have been saved.' });
      } else {
        const data = await res.json();
        setMessage({ type: 'error', text: data.error || 'Failed to save settings.' });
      }
    } catch {
      setMessage({ type: 'error', text: 'A network error occurred. Please try again.' });
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
            <span className="username">{user?.username_original || user?.username || 'User'}</span>
            {isAdmin && <span className="badge admin-badge">Admin</span>}
            <button onClick={() => navigate('/dashboard')} className="btn-secondary">
              Back to Dashboard
            </button>
          </div>
        </div>
      </header>

      <div className="dashboard-content">
        <div className="dashboard-main" style={{ maxWidth: 640 }}>
          <h2>Settings</h2>

          {loading ? (
            <p>Loading...</p>
          ) : (
            <>
              <div className="section">
                <h3>Email Notifications</h3>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 20, marginTop: 8 }}>

                  {/* Ticket updates — all users */}
                  <div style={{ opacity: isOAuth ? 0.5 : 1 }}>
                    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 12, cursor: isOAuth ? 'not-allowed' : 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={notifyTicketUpdates}
                        onChange={e => !isOAuth && setNotifyTicketUpdates(e.target.checked)}
                        disabled={isOAuth}
                        style={{ marginTop: 3, width: 16, height: 16, flexShrink: 0, cursor: isOAuth ? 'not-allowed' : 'pointer' }}
                      />
                      <div>
                        <span style={{ fontWeight: 500 }}>Email me when my support ticket is updated</span>
                        <p className="help-text" style={{ marginTop: 4 }}>
                          Receive an email notification when a staff member replies to your ticket or its status changes.
                        </p>
                      </div>
                    </label>
                    {isOAuth && (
                      <div className="info-box" style={{ marginTop: 10, fontSize: 13 }}>
                        <strong>Note:</strong> Email notifications are unavailable for accounts signed in via OAuth, as no verified email address is associated with your account. To enable this feature, please{' '}
                        <a href={`${import.meta.env.VITE_SUPPORT_URL || '#'}`} style={{ color: 'inherit', textDecoration: 'underline' }}>
                          open a support ticket
                        </a>{' '}
                        requesting an email address to be added.
                      </div>
                    )}
                  </div>

                  {/* New ticket alerts — admins only */}
                  {isAdmin && (
                    <div>
                      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 12, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={notifyNewTickets}
                          onChange={e => setNotifyNewTickets(e.target.checked)}
                          style={{ marginTop: 3, width: 16, height: 16, flexShrink: 0, cursor: 'pointer' }}
                        />
                        <div>
                          <span style={{ fontWeight: 500 }}>Email me when a new support ticket is submitted</span>
                          <p className="help-text" style={{ marginTop: 4 }}>
                            Receive an email notification each time any user opens a new support ticket.
                          </p>
                        </div>
                      </label>
                    </div>
                  )}

                </div>

                {message && (
                  <div className={`info-box${message.type === 'error' ? ' warning' : ''}`} style={{ marginTop: 20 }}>
                    {message.text}
                  </div>
                )}

                <button
                  className="btn-primary"
                  onClick={handleSave}
                  disabled={saving}
                  style={{ marginTop: 20 }}
                >
                  {saving ? 'Saving...' : 'Save Settings'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default Settings;
