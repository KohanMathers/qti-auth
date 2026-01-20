import React, { useState, useEffect } from 'react';
import ThemeToggle from '../components/ThemeToggle';

const REPORT_TYPES = {
  illegal_content: 'Illegal Content',
  harmful_to_child: 'Harmful to Children',
  harassment: 'Harassment',
  hate_speech: 'Hate Speech',
  threats: 'Threats',
  self_harm: 'Self-Harm Content',
  fraud: 'Fraud',
  spam: 'Spam',
  other: 'Other',
};

const ACTIONS = {
  warning: 'Warning',
  timeout: 'Timeout',
  suspend: 'Suspend',
  ban: 'Permanent Ban',
  content_removal: 'Remove Content',
};

function ModQueue({ user }) {
  const [reports, setReports] = useState([]);
  const [selectedReport, setSelectedReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionType, setActionType] = useState('warning');
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState('');
  const [internalNotes, setInternalNotes] = useState('');

  useEffect(() => {
    fetchReports();
  }, []);

  const fetchReports = async () => {
    const token = localStorage.getItem('qti_token');
    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/moderation/queue`, {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      const data = await res.json();
      setReports(data.reports || []);
    } catch (err) {
      console.error('Failed to fetch reports:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleAction = async (e) => {
    e.preventDefault();
    
    const token = localStorage.getItem('qti_token');
    
    const payload = {
      report_id: selectedReport.id,
      user_id: selectedReport.reported_user_id,
      action_type: actionType,
      reason,
      internal_notes: internalNotes,
    };

    if (duration && (actionType === 'timeout' || actionType === 'suspend')) {
      // API expects seconds for moderation durations.
      payload.duration = parseInt(duration) * 86400;
    }

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/moderation/action`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        alert('Action applied successfully');
        setSelectedReport(null);
        setReason('');
        setInternalNotes('');
        setDuration('');
        fetchReports();
      } else {
        const data = await res.json();
        alert(`Error: ${data.error}`);
      }
    } catch (err) {
      alert('Network error');
    }
  };

  const handleDismiss = async () => {
    const token = localStorage.getItem('qti_token');
    const dismissReason = prompt('Reason for dismissing this report:');
    
    if (!dismissReason) return;

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/moderation/dismiss`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          report_id: selectedReport.id,
          reason: dismissReason,
        }),
      });

      if (res.ok) {
        alert('Report dismissed');
        setSelectedReport(null);
        fetchReports();
      }
    } catch (err) {
      alert('Network error');
    }
  };

  const getPriorityColor = (priority) => {
    switch (priority) {
      case 'urgent': return '#DD5F5F';
      case 'high': return '#FF954F';
      case 'medium': return '#F7DA47';
      default: return '#666577';
    }
  };

  if (loading) {
    return <div className="loading">Loading moderation queue...</div>;
  }

  return (
    <div className="mod-queue-container">
      <ThemeToggle />
      <header className="mod-header">
        <h1>Moderation Queue</h1>
        <div className="queue-stats">
          <span className="stat">
            <strong>{reports.length}</strong> pending reports
          </span>
          <span className="stat urgent">
            <strong>{reports.filter(r => r.priority === 'urgent').length}</strong> urgent
          </span>
        </div>
      </header>

      <div className="mod-content">
        <div className="reports-panel">
          {reports.length === 0 ? (
            <div className="empty-state">
              <p>✓ No pending reports</p>
              <p className="help-text">All caught up on moderation!</p>
            </div>
          ) : (
            <div className="reports-list">
              {reports.map((report) => (
                <div
                  key={report.id}
                  className={`report-item ${selectedReport?.id === report.id ? 'selected' : ''}`}
                  onClick={() => setSelectedReport(report)}
                  style={{ borderLeftColor: getPriorityColor(report.priority) }}
                >
                  <div className="report-item-header">
                    <span className="report-type">{REPORT_TYPES[report.report_type]}</span>
                    <span className={`priority-badge ${report.priority}`}>
                      {report.priority}
                    </span>
                  </div>
                  <div className="report-item-body">
                    <p className="reported-user">
                      Reported: <strong>{report.reported_username || 'Unknown'}</strong>
                    </p>
                    <p className="reporter">
                      By: {report.reporter_username || 'Anonymous'}
                    </p>
                    <p className="report-time">
                      {new Date(report.created_at * 1000).toLocaleString()}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="detail-panel">
          {selectedReport ? (
            <>
              <h2>Report Details</h2>
              
              <div className="detail-section">
                <h3>Report Information</h3>
                <div className="detail-grid">
                  <div className="detail-row">
                    <span className="label">Type:</span>
                    <span>{REPORT_TYPES[selectedReport.report_type]}</span>
                  </div>
                  {selectedReport.report_subtype && (
                    <div className="detail-row">
                      <span className="label">Subtype:</span>
                      <span>{selectedReport.report_subtype}</span>
                    </div>
                  )}
                  <div className="detail-row">
                    <span className="label">Priority:</span>
                    <span className={`priority-badge ${selectedReport.priority}`}>
                      {selectedReport.priority}
                    </span>
                  </div>
                  <div className="detail-row">
                    <span className="label">Reported User:</span>
                    <span><strong>{selectedReport.reported_username}</strong></span>
                  </div>
                  <div className="detail-row">
                    <span className="label">Reporter:</span>
                    <span>{selectedReport.reporter_username || 'Anonymous'}</span>
                  </div>
                  <div className="detail-row">
                    <span className="label">Submitted:</span>
                    <span>{new Date(selectedReport.created_at * 1000).toLocaleString()}</span>
                  </div>
                </div>
              </div>

              {selectedReport.description && (
                <div className="detail-section">
                  <h3>Description</h3>
                  <div className="description-box">
                    {selectedReport.description}
                  </div>
                </div>
              )}

              {selectedReport.content_snapshot && (
                <div className="detail-section">
                  <h3>Content Snapshot</h3>
                  <div className="content-snapshot">
                    <pre>{selectedReport.content_snapshot}</pre>
                  </div>
                </div>
              )}

              <form onSubmit={handleAction} className="action-form">
                <h3>Take Action</h3>
                
                <div className="form-group">
                  <label>Action Type</label>
                  <select
                    value={actionType}
                    onChange={(e) => setActionType(e.target.value)}
                    required
                  >
                    {Object.entries(ACTIONS).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </div>

                {(actionType === 'timeout' || actionType === 'suspend') && (
                  <div className="form-group">
                    <label>Duration (days)</label>
                    <input
                      type="number"
                      value={duration}
                      onChange={(e) => setDuration(e.target.value)}
                      min="1"
                      max="365"
                      required
                    />
                  </div>
                )}

                <div className="form-group">
                  <label>Reason (visible to user)</label>
                  <textarea
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    required
                    rows={3}
                    placeholder="Explain why this action was taken..."
                  />
                </div>

                <div className="form-group">
                  <label>Internal Notes (admin only)</label>
                  <textarea
                    value={internalNotes}
                    onChange={(e) => setInternalNotes(e.target.value)}
                    rows={2}
                    placeholder="Internal context, evidence, etc..."
                  />
                </div>

                <div className="action-buttons">
                  <button type="submit" className="btn-primary">
                    Apply Action
                  </button>
                  <button
                    type="button"
                    onClick={handleDismiss}
                    className="btn-secondary"
                  >
                    Dismiss Report
                  </button>
                </div>
              </form>

              <div className="compliance-note">
                <p><strong>Moderation Guidelines:</strong></p>
                <ul>
                  <li>Reports should be reviewed within 24 hours</li>
                  <li>All actions are logged for audit purposes</li>
                  <li>Urgent/high priority reports take precedence</li>
                  <li>Document reasoning for each action taken</li>
                </ul>
              </div>
            </>
          ) : (
            <div className="empty-selection">
              <p>Select a report to review</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ModQueue;
