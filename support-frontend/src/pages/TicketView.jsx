import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api';
import TicketMessage from '../components/TicketMessage';

const STATUS_LABELS = {
  open: 'Open',
  awaiting_reply: 'Awaiting Reply',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  closed: 'Closed',
};

function TicketView() {
  const { id } = useParams();
  const [ticket, setTicket] = React.useState(null);
  const [messages, setMessages] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState('');
  const [actionError, setActionError] = React.useState('');
  const [reply, setReply] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [actionLoading, setActionLoading] = React.useState(false);
  const [rating, setRating] = React.useState(0);

  const loadTicket = React.useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const data = await apiGet(`/support/tickets/${id}`);
      setTicket(data.ticket);
      setMessages(data.messages || []);
      setRating(data.ticket?.satisfaction_rating || 0);
    } catch (err) {
      setLoadError(err.message || 'Failed to load ticket.');
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
    setSubmitting(true);
    setActionError('');
    try {
      await apiPost(`/support/tickets/${id}/reply`, { message: reply.trim() });
      setReply('');
      await loadTicket();
    } catch (err) {
      setActionError(err.message || 'Failed to send reply.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleClose = async () => {
    setActionLoading(true);
    setActionError('');
    try {
      await apiPost(`/support/tickets/${id}/close`, {});
      await loadTicket();
    } catch (err) {
      setActionError(err.message || 'Failed to close ticket.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleReopen = async () => {
    setActionLoading(true);
    setActionError('');
    try {
      await apiPost(`/support/tickets/${id}/reopen`, {});
      await loadTicket();
    } catch (err) {
      setActionError(err.message || 'Failed to reopen ticket.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRating = async (value) => {
    setActionError('');
    try {
      await apiPost(`/support/tickets/${id}/rate`, { rating: value });
      setRating(value);
      setTicket((prev) => prev ? { ...prev, satisfaction_rating: value } : prev);
    } catch (err) {
      setActionError(err.message || 'Failed to submit rating.');
    }
  };

  if (loading) {
    return (
      <section className="page-card">
        <p className="muted">Loading ticket...</p>
      </section>
    );
  }

  if (loadError || !ticket) {
    return (
      <section className="page-card">
        <h1>Ticket not found</h1>
        <p>{loadError || 'This ticket may not exist.'}</p>
        <Link className="pill" to="/tickets">Back to My Tickets</Link>
      </section>
    );
  }

  const statusLabel = STATUS_LABELS[ticket.status] || ticket.status;
  const canReply = ticket.status !== 'closed';
  const canRate = ['resolved', 'closed'].includes(ticket.status);

  return (
    <section className="page-card ticket-detail">
      <div className="ticket-header">
        <div>
          <span className={`ticket-status ${ticket.status}`}>{statusLabel}</span>
          <h1>{ticket.subject}</h1>
          <p className="muted">Ticket #{ticket.ticket_number} • {ticket.category}</p>
        </div>
        <div className="ticket-actions">
          {ticket.status === 'closed' ? (
            <button className="pill" type="button" onClick={handleReopen} disabled={actionLoading}>
              Reopen
            </button>
          ) : (
            <button className="pill" type="button" onClick={handleClose} disabled={actionLoading}>
              Close
            </button>
          )}
          <Link className="pill" to="/tickets">Back</Link>
        </div>
      </div>

      <div className="ticket-thread">
        {messages.map((message) => (
          <TicketMessage key={message.id} message={message} />
        ))}
      </div>
      {actionError ? <p className="form-error">{actionError}</p> : null}

      {canReply ? (
        <form className="ticket-reply" onSubmit={handleReply}>
          <label htmlFor="reply">Add a reply</label>
          <textarea
            id="reply"
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            rows={4}
            placeholder="Write your response..."
          />
          <button type="submit" className="pill primary" disabled={submitting}>
            {submitting ? 'Sending...' : 'Send reply'}
          </button>
        </form>
      ) : (
        <div className="ticket-closed-note">
          <p>This ticket is closed. You can reopen it if you need more help.</p>
        </div>
      )}

      {canRate ? (
        <div className="ticket-rating">
          <p>How would you rate the support you received?</p>
          <div className="rating-actions">
            {[1, 2, 3, 4, 5].map((value) => (
              <button
                key={value}
                type="button"
                className={rating === value ? 'active' : ''}
                onClick={() => handleRating(value)}
              >
                {value}
              </button>
            ))}
          </div>
          {rating ? <span className="muted">Thanks for rating.</span> : null}
        </div>
      ) : null}
    </section>
  );
}

export default TicketView;
