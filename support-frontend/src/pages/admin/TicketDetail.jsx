import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiGet, apiPost, apiPut } from '../../lib/api';
import TicketMessage from '../../components/TicketMessage';

const STATUS_OPTIONS = ['open', 'awaiting_reply', 'in_progress', 'resolved', 'closed'];
const PRIORITY_OPTIONS = ['low', 'normal', 'high', 'urgent'];

function TicketDetail({ user }) {
  const { id } = useParams();
  const [ticket, setTicket] = React.useState(null);
  const [messages, setMessages] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [reply, setReply] = React.useState('');
  const [note, setNote] = React.useState('');
  const [saving, setSaving] = React.useState(false);

  const loadTicket = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiGet(`/support/admin/tickets/${id}`);
      setTicket(data.ticket);
      setMessages(data.messages || []);
    } catch (err) {
      setError(err.message || 'Failed to load ticket.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    loadTicket();
  }, [loadTicket]);

  const handleReply = async (event) => {
    event.preventDefault();
    if (!reply.trim()) return;
    setSaving(true);
    setError('');
    try {
      await apiPost(`/support/admin/tickets/${id}/reply`, { message: reply.trim() });
      setReply('');
      await loadTicket();
    } catch (err) {
      setError(err.message || 'Failed to send reply.');
    } finally {
      setSaving(false);
    }
  };

  const handleNote = async (event) => {
    event.preventDefault();
    if (!note.trim()) return;
    setSaving(true);
    setError('');
    try {
      await apiPost(`/support/admin/tickets/${id}/note`, { message: note.trim() });
      setNote('');
      await loadTicket();
    } catch (err) {
      setError(err.message || 'Failed to add note.');
    } finally {
      setSaving(false);
    }
  };

  const handleStatus = async (value) => {
    setSaving(true);
    setError('');
    try {
      await apiPut(`/support/admin/tickets/${id}/status`, { status: value });
      await loadTicket();
    } catch (err) {
      setError(err.message || 'Failed to update status.');
    } finally {
      setSaving(false);
    }
  };

  const handlePriority = async (value) => {
    setSaving(true);
    setError('');
    try {
      await apiPut(`/support/admin/tickets/${id}/priority`, { priority: value });
      await loadTicket();
    } catch (err) {
      setError(err.message || 'Failed to update priority.');
    } finally {
      setSaving(false);
    }
  };

  const handleAssign = async () => {
    setSaving(true);
    setError('');
    try {
      await apiPut(`/support/admin/tickets/${id}/assign`, { assigned_to: user?.id || user?.user_id });
      await loadTicket();
    } catch (err) {
      setError(err.message || 'Failed to assign ticket.');
    } finally {
      setSaving(false);
    }
  };

  const handleUnassign = async () => {
    setSaving(true);
    setError('');
    try {
      await apiPut(`/support/admin/tickets/${id}/assign`, { assigned_to: null });
      await loadTicket();
    } catch (err) {
      setError(err.message || 'Failed to unassign ticket.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <section className="page-card">
        <p className="muted">Loading ticket...</p>
      </section>
    );
  }

  if (!ticket) {
    return (
      <section className="page-card">
        <h1>Ticket not found</h1>
        <p>{error || 'This ticket may have been removed.'}</p>
        <Link className="pill" to="/admin/tickets">Back to queue</Link>
      </section>
    );
  }

  return (
    <section className="page-card admin-ticket-detail">
      <div className="section-header">
        <div>
          <h1>{ticket.subject}</h1>
          <p className="muted">#{ticket.ticket_number} • {ticket.category}</p>
        </div>
        <div className="ticket-actions">
          <Link className="pill" to="/admin/tickets">Back to queue</Link>
          {ticket.assigned_to ? (
            <button className="pill" type="button" onClick={handleUnassign} disabled={saving}>Unassign</button>
          ) : (
            <button className="pill primary" type="button" onClick={handleAssign} disabled={saving}>Claim</button>
          )}
        </div>
      </div>

      {error ? <p className="form-error">{error}</p> : null}

      <div className="admin-ticket-meta">
        <div>
          <label>Status</label>
          <select value={ticket.status} onChange={(event) => handleStatus(event.target.value)} disabled={saving}>
            {STATUS_OPTIONS.map((option) => (
              <option key={option} value={option}>{option.replace('_', ' ')}</option>
            ))}
          </select>
        </div>
        <div>
          <label>Priority</label>
          <select value={ticket.priority} onChange={(event) => handlePriority(event.target.value)} disabled={saving}>
            {PRIORITY_OPTIONS.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </div>
        <div>
          <label>Assigned</label>
          <span>{ticket.assigned_username || ticket.assigned_email || ticket.assigned_to || 'Unassigned'}</span>
        </div>
        <div>
          <label>User</label>
          <span>{ticket.user_username || ticket.user_email || ticket.user_id}</span>
        </div>
      </div>

      <div className="ticket-thread">
        {messages.map((message) => (
          <TicketMessage key={message.id} message={message} />
        ))}
      </div>

      <form className="ticket-reply" onSubmit={handleReply}>
        <label htmlFor="reply">Staff reply</label>
        <textarea
          id="reply"
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          rows={4}
        />
        <button className="pill primary" type="submit" disabled={saving}>Send reply</button>
      </form>

      <form className="ticket-reply" onSubmit={handleNote}>
        <label htmlFor="note">Internal note</label>
        <textarea
          id="note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={3}
        />
        <button className="pill" type="submit" disabled={saving}>Add note</button>
      </form>
    </section>
  );
}

export default TicketDetail;
