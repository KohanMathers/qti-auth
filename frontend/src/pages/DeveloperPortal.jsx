import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle';

function DeveloperPortal({ user }) {
  const navigate = useNavigate();
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingClient, setEditingClient] = useState(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Form state
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    homepage_url: '',
    privacy_policy_url: '',
    redirect_uris: '',
    client_type: 'confidential',
  });

  // New client secret (shown only once after creation)
  const [newClientSecret, setNewClientSecret] = useState(null);

  useEffect(() => {
    fetchClients();
  }, []);

  const fetchClients = async () => {
    const token = localStorage.getItem('qti_token');

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/oauth/clients`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      const data = await res.json();

      if (res.ok) {
        setClients(data.clients);
      } else {
        setError(data.error || 'Failed to load clients');
      }
    } catch (err) {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    const token = localStorage.getItem('qti_token');
    const redirectUris = formData.redirect_uris
      .split('\n')
      .map(uri => uri.trim())
      .filter(uri => uri);

    if (redirectUris.length === 0) {
      setError('At least one redirect URI is required');
      return;
    }

    try {
      const url = editingClient
        ? `${import.meta.env.VITE_API_URL}/oauth/clients/${editingClient.id}`
        : `${import.meta.env.VITE_API_URL}/oauth/clients`;

      const res = await fetch(url, {
        method: editingClient ? 'PUT' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: formData.name,
          description: formData.description || undefined,
          homepage_url: formData.homepage_url || undefined,
          privacy_policy_url: formData.privacy_policy_url || undefined,
          redirect_uris: redirectUris,
          client_type: formData.client_type,
        }),
      });

      const data = await res.json();

      if (res.ok) {
        if (!editingClient && data.client_secret) {
          setNewClientSecret({
            client_id: data.client_id,
            client_secret: data.client_secret,
          });
        }
        setSuccess(editingClient ? 'Application updated successfully' : 'Application created successfully');
        setShowCreateForm(false);
        setEditingClient(null);
        resetForm();
        fetchClients();
      } else {
        setError(data.error || 'Failed to save application');
      }
    } catch (err) {
      setError('Network error. Please try again.');
    }
  };

  const handleDelete = async (clientId) => {
    if (!confirm('Are you sure you want to delete this application? This cannot be undone.')) {
      return;
    }

    const token = localStorage.getItem('qti_token');

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/oauth/clients/${clientId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (res.ok) {
        setSuccess('Application deleted');
        fetchClients();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to delete application');
      }
    } catch (err) {
      setError('Network error. Please try again.');
    }
  };

  const handleRegenerateSecret = async (clientId) => {
    if (!confirm('Are you sure? This will invalidate the current secret and revoke all active tokens.')) {
      return;
    }

    const token = localStorage.getItem('qti_token');

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/oauth/clients/${clientId}/regenerate-secret`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      const data = await res.json();

      if (res.ok) {
        setNewClientSecret({
          client_id: clientId,
          client_secret: data.client_secret,
        });
        setSuccess('Client secret regenerated');
      } else {
        setError(data.error || 'Failed to regenerate secret');
      }
    } catch (err) {
      setError('Network error. Please try again.');
    }
  };

  const handleRequestApproval = async (clientId) => {
    const token = localStorage.getItem('qti_token');

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/oauth/clients/${clientId}/request-approval`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      const data = await res.json();

      if (res.ok) {
        setSuccess('Approval requested! An admin will review your application.');
        fetchClients();
      } else {
        setError(data.error || 'Failed to request approval');
      }
    } catch (err) {
      setError('Network error. Please try again.');
    }
  };

  const startEdit = (client) => {
    setFormData({
      name: client.name,
      description: client.description || '',
      homepage_url: client.homepage_url || '',
      privacy_policy_url: client.privacy_policy_url || '',
      redirect_uris: client.redirect_uris.join('\n'),
      client_type: client.client_type,
    });
    setEditingClient(client);
    setShowCreateForm(true);
  };

  const resetForm = () => {
    setFormData({
      name: '',
      description: '',
      homepage_url: '',
      privacy_policy_url: '',
      redirect_uris: '',
      client_type: 'confidential',
    });
  };

  const cancelForm = () => {
    setShowCreateForm(false);
    setEditingClient(null);
    resetForm();
    setError('');
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
          <h1>Developer Portal</h1>
          <div className="user-info">
            <span className="username">{user?.username_original || 'Developer'}</span>
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

          {newClientSecret && (
            <div className="info-box warning client-secret-box">
              <h3>Save Your Client Secret</h3>
              <p>This is the only time your client secret will be shown. Save it securely!</p>
              <div className="secret-display">
                <div className="form-group">
                  <label>Client ID</label>
                  <code>{newClientSecret.client_id}</code>
                </div>
                <div className="form-group">
                  <label>Client Secret</label>
                  <code>{newClientSecret.client_secret}</code>
                </div>
              </div>
              <button onClick={() => setNewClientSecret(null)} className="btn-secondary">
                I've saved my secret
              </button>
            </div>
          )}

          {!showCreateForm ? (
            <>
              <div className="section-header">
                <h2>My OAuth Applications</h2>
                <button onClick={() => setShowCreateForm(true)} className="btn-primary">
                  Create Application
                </button>
              </div>

              {clients.length === 0 ? (
                <div className="empty-state">
                  <p>You haven't created any OAuth applications yet.</p>
                  <p className="help-text">
                    Create an application to allow third-party sites to use "Sign in with QTI".
                  </p>
                </div>
              ) : (
                <div className="clients-list">
                  {clients.map((client) => (
                    <div key={client.id} className="client-card">
                      <div className="client-header">
                        <h3>{client.name}</h3>
                        <div className="client-badges">
                          {client.is_approved ? (
                            <span className="badge success">Approved</span>
                          ) : client.approval_requested ? (
                            <span className="badge info">Under Review</span>
                          ) : (
                            <span className="badge muted">Draft</span>
                          )}
                          <span className={`badge ${client.client_type === 'public' ? 'info' : 'muted'}`}>
                            {client.client_type}
                          </span>
                        </div>
                      </div>

                      {client.description && (
                        <p className="client-description">{client.description}</p>
                      )}

                      <div className="client-details">
                        <div className="detail-row">
                          <span className="label">Client ID</span>
                          <code>{client.id}</code>
                        </div>
                        <div className="detail-row">
                          <span className="label">Redirect URIs</span>
                          <div className="uri-list">
                            {client.redirect_uris.map((uri, i) => (
                              <code key={i}>{uri}</code>
                            ))}
                          </div>
                        </div>
                        <div className="detail-row">
                          <span className="label">Created</span>
                          <span>{new Date(client.created_at * 1000).toLocaleDateString()}</span>
                        </div>
                      </div>

                      <div className="client-actions">
                        <button onClick={() => startEdit(client)} className="btn-secondary">
                          Edit
                        </button>
                        {client.client_type === 'confidential' && (
                          <button onClick={() => handleRegenerateSecret(client.id)} className="btn-secondary">
                            Regenerate Secret
                          </button>
                        )}
                        {!client.is_approved && !client.approval_requested && (
                          <button onClick={() => handleRequestApproval(client.id)} className="btn-primary">
                            Request Approval
                          </button>
                        )}
                        <button onClick={() => handleDelete(client.id)} className="btn-danger">
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="info-box">
                <h3>Getting Started</h3>
                <p>Add "Sign in with QTI" to your app in a few steps:</p>
                <ol>
                  <li>Create an application and save your client credentials</li>
                  <li>Set up your redirect URI to handle the callback</li>
                  <li>Test the login flow with your own account</li>
                  <li>When ready, request approval to go live</li>
                </ol>
                <p className="help-text">
                  Draft apps work immediately for testing - only you can sign in until approved.
                  Check <code>/.well-known/openid-configuration</code> for endpoint details.
                </p>
              </div>
            </>
          ) : (
            <div className="create-form-container">
              <h2>{editingClient ? 'Edit Application' : 'Create OAuth Application'}</h2>

              <form onSubmit={handleSubmit}>
                <div className="form-group">
                  <label htmlFor="name">Application Name *</label>
                  <input
                    type="text"
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="My Awesome App"
                    minLength={3}
                    maxLength={100}
                    required
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="description">Description</label>
                  <textarea
                    id="description"
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    placeholder="A brief description of your application"
                    rows={3}
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="homepage_url">Homepage URL</label>
                  <input
                    type="url"
                    id="homepage_url"
                    value={formData.homepage_url}
                    onChange={(e) => setFormData({ ...formData, homepage_url: e.target.value })}
                    placeholder="https://example.com"
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="privacy_policy_url">Privacy Policy URL</label>
                  <input
                    type="url"
                    id="privacy_policy_url"
                    value={formData.privacy_policy_url}
                    onChange={(e) => setFormData({ ...formData, privacy_policy_url: e.target.value })}
                    placeholder="https://example.com/privacy"
                  />
                </div>

                <div className="form-group">
                  <label htmlFor="redirect_uris">Redirect URIs * (one per line)</label>
                  <textarea
                    id="redirect_uris"
                    value={formData.redirect_uris}
                    onChange={(e) => setFormData({ ...formData, redirect_uris: e.target.value })}
                    placeholder="https://example.com/callback&#10;http://localhost:3000/callback"
                    rows={4}
                    required
                  />
                  <p className="help-text">
                    Must use HTTPS except for localhost. Exact URI matching is enforced.
                  </p>
                </div>

                <div className="form-group">
                  <label htmlFor="client_type">Client Type</label>
                  <select
                    id="client_type"
                    value={formData.client_type}
                    onChange={(e) => setFormData({ ...formData, client_type: e.target.value })}
                  >
                    <option value="confidential">Confidential (server-side apps)</option>
                    <option value="public">Public (SPAs, mobile apps)</option>
                  </select>
                  <p className="help-text">
                    Confidential clients can securely store secrets. Public clients cannot.
                  </p>
                </div>

                <div className="form-actions">
                  <button type="button" onClick={cancelForm} className="btn-secondary">
                    Cancel
                  </button>
                  <button type="submit" className="btn-primary">
                    {editingClient ? 'Update Application' : 'Create Application'}
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default DeveloperPortal;
