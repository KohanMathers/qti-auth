import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle';

const FILTER_OPTIONS = [
  { value: '', label: 'All Apps' },
  { value: 'pending', label: 'Pending Review' },
  { value: 'approved', label: 'Approved' },
  { value: 'not_approved', label: 'Not Approved' },
];

function OAuthAdmin({ user }) {
  const navigate = useNavigate();
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('pending');
  const [pagination, setPagination] = useState({ page: 1, total: 0, total_pages: 0 });
  const [selectedClient, setSelectedClient] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    fetchClients();
  }, [filter, pagination.page]);

  const fetchClients = async () => {
    const token = localStorage.getItem('qti_token');
    setLoading(true);

    const params = new URLSearchParams();
    if (filter === 'pending') {
      params.append('is_approved', 'false');
    } else if (filter === 'approved') {
      params.append('is_approved', 'true');
    }
    params.append('page', pagination.page);
    params.append('limit', '25');

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/admin/oauth/clients?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();

      // Backend filtering gets us close; client-side tightens the pending view.
      let filteredClients = data.clients || [];

      if (filter === 'pending') {
        filteredClients = filteredClients.filter(c => c.approval_requested && !c.is_approved);
      } else if (filter === 'not_approved') {
        filteredClients = filteredClients.filter(c => !c.is_approved);
      }

      setClients(filteredClients);
      setPagination(data.pagination || { page: 1, total: 0, total_pages: 0 });
    } catch (err) {
      console.error('Failed to fetch clients:', err);
      setError('Failed to load applications');
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async (clientId) => {
    const token = localStorage.getItem('qti_token');
    setActionLoading(true);
    setError('');
    setSuccess('');

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/admin/oauth/clients/${clientId}/approve`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });

      if (res.ok) {
        setSuccess('Application approved');
        setSelectedClient(null);
        fetchClients();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to approve');
      }
    } catch (err) {
      setError('Network error');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRevoke = async (clientId) => {
    if (!confirm('This will revoke approval and prevent public access. Continue?')) return;

    const token = localStorage.getItem('qti_token');
    setActionLoading(true);
    setError('');
    setSuccess('');

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/admin/oauth/clients/${clientId}/revoke`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });

      if (res.ok) {
        setSuccess('Approval revoked');
        setSelectedClient(null);
        fetchClients();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to revoke');
      }
    } catch (err) {
      setError('Network error');
    } finally {
      setActionLoading(false);
    }
  };

  const formatDate = (ts) => {
    if (!ts) return 'N/A';
    return new Date(ts * 1000).toLocaleString();
  };

  const getStatusBadge = (client) => {
    if (client.is_approved) {
      return <span className="badge success">Approved</span>;
    }
    if (client.approval_requested) {
      return <span className="badge info">Pending Review</span>;
    }
    return <span className="badge muted">Draft</span>;
  };

  return (
    <div className="admin-page-container">
      <ThemeToggle />

      <header className="admin-header">
        <div className="admin-header-left">
          <button className="back-btn" onClick={() => navigate('/dashboard')}>
            Back to Dashboard
          </button>
          <h1>OAuth Applications</h1>
        </div>
        <div className="admin-header-right">
          <button className="nav-btn" onClick={() => navigate('/admin/users')}>
            User Management
          </button>
          <button className="nav-btn" onClick={() => navigate('/admin/audit-logs')}>
            Audit Logs
          </button>
        </div>
      </header>

      <div className="admin-content">
        <div className="users-panel">
          <div className="filters-section">
            <div className="filter-row">
              <select value={filter} onChange={(e) => { setFilter(e.target.value); setPagination(p => ({ ...p, page: 1 })); }}>
                {FILTER_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="users-stats">
            <span>{clients.length} applications</span>
          </div>

          {error && <div className="error-message">{error}</div>}
          {success && <div className="success-message">{success}</div>}

          {loading ? (
            <div className="loading-state">Loading applications...</div>
          ) : clients.length === 0 ? (
            <div className="empty-state">
              {filter === 'pending' ? 'No applications pending review' : 'No applications found'}
            </div>
          ) : (
            <>
              <div className="users-list">
                {clients.map((client) => (
                  <div
                    key={client.id}
                    className={`user-item ${selectedClient?.id === client.id ? 'selected' : ''}`}
                    onClick={() => setSelectedClient(client)}
                  >
                    <div className="user-item-header">
                      <span className="username">{client.name}</span>
                      {getStatusBadge(client)}
                    </div>
                    <div className="user-item-body">
                      <span className="email">by {client.created_by_username}</span>
                      <span className={`badge ${client.client_type === 'public' ? 'info' : 'muted'}`}>
                        {client.client_type}
                      </span>
                    </div>
                    <div className="user-item-footer">
                      <span className="date">
                        {client.approval_requested_at
                          ? `Requested: ${formatDate(client.approval_requested_at)}`
                          : `Created: ${formatDate(client.created_at)}`
                        }
                      </span>
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
          {selectedClient ? (
            <>
              <h2>Application Details</h2>

              <div className="detail-section">
                <h3>Basic Information</h3>
                <div className="detail-grid">
                  <div className="detail-row">
                    <span className="label">Name:</span>
                    <span className="value">{selectedClient.name}</span>
                  </div>
                  <div className="detail-row">
                    <span className="label">Description:</span>
                    <span className="value">{selectedClient.description || 'No description'}</span>
                  </div>
                  <div className="detail-row">
                    <span className="label">Client ID:</span>
                    <span className="value monospace">{selectedClient.id}</span>
                  </div>
                  <div className="detail-row">
                    <span className="label">Type:</span>
                    <span className="value">{selectedClient.client_type}</span>
                  </div>
                  <div className="detail-row">
                    <span className="label">Status:</span>
                    <span className="value">{getStatusBadge(selectedClient)}</span>
                  </div>
                  <div className="detail-row">
                    <span className="label">Created by:</span>
                    <span className="value">{selectedClient.created_by_username}</span>
                  </div>
                  <div className="detail-row">
                    <span className="label">Created:</span>
                    <span className="value">{formatDate(selectedClient.created_at)}</span>
                  </div>
                  {selectedClient.approval_requested_at && (
                    <div className="detail-row">
                      <span className="label">Approval Requested:</span>
                      <span className="value">{formatDate(selectedClient.approval_requested_at)}</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="detail-section">
                <h3>URLs</h3>
                <div className="detail-grid">
                  <div className="detail-row">
                    <span className="label">Homepage:</span>
                    <span className="value">
                      {selectedClient.homepage_url ? (
                        <a href={selectedClient.homepage_url} target="_blank" rel="noopener noreferrer">
                          {selectedClient.homepage_url}
                        </a>
                      ) : 'Not provided'}
                    </span>
                  </div>
                  <div className="detail-row">
                    <span className="label">Privacy Policy:</span>
                    <span className="value">
                      {selectedClient.privacy_policy_url ? (
                        <a href={selectedClient.privacy_policy_url} target="_blank" rel="noopener noreferrer">
                          {selectedClient.privacy_policy_url}
                        </a>
                      ) : 'Not provided'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="detail-section">
                <h3>Redirect URIs</h3>
                <div className="uri-list-admin">
                  {selectedClient.redirect_uris.map((uri, i) => (
                    <code key={i}>{uri}</code>
                  ))}
                </div>
              </div>

              <div className="detail-section">
                <h3>Allowed Scopes</h3>
                <div className="scopes-list">
                  {selectedClient.allowed_scopes.map((scope, i) => (
                    <span key={i} className="badge muted">{scope}</span>
                  ))}
                </div>
              </div>

              <div className="action-section">
                <h3>Actions</h3>
                <div className="action-buttons-grid">
                  {!selectedClient.is_approved ? (
                    <button
                      className="btn-success"
                      onClick={() => handleApprove(selectedClient.id)}
                      disabled={actionLoading}
                    >
                      {actionLoading ? 'Processing...' : 'Approve Application'}
                    </button>
                  ) : (
                    <button
                      className="btn-danger"
                      onClick={() => handleRevoke(selectedClient.id)}
                      disabled={actionLoading}
                    >
                      {actionLoading ? 'Processing...' : 'Revoke Approval'}
                    </button>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="empty-selection">
              <p>Select an application to view details</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default OAuthAdmin;
