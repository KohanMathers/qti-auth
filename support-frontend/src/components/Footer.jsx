import React from 'react';
import { Link } from 'react-router-dom';

function Footer() {
  return (
    <footer className="support-footer">
      <div className="footer-inner">
        <p>Quiet Terminal Interactive Support</p>
        <div className="footer-links">
          <Link to="/kb">Knowledge Base</Link>
          <a href="https://account.quietterminal.co.uk" target="_blank" rel="noreferrer">Account</a>
          <a href="https://quietterminal.co.uk" target="_blank" rel="noreferrer">Main Site</a>
        </div>
      </div>
    </footer>
  );
}

export default Footer;
