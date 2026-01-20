import React from 'react';
import MarkdownRenderer from './MarkdownRenderer';

function TicketMessage({ message }) {
  const timestamp = message.created_at ? new Date(message.created_at * 1000).toLocaleString() : '';
  return (
    <div className={`ticket-message ${message.is_staff_reply ? 'staff' : 'user'}`}>
      <div className="ticket-message-header">
        <strong>{message.is_staff_reply ? 'Support' : 'You'}</strong>
        <span>{timestamp}</span>
      </div>
      <MarkdownRenderer content={message.content} />
    </div>
  );
}

export default TicketMessage;
