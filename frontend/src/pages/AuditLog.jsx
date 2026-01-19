import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle';

const ACTION_LABELS = {
  ban_user: 'Ban User',
  unban_user: 'Unban User',
  lock_user: 'Lock User',
  unlock_user: 'Unlock User',
  force_reauth: 'Force Re-auth',
  change_role: 'Change Role',
  revoke_all_sessions: 'Revoke Sessions',
  ban: 'Ban',
  unban: 'Unban',
  warning: 'Warning',
  timeout: 'Timeout',
  suspend: 'Suspend',
  content_removal: 'Content Removal',
};

const ACTION_COLORS = {
  ban_user: 'danger',
  unban_user: 'success',
  lock_user: 'warning',
  unlock_user: 'success',
  force_reauth: 'info',
  change_role: 'info',
  revoke_all_sessions: 'warning',
  ban: 'danger',
  unban: 'success',
  warning: 'warning',
  timeout: 'warning',
  suspend: 'danger',
  content_removal: 'danger',
};

function AuditLog({ user }) {
  const navigate = useNavigate();
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({ page: 1, total: 0, total_pages: 0 });

  // Filters
  const [admins, setAdmins] = useState([]);
  const [actions, setActions] = useState([]);
  const [selectedAdmin, setSelectedAdmin] = useState('');
  const [selectedAction, setSelectedAction] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Selected log detail
  const [selectedLog, setSelectedLog] = useState(null);

  // Tab: audit-logs vs moderation-history
  const [activeTab, setActiveTab] = useState('audit-logs');

  useEffect(() => {
    fetchFilterOptions();
  }, []);

  useEffect(() => {
    if (activeTab === 'audit-logs') {
      fetchAuditLogs();
    } else {
      fetchModerationHistory();
    }
  }, [activeTab, selectedAdmin, selectedAction, startDate, endDate, pagination.page]);

  const fetchFilterOptions = async () => {
    const token = localStorage.getItem('qti_token');
    try {
      const [adminsRes, actionsRes] = await Promise.all([
        fetch(`${import.meta.env.VITE_API_URL}/admin/audit-logs/admins`, {
          headers: { 'Authorization': `Bearer ${token}` },
        }),
        fetch(`${import.meta.env.VITE_API_URL}/admin/audit-logs/actions`, {
          headers: { 'Authorization': `Bearer ${token}` },
        }),
      ]);
      const adminsData = await adminsRes.json();
      const actionsData = await actionsRes.json();
      setAdmins(adminsData.admins || []);
      setActions(actionsData.actions || []);
    } catch (err) {
      console.error('Failed to fetch filter options:', err);
    }
  };

  const fetchAuditLogs = async () => {
    const token = localStorage.getItem('qti_token');
    setLoading(true);

    const params = new URLSearchParams();
    if (selectedAdmin) params.append('admin_id', selectedAdmin);
    if (selectedAction) params.append('action', selectedAction);
    if (startDate) params.append('start_date', startDate);
    if (endDate) params.append('end_date', endDate);
    params.append('page', pagination.page);
    params.append('limit', '50');

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/admin/audit-logs?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      setLogs(data.logs || []);
      setPagination(data.pagination || { page: 1, total: 0, total_pages: 0 });
    } catch (err) {
      console.error('Failed to fetch audit logs:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchModerationHistory = async () => {
    const token = localStorage.getItem('qti_token');
    setLoading(true);

    const params = new URLSearchParams();
    if (selectedAdmin) params.append('moderator_id', selectedAdmin);
    if (selectedAction) params.append('action_type', selectedAction);
    params.append('page', pagination.page);
    params.append('limit', '50');

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/admin/moderation-history?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      setLogs(data.actions || []);
      setPagination(data.pagination || { page: 1, total: 0, total_pages: 0 });
    } catch (err) {
      console.error('Failed to fetch moderation history:', err);
    } finally {
      setLoading(false);
    }
  };

  const clearFilters = () => {
    setSelectedAdmin('');
    setSelectedAction('');
    setStartDate('');
    setEndDate('');
    setPagination(p => ({ ...p, page: 1 }));
  };

  const formatDate = (ts) => {
    if (!ts) return 'N/A';
    return new Date(ts * 1000).toLocaleString();
  };

  const getActionBadge = (action) => {
    const color = ACTION_COLORS[action] || 'default';
    const label = ACTION_LABELS[action] || action;
    return <span className={`action-badge ${color}`}>{label}</span>;
  };

  const renderAuditLogItem = (log) => (
    <div
      key={log.id}
      className={`log-item ${selectedLog?.id === log.id ? 'selected' : ''}`}
      onClick={() => setSelectedLog(log)}
    >
      <div className="log-item-header">
        {getActionBadge(log.action)}
        <span className="log-date">{formatDate(log.created_at)}</span>
      </div>
      <div className="log-item-body">
        <p><strong>Admin:</strong> {log.admin_username || 'Unknown'}</p>
        {log.target_username && <p><strong>Target:</strong> {log.target_username}</p>}
        {log.ip_address && <p className="ip-address"><strong>IP:</strong> {log.ip_address}</p>}
      </div>
    </div>
  );

  const renderModerationItem = (action) => (
    <div
      key={action.id}
      className={`log-item ${selectedLog?.id === action.id ? 'selected' : ''}`}
      onClick={() => setSelectedLog(action)}
    >
      <div className="log-item-header">
        {getActionBadge(action.action_type)}
        <span className="log-date">{formatDate(action.created_at)}</span>
      </div>
      <div className="log-item-body">
        <p><strong>Moderator:</strong> {action.moderator_username || 'Unknown'}</p>
        <p><strong>Target:</strong> {action.target_username || 'Unknown'}</p>
        <p className="reason-preview">{action.reason?.substring(0, 50)}{action.reason?.length > 50 ? '...' : ''}</p>
      </div>
    </div>
  );

  const renderLogDetail = () => {
    if (!selectedLog) {
      return (
        <div className="empty-selection">
          <p>Select a log entry to view details</p>
        </div>
      );
    }

    if (activeTab === 'audit-logs') {
      return (
        <>
          <h2>Audit Log Details</h2>
          <div className="detail-section">
            <div className="detail-grid">
              <div className="detail-row">
                <span className="label">Log ID:</span>
                <span className="value monospace">{selectedLog.id}</span>
              </div>
              <div className="detail-row">
                <span className="label">Action:</span>
                <span className="value">{getActionBadge(selectedLog.action)}</span>
              </div>
              <div className="detail-row">
                <span className="label">Admin:</span>
                <span className="value">{selectedLog.admin_username || 'Unknown'}</span>
              </div>
              <div className="detail-row">
                <span className="label">Admin ID:</span>
                <span className="value monospace">{selectedLog.admin_id}</span>
              </div>
              {selectedLog.target_username && (
                <div className="detail-row">
                  <span className="label">Target User:</span>
                  <span className="value">{selectedLog.target_username}</span>
                </div>
              )}
              {selectedLog.target_id && (
                <div className="detail-row">
                  <span className="label">Target ID:</span>
                  <span className="value monospace">{selectedLog.target_id}</span>
                </div>
              )}
              <div className="detail-row">
                <span className="label">IP Address:</span>
                <span className="value">{selectedLog.ip_address || 'Not recorded'}</span>
              </div>
              <div className="detail-row">
                <span className="label">Timestamp:</span>
                <span className="value">{formatDate(selectedLog.created_at)}</span>
              </div>
            </div>
          </div>

          {selectedLog.details && Object.keys(selectedLog.details).length > 0 && (
            <div className="detail-section">
              <h3>Action Details</h3>
              <div className="details-json">
                <pre>{JSON.stringify(selectedLog.details, null, 2)}</pre>
              </div>
            </div>
          )}
        </>
      );
    } else {
      return (
        <>
          <h2>Moderation Action Details</h2>
          <div className="detail-section">
            <div className="detail-grid">
              <div className="detail-row">
                <span className="label">Action ID:</span>
                <span className="value monospace">{selectedLog.id}</span>
              </div>
              <div className="detail-row">
                <span className="label">Action Type:</span>
                <span className="value">{getActionBadge(selectedLog.action_type)}</span>
              </div>
              <div className="detail-row">
                <span className="label">Moderator:</span>
                <span className="value">{selectedLog.moderator_username || 'Unknown'}</span>
              </div>
              <div className="detail-row">
                <span className="label">Target User:</span>
                <span className="value">{selectedLog.target_username || 'Unknown'}</span>
              </div>
              <div className="detail-row">
                <span className="label">Target ID:</span>
                <span className="value monospace">{selectedLog.user_id}</span>
              </div>
              <div className="detail-row">
                <span className="label">Timestamp:</span>
                <span className="value">{formatDate(selectedLog.created_at)}</span>
              </div>
              {selectedLog.duration && (
                <div className="detail-row">
                  <span className="label">Duration:</span>
                  <span className="value">{Math.round(selectedLog.duration / 86400)} days</span>
                </div>
              )}
              {selectedLog.expires_at && (
                <div className="detail-row">
                  <span className="label">Expires:</span>
                  <span className="value">{formatDate(selectedLog.expires_at)}</span>
                </div>
              )}
              {selectedLog.related_report_id && (
                <div className="detail-row">
                  <span className="label">Related Report:</span>
                  <span className="value monospace">{selectedLog.related_report_id}</span>
                </div>
              )}
            </div>
          </div>

          <div className="detail-section">
            <h3>Reason</h3>
            <div className="reason-box">
              {selectedLog.reason || 'No reason provided'}
            </div>
          </div>

          {selectedLog.internal_notes && (
            <div className="detail-section">
              <h3>Internal Notes</h3>
              <div className="notes-box">
                {selectedLog.internal_notes}
              </div>
            </div>
          )}
        </>
      );
    }
  };

  return (
    <div className="admin-page-container">
      <ThemeToggle />

      <header className="admin-header">
        <div className="admin-header-left">
          <button className="back-btn" onClick={() => navigate('/dashboard')}>
            Back to Dashboard
          </button>
          <h1>Audit Logs</h1>
        </div>
        <div className="admin-header-right">
          <button className="nav-btn" onClick={() => navigate('/admin/users')}>
            User Management
          </button>
          <button className="nav-btn" onClick={() => navigate('/mod/queue')}>
            Mod Queue
          </button>
        </div>
      </header>

      <div className="admin-content">
        <div className="logs-panel">
          <div className="tabs">
            <button
              className={`tab ${activeTab === 'audit-logs' ? 'active' : ''}`}
              onClick={() => { setActiveTab('audit-logs'); setSelectedLog(null); setPagination(p => ({ ...p, page: 1 })); }}
            >
              Admin Audit Logs
            </button>
            <button
              className={`tab ${activeTab === 'moderation-history' ? 'active' : ''}`}
              onClick={() => { setActiveTab('moderation-history'); setSelectedLog(null); setPagination(p => ({ ...p, page: 1 })); }}
            >
              Moderation History
            </button>
          </div>

          <div className="filters-section">
            <div className="filter-row">
              <select value={selectedAdmin} onChange={(e) => setSelectedAdmin(e.target.value)}>
                <option value="">All Admins</option>
                {admins.map(admin => (
                  <option key={admin.id} value={admin.id}>{admin.username_original}</option>
                ))}
              </select>

              {activeTab === 'audit-logs' && (
                <select value={selectedAction} onChange={(e) => setSelectedAction(e.target.value)}>
                  <option value="">All Actions</option>
                  {actions.map(action => (
                    <option key={action} value={action}>{ACTION_LABELS[action] || action}</option>
                  ))}
                </select>
              )}
            </div>

            {activeTab === 'audit-logs' && (
              <div className="filter-row">
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  placeholder="Start date"
                />
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  placeholder="End date"
                />
                <button className="btn-secondary btn-small" onClick={clearFilters}>
                  Clear
                </button>
              </div>
            )}
          </div>

          <div className="logs-stats">
            <span>{pagination.total} entries found</span>
          </div>

          {loading ? (
            <div className="loading-state">Loading logs...</div>
          ) : logs.length === 0 ? (
            <div className="empty-state">No logs found</div>
          ) : (
            <>
              <div className="logs-list">
                {logs.map(log =>
                  activeTab === 'audit-logs'
                    ? renderAuditLogItem(log)
                    : renderModerationItem(log)
                )}
              </div>

              {pagination.total_pages > 1 && (
                <div className="pagination">
                  <button
                    disabled={pagination.page <= 1}
                    onClick={() => setPagination(p => ({ ...p, page: p.page - 1 }))}
                  >
                    Previous
                  </button>
                  <span>Page {pagination.page} of {pagination.total_pages}</span>
                  <button
                    disabled={pagination.page >= pagination.total_pages}
                    onClick={() => setPagination(p => ({ ...p, page: p.page + 1 }))}
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        <div className="detail-panel">
          {renderLogDetail()}
        </div>
      </div>
    </div>
  );
}

export default AuditLog;
