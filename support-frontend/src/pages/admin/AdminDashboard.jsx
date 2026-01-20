import React from 'react';
import { Link } from 'react-router-dom';
import { apiGet } from '../../lib/api';

function AdminDashboard({ user }) {
  const [stats, setStats] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    let isMounted = true;

    async function loadStats() {
      setLoading(true);
      setError('');
      try {
        const data = await apiGet('/support/admin/stats');
        if (isMounted) setStats(data.stats || {});
      } catch (err) {
        if (isMounted) setError(err.message || 'Failed to load stats.');
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    loadStats();
    return () => { isMounted = false; };
  }, []);

  return (
    <section className="page-card admin-dashboard">
      <div className="section-header">
        <div>
          <h1>Support Dashboard</h1>
          <p>Welcome back {user?.username_original || user?.email || 'staff'}.</p>
        </div>
        <div className="admin-links">
          <Link className="pill" to="/admin/tickets">Ticket Queue</Link>
          <Link className="pill" to="/admin/articles">Article Manager</Link>
        </div>
      </div>

      {loading ? <p className="muted">Loading stats...</p> : null}
      {error ? <p className="form-error">{error}</p> : null}

      {!loading && stats ? (
        <div className="stats-grid">
          <div className="stat-panel">
            <span>Open</span>
            <strong>{stats.open || 0}</strong>
          </div>
          <div className="stat-panel">
            <span>Awaiting Reply</span>
            <strong>{stats.awaiting_reply || 0}</strong>
          </div>
          <div className="stat-panel">
            <span>In Progress</span>
            <strong>{stats.in_progress || 0}</strong>
          </div>
          <div className="stat-panel">
            <span>Resolved</span>
            <strong>{stats.resolved || 0}</strong>
          </div>
          <div className="stat-panel">
            <span>Closed</span>
            <strong>{stats.closed || 0}</strong>
          </div>
          <div className="stat-panel danger">
            <span>Urgent</span>
            <strong>{stats.urgent || 0}</strong>
          </div>
          <div className="stat-panel">
            <span>Unassigned</span>
            <strong>{stats.unassigned || 0}</strong>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default AdminDashboard;
