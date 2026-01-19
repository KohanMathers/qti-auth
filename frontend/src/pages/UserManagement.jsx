import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle';

const STATUS_OPTIONS = [
  { value: '', label: 'All Users' },
  { value: 'active', label: 'Active' },
  { value: 'banned', label: 'Banned' },
  { value: 'locked', label: 'Locked' },
];

const ROLE_OPTIONS = [
  { value: '', label: 'All Roles' },
  { value: 'admin', label: 'Admin' },
  { value: 'user', label: 'User' },
];

const ACTION_TYPES = {
  ban: 'Banned',
  unban: 'Unbanned',
  lock: 'Locked',
  unlock: 'Unlocked',
  warning: 'Warning',
  timeout: 'Timeout',
  suspend: 'Suspended',
};

function UserManagement({ user }) {
  const navigate = useNavigate();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [pagination, setPagination] = useState({ page: 1, total: 0, total_pages: 0 });

  const [selectedUser, setSelectedUser] = useState(null);
  const [userDetails, setUserDetails] = useState(null);
  const [detailsLoading, setDetailsLoading] = useState(false);

  const [actionModal, setActionModal] = useState(null);
  const [actionReason, setActionReason] = useState('');
  const [actionNotes, setActionNotes] = useState('');
  const [actionDuration, setActionDuration] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    fetchUsers();
  }, [statusFilter, roleFilter, pagination.page]);

  const fetchUsers = async () => {
    const token = localStorage.getItem('qti_token');
    setLoading(true);

    const params = new URLSearchParams();
    if (search) params.append('search', search);
    if (statusFilter) params.append('status', statusFilter);
    if (roleFilter) params.append('role', roleFilter);
    params.append('page', pagination.page);
    params.append('limit', '25');

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/admin/users?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      setUsers(data.users || []);
      setPagination(data.pagination || { page: 1, total: 0, total_pages: 0 });
    } catch (err) {
      console.error('Failed to fetch users:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (e) => {
    e.preventDefault();
    setPagination(p => ({ ...p, page: 1 }));
    fetchUsers();
  };

  const fetchUserDetails = async (userId) => {
    const token = localStorage.getItem('qti_token');
    setDetailsLoading(true);

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/admin/users/${userId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      setUserDetails(data);
    } catch (err) {
      console.error('Failed to fetch user details:', err);
    } finally {
      setDetailsLoading(false);
    }
  };

  const selectUser = (u) => {
    setSelectedUser(u);
    fetchUserDetails(u.id);
  };

  const performAction = async (action) => {
    const token = localStorage.getItem('qti_token');
    setActionLoading(true);

    const payload = { reason: actionReason };
    if (actionNotes) payload.internal_notes = actionNotes;
    if (actionDuration && (action === 'lock')) {
      payload.duration = parseInt(actionDuration) * 86400; // days to seconds
    }

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/admin/users/${selectedUser.id}/${action}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (res.ok) {
        alert(data.message || 'Action completed');
        setActionModal(null);
        setActionReason('');
        setActionNotes('');
        setActionDuration('');
        fetchUsers();
        fetchUserDetails(selectedUser.id);
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (err) {
      alert('Network error');
    } finally {
      setActionLoading(false);
    }
  };

  const handleForceReauth = async () => {
    if (!confirm('This will log the user out of all devices. Continue?')) return;

    const token = localStorage.getItem('qti_token');
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/admin/users/${selectedUser.id}/force-reauth`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ reason: 'Forced re-authentication by admin' }),
      });
      const data = await res.json();
      if (res.ok) {
        alert(`Success: ${data.sessions_revoked} sessions revoked`);
        fetchUserDetails(selectedUser.id);
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (err) {
      alert('Network error');
    }
  };

  const getStatusBadge = (u) => {
    if (u.is_banned) return <span className="status-badge banned">Banned</span>;
    if (u.is_locked) return <span className="status-badge locked">Locked</span>;
    return <span className="status-badge active">Active</span>;
  };

  const formatDate = (ts) => {
    if (!ts) return 'N/A';
    return new Date(ts * 1000).toLocaleString();
  };

  return (
    <div className="admin-page-container">
      <ThemeToggle />

      <header className="admin-header">
        <div className="admin-header-left">
          <button className="back-btn" onClick={() => navigate('/dashboard')}>
            Back to Dashboard
          </button>
          <h1>User Management</h1>
        </div>
        <div className="admin-header-right">
          <button className="nav-btn" onClick={() => navigate('/admin/audit-logs')}>
            Audit Logs
          </button>
          <button className="nav-btn" onClick={() => navigate('/mod/queue')}>
            Mod Queue
          </button>
        </div>
      </header>

      <div className="admin-content">
        <div className="users-panel">
          <div className="filters-section">
            <form onSubmit={handleSearch} className="search-form">
              <input
                type="text"
                placeholder="Search by username, email, or ID..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button type="submit" className="btn-primary">Search</button>
            </form>

            <div className="filter-row">
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                {STATUS_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}>
                {ROLE_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="users-stats">
            <span>{pagination.total} users found</span>
          </div>

          {loading ? (
            <div className="loading-state">Loading users...</div>
          ) : users.length === 0 ? (
            <div className="empty-state">No users found</div>
          ) : (
            <>
              <div className="users-list">
                {users.map((u) => (
                  <div
                    key={u.id}
                    className={`user-item ${selectedUser?.id === u.id ? 'selected' : ''}`}
                    onClick={() => selectUser(u)}
                  >
                    <div className="user-item-header">
                      <span className="username">{u.username_original || 'No username'}</span>
                      {getStatusBadge(u)}
                    </div>
                    <div className="user-item-body">
                      <span className="email">{u.email || 'No email'}</span>
                      <span className="role-badge">{u.role}</span>
                      {u.is_child ? <span className="child-badge">Under 18</span> : null}
                    </div>
                    <div className="user-item-footer">
                      <span className="date">Joined: {formatDate(u.created_at)}</span>
                    </div>
                  </div>
                ))}
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
          {selectedUser ? (
            detailsLoading ? (
              <div className="loading-state">Loading user details...</div>
            ) : userDetails ? (
              <>
                <h2>User Details</h2>

                <div className="detail-section">
                  <h3>Account Information</h3>
                  <div className="detail-grid">
                    <div className="detail-row">
                      <span className="label">ID:</span>
                      <span className="value monospace">{userDetails.user.id}</span>
                    </div>
                    <div className="detail-row">
                      <span className="label">Username:</span>
                      <span className="value">{userDetails.user.username_original || 'Not set'}</span>
                    </div>
                    <div className="detail-row">
                      <span className="label">Email:</span>
                      <span className="value">{userDetails.user.email || 'Not set'}</span>
                    </div>
                    <div className="detail-row">
                      <span className="label">Role:</span>
                      <span className="value">{userDetails.user.role}</span>
                    </div>
                    <div className="detail-row">
                      <span className="label">Status:</span>
                      <span className="value">{getStatusBadge(userDetails.user)}</span>
                    </div>
                    <div className="detail-row">
                      <span className="label">Under 18:</span>
                      <span className="value">{userDetails.user.is_child ? 'Yes' : 'No'}</span>
                    </div>
                    <div className="detail-row">
                      <span className="label">Active Sessions:</span>
                      <span className="value">{userDetails.active_sessions}</span>
                    </div>
                    <div className="detail-row">
                      <span className="label">Reports Against:</span>
                      <span className="value">{userDetails.reports_against?.length || 0}</span>
                    </div>
                    <div className="detail-row">
                      <span className="label">Reports Made:</span>
                      <span className="value">{userDetails.reports_made}</span>
                    </div>
                    <div className="detail-row">
                      <span className="label">Created:</span>
                      <span className="value">{formatDate(userDetails.user.created_at)}</span>
                    </div>
                  </div>
                </div>

                {!!userDetails.user.is_banned && (
                  <div className="detail-section warning-section">
                    <h3>Ban Information</h3>
                    <div className="detail-grid">
                      <div className="detail-row">
                        <span className="label">Reason:</span>
                        <span className="value">{userDetails.user.ban_reason}</span>
                      </div>
                      <div className="detail-row">
                        <span className="label">Banned At:</span>
                        <span className="value">{formatDate(userDetails.user.banned_at)}</span>
                      </div>
                    </div>
                  </div>
                )}

                {!!userDetails.user.is_locked && (
                  <div className="detail-section warning-section">
                    <h3>Lock Information</h3>
                    <div className="detail-grid">
                      <div className="detail-row">
                        <span className="label">Reason:</span>
                        <span className="value">{userDetails.user.lock_reason}</span>
                      </div>
                      <div className="detail-row">
                        <span className="label">Locked At:</span>
                        <span className="value">{formatDate(userDetails.user.locked_at)}</span>
                      </div>
                      <div className="detail-row">
                        <span className="label">Expires:</span>
                        <span className="value">
                          {userDetails.user.lock_expires_at
                            ? formatDate(userDetails.user.lock_expires_at)
                            : 'Indefinite'}
                        </span>
                      </div>
                    </div>
                  </div>
                )}

                <div className="detail-section">
                  <h3>Moderation History</h3>
                  {userDetails.moderation_history?.length > 0 ? (
                    <div className="history-list">
                      {userDetails.moderation_history.map((action) => (
                        <div key={action.id} className="history-item">
                          <div className="history-header">
                            <span className={`action-badge ${action.action_type}`}>
                              {ACTION_TYPES[action.action_type] || action.action_type}
                            </span>
                            <span className="history-date">{formatDate(action.created_at)}</span>
                          </div>
                          <div className="history-body">
                            <p><strong>By:</strong> {action.moderator_username || 'System'}</p>
                            <p><strong>Reason:</strong> {action.reason}</p>
                            {!!action.duration && (
                              <p><strong>Duration:</strong> {Math.round(action.duration / 86400)} days</p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="empty-text">No moderation history</p>
                  )}
                </div>

                <div className="action-section">
                  <h3>Actions</h3>
                  <div className="action-buttons-grid">
                    {userDetails.user.role !== 'admin' && !userDetails.user.is_banned && !userDetails.user.is_locked && (
                      <>
                        <button
                          className="btn-danger"
                          onClick={() => setActionModal('ban')}
                        >
                          Ban User
                        </button>
                        <button
                          className="btn-warning"
                          onClick={() => setActionModal('lock')}
                        >
                          Lock Account
                        </button>
                      </>
                    )}
                    {userDetails.user.role !== 'admin' && !!userDetails.user.is_banned && (
                      <button
                        className="btn-success"
                        onClick={() => setActionModal('unban')}
                      >
                        Unban User
                      </button>
                    )}
                    {userDetails.user.role !== 'admin' && !!userDetails.user.is_locked && (
                      <button
                        className="btn-success"
                        onClick={() => setActionModal('unlock')}
                      >
                        Unlock Account
                      </button>
                    )}
                    {userDetails.user.role !== 'admin' && (
                      <button
                        className="btn-secondary"
                        onClick={handleForceReauth}
                      >
                        Force Re-auth
                      </button>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="error-state">Failed to load user details</div>
            )
          ) : (
            <div className="empty-selection">
              <p>Select a user to view details</p>
            </div>
          )}
        </div>
      </div>

      {actionModal && (
        <div className="modal-overlay" onClick={() => setActionModal(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h2>
              {actionModal === 'ban' && 'Ban User'}
              {actionModal === 'unban' && 'Unban User'}
              {actionModal === 'lock' && 'Lock Account'}
              {actionModal === 'unlock' && 'Unlock Account'}
            </h2>

            <p className="modal-subtitle">
              {actionModal === 'ban' && 'This will permanently ban the user and revoke all their sessions.'}
              {actionModal === 'unban' && 'This will restore the user\'s account access.'}
              {actionModal === 'lock' && 'This will temporarily restrict the user\'s account.'}
              {actionModal === 'unlock' && 'This will restore the user\'s account access.'}
            </p>

            <div className="form-group">
              <label>Reason {(actionModal === 'ban' || actionModal === 'lock') && '*'}</label>
              <textarea
                value={actionReason}
                onChange={(e) => setActionReason(e.target.value)}
                placeholder="Enter the reason for this action..."
                rows={3}
                required={actionModal === 'ban' || actionModal === 'lock'}
              />
            </div>

            {actionModal === 'lock' && (
              <div className="form-group">
                <label>Duration (days, leave empty for indefinite)</label>
                <input
                  type="number"
                  value={actionDuration}
                  onChange={(e) => setActionDuration(e.target.value)}
                  placeholder="e.g., 7"
                  min="1"
                  max="365"
                />
              </div>
            )}

            {(actionModal === 'ban' || actionModal === 'lock') && (
              <div className="form-group">
                <label>Internal Notes (optional, admin-only)</label>
                <textarea
                  value={actionNotes}
                  onChange={(e) => setActionNotes(e.target.value)}
                  placeholder="Internal context, evidence links, etc..."
                  rows={2}
                />
              </div>
            )}

            <div className="modal-actions">
              <button
                className="btn-secondary"
                onClick={() => setActionModal(null)}
                disabled={actionLoading}
              >
                Cancel
              </button>
              <button
                className={actionModal === 'ban' ? 'btn-danger' : actionModal === 'lock' ? 'btn-warning' : 'btn-primary'}
                onClick={() => performAction(actionModal)}
                disabled={actionLoading || ((actionModal === 'ban' || actionModal === 'lock') && !actionReason)}
              >
                {actionLoading ? 'Processing...' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default UserManagement;
