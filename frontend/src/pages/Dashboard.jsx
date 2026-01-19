import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle';

function Dashboard({ user, setUser }) {
  const [activeTab, setActiveTab] = useState('profile');
  const [newUsername, setNewUsername] = useState('');
  const [usernameError, setUsernameError] = useState('');
  const [reports, setReports] = useState([]);
  const navigate = useNavigate();

  const handleLogout = () => {
    localStorage.removeItem('qti_token');
    setUser(null);
    navigate('/login');
  };

  const handleUsernameChange = async (e) => {
    e.preventDefault();
    setUsernameError('');

    const token = localStorage.getItem('qti_token');

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/username/change`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ new_username: newUsername }),
      });

      const data = await res.json();

      if (res.ok) {
        setUser({ ...user, username_original: data.username });
        setNewUsername('');
        alert('Username changed successfully!');
      } else {
        setUsernameError(data.error);
      }
    } catch (err) {
      setUsernameError('Network error. Please try again.');
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
            {Boolean(user?.is_child) && <span className="badge child-badge">Under 18</span>}
            {user?.role === 'admin' && <span className="badge admin-badge">Admin</span>}
            <button onClick={handleLogout} className="btn-secondary">Logout</button>
          </div>
        </div>
      </header>

      <div className="dashboard-content">
        <nav className="dashboard-nav">
          <button
            className={activeTab === 'profile' ? 'active' : ''}
            onClick={() => setActiveTab('profile')}
          >
            Profile
          </button>
          <button
            className={activeTab === 'security' ? 'active' : ''}
            onClick={() => setActiveTab('security')}
          >
            Security
          </button>
          <button
            className={activeTab === 'reports' ? 'active' : ''}
            onClick={() => setActiveTab('reports')}
          >
            My Reports
          </button>
          <button
            onClick={() => navigate('/stats')}
          >
            Game Stats
          </button>
          <button
            onClick={() => navigate('/jagsmp')}
          >
            JagSMP
          </button>
          {user.role === 'admin' && (
            <>
              <button
                onClick={() => navigate('/mod/queue')}
              >
                Mod Queue
              </button>
              <button
                onClick={() => navigate('/admin/users')}
              >
                User Management
              </button>
              <button
                onClick={() => navigate('/admin/audit-logs')}
              >
                Audit Logs
              </button>
            </>
          )}
        </nav>

        <div className="dashboard-main">
          {activeTab === 'profile' && (
            <div className="tab-content">
              <h2>Profile</h2>
              
              <div className="info-section">
                <div className="info-row">
                  <span className="label">Username</span>
                  <span className="value">{user?.username_original || user?.username || 'Not set'}</span>
                </div>
                <div className="info-row">
                  <span className="label">Email</span>
                  <span className="value">{user?.email || 'Not set (OAuth login)'}</span>
                </div>
                <div className="info-row">
                  <span className="label">Account Type</span>
                  <span className="value">{user?.is_child ? 'Child Account (Protected)' : 'Adult Account'}</span>
                </div>
                <div className="info-row">
                  <span className="label">Role</span>
                  <span className="value">{user?.role || 'user'}</span>
                </div>
                <div className="info-row">
                  <span className="label">Member Since</span>
                  <span className="value">
                    {user?.created_at
                      ? new Date(user.created_at * 1000).toLocaleDateString('en-US', {
                          year: 'numeric',
                          month: 'long',
                          day: 'numeric'
                        })
                      : 'Unknown'}
                  </span>
                </div>
              </div>

              <div className="section">
                <h3>Change Username</h3>
                <form onSubmit={handleUsernameChange}>
                  <div className="form-group">
                    <input
                      type="text"
                      value={newUsername}
                      onChange={(e) => setNewUsername(e.target.value)}
                      placeholder="New username"
                      minLength={8}
                      maxLength={18}
                    />
                  </div>
                  {usernameError && <div className="error-message">{usernameError}</div>}
                  <button type="submit" className="btn-primary">
                    Change Username
                  </button>
                </form>
                <p className="help-text">
                  Cooldown: 30 days | Max changes per year: 3
                </p>
              </div>

              {Boolean(user?.is_child) && (
                <div className="info-box warning">
                  <h3>Child Account Protections</h3>
                  <p>Your account has enhanced safety features:</p>
                  <ul>
                    <li>Content filtering for inappropriate material</li>
                    <li>Enhanced reporting tools</li>
                    <li>Limited contact from adults (where applicable)</li>
                    <li>Age-appropriate privacy defaults</li>
                  </ul>
                </div>
              )}
            </div>
          )}

          {activeTab === 'security' && (
            <div className="tab-content">
              <h2>Security</h2>
              
              <div className="info-box">
                <h3>Authentication Method</h3>
                <p>
                  {user.email 
                    ? 'Email magic links - no password to remember or leak'
                    : 'OAuth login - managed by your OAuth provider'}
                </p>
              </div>

              <div className="section">
                <h3>Active Sessions</h3>
                <p>You are currently logged in on this device.</p>
                <button onClick={handleLogout} className="btn-danger">
                  Log Out All Sessions
                </button>
              </div>

              <div className="info-box">
                <h3>Security Features</h3>
                <ul>
                  <li>✓ No passwords stored (passwordless authentication)</li>
                  <li>✓ Secure JWT tokens with 7-day expiry</li>
                  <li>✓ Email verification for new logins</li>
                  <li>✓ Rate limiting on authentication attempts</li>
                </ul>
              </div>
            </div>
          )}

          {activeTab === 'reports' && (
            <div className="tab-content">
              <h2>My Reports</h2>
              
              <p className="help-text">
                Track the status of content and users you've reported.
              </p>

              {reports.length === 0 ? (
                <div className="empty-state">
                  <p>You haven't submitted any reports yet.</p>
                  <p className="help-text">
                    If you encounter harmful or illegal content in QTI games, use the in-game
                    reporting feature to alert our moderation team.
                  </p>
                </div>
              ) : (
                <div className="reports-list">
                  {reports.map((report) => (
                    <div key={report.id} className="report-card">
                      <div className="report-header">
                        <span className={`status-badge ${report.status}`}>
                          {report.status}
                        </span>
                        <span className="report-date">
                          {new Date(report.created_at * 1000).toLocaleDateString()}
                        </span>
                      </div>
                      <div className="report-body">
                        <p><strong>Type:</strong> {report.report_type}</p>
                        {report.description && (
                          <p><strong>Description:</strong> {report.description}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="info-box">
                <h3>Reporting Guidelines</h3>
                <p>We review all reports within 24 hours. Report types include:</p>
                <ul>
                  <li><strong>Illegal Content:</strong> CSAM, terrorism, extreme violence</li>
                  <li><strong>Harmful to Children:</strong> Grooming, inappropriate contact</li>
                  <li><strong>Harassment:</strong> Stalking, threats, bullying</li>
                  <li><strong>Hate Speech:</strong> Racial, religious, or homophobic hatred</li>
                  <li><strong>Self-Harm:</strong> Suicide or self-harm promotion</li>
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default Dashboard;
