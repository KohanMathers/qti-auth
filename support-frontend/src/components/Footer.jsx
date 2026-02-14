import React from 'react';
import { Link } from 'react-router-dom';
import { SUPPORT_BRANDING } from '../config/branding';

function Footer() {
  return (
    <footer className="support-footer">
      <div className="footer-inner">
        <p>{SUPPORT_BRANDING.supportFooterName}</p>
        <div className="footer-links">
          <Link to="/kb">Knowledge Base</Link>
<<<<<<< HEAD
          <a href={SUPPORT_BRANDING.accountUrl} target="_blank" rel="noreferrer">Account</a>
          <a href={SUPPORT_BRANDING.mainSiteUrl} target="_blank" rel="noreferrer">Main Site</a>
=======
          {/* External links open in new tabs to keep ticket context intact. */}
          <a href="https://account.quietterminal.co.uk" target="_blank" rel="noreferrer">Account</a>
          <a href="https://quietterminal.co.uk" target="_blank" rel="noreferrer">Main Site</a>
>>>>>>> 46701a859a0fe4ec77a69c4b39c311dc198eeb33
        </div>
      </div>
    </footer>
  );
}

export default Footer;
