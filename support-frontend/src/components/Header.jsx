import React from 'react';
import { Link } from 'react-router-dom';
<<<<<<< HEAD
import { SUPPORT_BRANDING } from '../config/branding';
=======
import { startLogin } from '../lib/auth';
>>>>>>> 46701a859a0fe4ec77a69c4b39c311dc198eeb33

function Header({ user, onLogout }) {
  return (
    <header className="support-header">
      <div className="header-inner">
        <div className="brand">
          <strong>{SUPPORT_BRANDING.supportTitle}</strong>
          <span>{SUPPORT_BRANDING.supportHostLabel}</span>
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
<<<<<<< HEAD
            <a className="pill" href={SUPPORT_BRANDING.accountLoginUrl}>Sign in</a>
=======
            <button type="button" className="pill" onClick={() => startLogin()}>Sign in with QTI</button>
>>>>>>> 46701a859a0fe4ec77a69c4b39c311dc198eeb33
          )}
          <Link className="pill primary" to="/tickets/new">Submit Ticket</Link>
        </div>
      </div>
    </header>
  );
}

export default Header;
