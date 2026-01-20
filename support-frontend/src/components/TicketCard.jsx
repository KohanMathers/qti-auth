import React from 'react';
import { Link } from 'react-router-dom';

const STATUS_LABELS = {
  open: 'Open',
  awaiting_reply: 'Awaiting Reply',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  closed: 'Closed',
};

function TicketCard({ ticket }) {
  const updatedAt = ticket.updated_at ? new Date(ticket.updated_at * 1000).toLocaleString() : 'N/A';
  const statusLabel = STATUS_LABELS[ticket.status] || ticket.status;

  return (
    <Link className="ticket-card" to={`/tickets/${ticket.id}`}>
      <div className="ticket-card-top">
        <span className={`ticket-status ${ticket.status}`}>{statusLabel}</span>
        <span className="ticket-number">#{ticket.ticket_number}</span>
      </div>
      <h3>{ticket.subject}</h3>
      <div className="ticket-card-bottom">
        <span>{ticket.category}</span>
        <span>Updated {updatedAt}</span>
      </div>
    </Link>
  );
}

export default TicketCard;
