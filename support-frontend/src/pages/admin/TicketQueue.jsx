import React from 'react';
import { Link } from 'react-router-dom';
import { apiGet, apiPut } from '../../lib/api';

const STATUS_OPTIONS = ['', 'open', 'awaiting_reply', 'in_progress', 'resolved', 'closed'];
const PRIORITY_OPTIONS = ['', 'low', 'normal', 'high', 'urgent'];

function TicketQueue({ user }) {
  const [tickets, setTickets] = React.useState([]);
  const [status, setStatus] = React.useState('');
  const [priority, setPriority] = React.useState('');
  const [assigned, setAssigned] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [actionError, setActionError] = React.useState('');
  const [actionLoading, setActionLoading] = React.useState(false);

  const loadTickets = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (priority) params.set('priority', priority);
      if (assigned) params.set('assigned_to', assigned);
      if (query.trim()) params.set('search', query.trim());
      const data = await apiGet(`/support/admin/tickets?${params.toString()}`);
      setTickets(data.tickets || []);
    } catch (err) {
      setError(err.message || 'Failed to load tickets.');
    } finally {
      setLoading(false);
    }
  }, [status, priority, assigned, query]);

  React.useEffect(() => {
    loadTickets();
  }, [loadTickets]);

  const handleSearch = (event) => {
    event.preventDefault();
    setQuery(search);
  };

  const handleAssignToMe = async (ticketId) => {
    setActionLoading(true);
    setActionError('');
    try {
      await apiPut(`/support/admin/tickets/${ticketId}/assign`, { assigned_to: user?.id || user?.user_id });
      await loadTickets();
    } catch (err) {
      setActionError(err.message || 'Failed to assign ticket.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleUnassign = async (ticketId) => {
    setActionLoading(true);
    setActionError('');
    try {
      await apiPut(`/support/admin/tickets/${ticketId}/assign`, { assigned_to: null });
      await loadTickets();
    } catch (err) {
      setActionError(err.message || 'Failed to unassign ticket.');
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <section className="page-card">
      <div className="section-header">
        <div>
          <h1>Ticket Queue</h1>
          <p>Review, claim, and update ticket status for the team.</p>
        </div>
        <Link className="pill" to="/admin">Dashboard</Link>
      </div>

      <form className="queue-filters" onSubmit={handleSearch}>
        <input
          type="search"
          placeholder="Search by ticket, user, or subject"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          {STATUS_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option ? option.replace('_', ' ') : 'All statuses'}
            </option>
          ))}
        </select>
        <select value={priority} onChange={(event) => setPriority(event.target.value)}>
          {PRIORITY_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option ? option : 'All priorities'}
            </option>
          ))}
        </select>
        <select value={assigned} onChange={(event) => setAssigned(event.target.value)}>
          <option value="">All assignments</option>
          <option value={user?.id || user?.user_id}>Assigned to me</option>
        </select>
        <button className="pill" type="submit">Filter</button>
      </form>

      {error ? <p className="form-error">{error}</p> : null}
      {actionError ? <p className="form-error">{actionError}</p> : null}
      {loading ? <p className="muted">Loading tickets...</p> : null}

      {!loading ? (
        <div className="queue-list">
          {tickets.map((ticket) => (
            <div key={ticket.id} className="queue-card">
              <div>
                <span className={`ticket-status ${ticket.status}`}>{ticket.status.replace('_', ' ')}</span>
                <h3>{ticket.subject}</h3>
                <p className="muted">#{ticket.ticket_number} • {ticket.category} • {ticket.priority}</p>
                <p className="muted">User: {ticket.user_username || ticket.user_email || ticket.user_id}</p>
              </div>
              <div className="queue-actions">
                <Link className="pill" to={`/admin/tickets/${ticket.id}`}>Open</Link>
                {ticket.assigned_to ? (
                  <button
                    type="button"
                    className="pill"
                    onClick={() => handleUnassign(ticket.id)}
                    disabled={actionLoading}
                  >
                    Unassign
                  </button>
                ) : (
                  <button
                    type="button"
                    className="pill primary"
                    onClick={() => handleAssignToMe(ticket.id)}
                    disabled={actionLoading}
                  >
                    Claim
                  </button>
                )}
              </div>
            </div>
          ))}
          {tickets.length === 0 ? <p className="muted">No tickets match these filters.</p> : null}
        </div>
      ) : null}
    </section>
  );
}

export default TicketQueue;
