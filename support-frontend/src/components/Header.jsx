import React from 'react';
import { Link } from 'react-router-dom';

const ACCOUNT_LOGIN_URL = import.meta.env.VITE_ACCOUNT_URL || 'https://account.quietterminal.co.uk/login';

function Header({ user, onLogout }) {
  return (
    <header className="support-header">
      <div className="header-inner">
        <div className="brand">
          <strong>QTI Support</strong>
          <span>support.quietterminal.co.uk</span>
        </div>
        <nav className="header-nav">
          <Link to="/">Home</Link>
          <Link to="/kb">Knowledge Base</Link>
          <Link to="/tickets">My Tickets</Link>
          <Link to="/admin">Staff</Link>
        </nav>
        <div className="header-actions">
          <Link className="pill" to="/tickets">Track Ticket</Link>
          {user ? (
            <>
              <span className="user-chip">Hi {user.username_original || 'there'}</span>
              <button type="button" className="pill" onClick={onLogout}>Sign out</button>
            </>
          ) : (
            <a className="pill" href={ACCOUNT_LOGIN_URL}>Sign in</a>
          )}
          <Link className="pill primary" to="/tickets/new">Submit Ticket</Link>
        </div>
      </div>
    </header>
  );
}

export default Header;
