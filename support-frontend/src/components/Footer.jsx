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
          <a href={SUPPORT_BRANDING.accountUrl} target="_blank" rel="noreferrer">Account</a>
          <a href={SUPPORT_BRANDING.mainSiteUrl} target="_blank" rel="noreferrer">Main Site</a>
        </div>
      </div>
    </footer>
  );
}

export default Footer;
