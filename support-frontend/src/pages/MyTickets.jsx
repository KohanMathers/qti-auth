import React from 'react';
import { apiGet } from '../lib/api';
import SearchBar from '../components/SearchBar';
import TicketCard from '../components/TicketCard';

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'open', label: 'Open' },
  { value: 'awaiting_reply', label: 'Awaiting Reply' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
];

function MyTickets({ user }) {
  const [tickets, setTickets] = React.useState([]);
  const [status, setStatus] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');

  const loadTickets = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (query.trim()) params.set('search', query.trim());
      const data = await apiGet(`/support/tickets?${params.toString()}`);
      setTickets(data.tickets || []);
    } catch (err) {
      setError(err.message || 'Failed to load tickets.');
    } finally {
      setLoading(false);
    }
  }, [status, query]);

  React.useEffect(() => {
    loadTickets();
  }, [loadTickets]);

  const handleSearch = (event) => {
    event.preventDefault();
    setQuery(search);
  };

  const openCount = tickets.filter((ticket) => ticket.status === 'open').length;
  const waitingCount = tickets.filter((ticket) => ticket.status === 'awaiting_reply').length;

  return (
    <section className="page-card">
      <div className="section-header">
        <div>
          <h1>My Tickets</h1>
          <p>Track replies, updates, and ticket status changes.</p>
        </div>
        {user ? <span className="muted">Signed in as {user.username_original || user.email}</span> : null}
      </div>

      <div className="ticket-filters">
        <SearchBar value={search} onChange={setSearch} onSubmit={handleSearch} placeholder="Search by subject or #ticket" />
        <div className="select-row">
          <label htmlFor="status-filter">Status</label>
          <select id="status-filter" value={status} onChange={(event) => setStatus(event.target.value)}>
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
        <div className="ticket-stats">
          <span>{openCount} open</span>
          <span>{waitingCount} awaiting reply</span>
          <span>{tickets.length} total</span>
        </div>
      </div>

      {loading ? <p className="muted">Loading tickets...</p> : null}
      {error ? <p className="form-error">{error}</p> : null}

      {!loading && !error ? (
        <div className="ticket-grid">
          {tickets.map((ticket) => (
            <TicketCard key={ticket.id} ticket={ticket} />
          ))}
          {tickets.length === 0 ? <p className="muted">No tickets found.</p> : null}
        </div>
      ) : null}
    </section>
  );
}

export default MyTickets;
