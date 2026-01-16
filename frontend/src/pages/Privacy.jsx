import React from 'react';
import { Link } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle';

function Privacy() {
  return (
    <div className="auth-container">
      <ThemeToggle />
      <div className="auth-box" style={{ maxWidth: '900px', maxHeight: '85vh', overflowY: 'auto' }}>
        <h1>Quiet Terminal Interactive LTD customer privacy notice</h1>
        <p className="subtitle">This privacy notice tells you what to expect us to do with your personal information.</p>

        <div style={{ textAlign: 'left', marginTop: '2rem', fontSize: '0.95rem' }}>
          <ul style={{ marginBottom: '2rem', lineHeight: '1.7' }}>
            <li>Contact details</li>
            <li>What information we collect, use, and why</li>
            <li>Lawful bases and data protection rights</li>
            <li>Where we get personal information from</li>
            <li>How long we keep information</li>
            <li>Who we share information with</li>
            <li>How to complain</li>
          </ul>

          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.4rem', marginBottom: '1rem', color: 'var(--primary)' }}>Contact details</h2>
            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>Telephone</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>07841974811</p>
            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>Email</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              <a href="mailto:kohan@quietterminal.co.uk" style={{ color: 'var(--primary)' }}>kohan@quietterminal.co.uk</a>
            </p>
          </section>

          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.4rem', marginBottom: '1rem', color: 'var(--primary)' }}>What information we collect, use, and why</h2>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              We collect or use the following information for <strong>the operation of customer accounts and guarantees</strong>:
            </p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Names and contact details</li>
              <li>Date of birth</li>
            </ul>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              We collect or use the following information to <strong>comply with legal requirements</strong>:
            </p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Any other personal information required to comply with legal obligations</li>
            </ul>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              We collect or use the following personal information for <strong>dealing with queries, complaints or claims</strong>:
            </p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Account information</li>
              <li>Purchase or service history</li>
              <li>Customer or client accounts and records</li>
              <li>Correspondence</li>
            </ul>
          </section>

          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.4rem', marginBottom: '1rem', color: 'var(--primary)' }}>Lawful bases and data protection rights</h2>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              Under UK data protection law, we must have a "lawful basis" for collecting and using your personal information. There is a list of possible lawful bases in the UK GDPR. You can find out more about lawful bases on the ICO's website.
            </p>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              Which lawful basis we rely on may affect your data protection rights which are set out in brief below. You can find out more about your data protection rights and the exemptions which may apply on the ICO's website:
            </p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li><strong>Your right of access</strong> - You have the right to ask us for copies of your personal information. You can request other information such as details about where we get personal information from and who we share personal information with. There are some exemptions which means you may not receive all the information you ask for. Read more about the right of access.</li>
              <li><strong>Your right to rectification</strong> - You have the right to ask us to correct or delete personal information you think is inaccurate or incomplete. Read more about the right to rectification.</li>
              <li><strong>Your right to erasure</strong> - You have the right to ask us to delete your personal information. Read more about the right to erasure.</li>
              <li><strong>Your right to restriction of processing</strong> - You have the right to ask us to limit how we can use your personal information. Read more about the right to restriction of processing.</li>
              <li><strong>Your right to object to processing</strong> - You have the right to object to the processing of your personal data. Read more about the right to object to processing.</li>
              <li><strong>Your right to data portability</strong> - You have the right to ask that we transfer the personal information you gave us to another organisation, or to you. Read more about the right to data portability.</li>
              <li><strong>Your right to withdraw consent</strong> – When we use consent as our lawful basis you have the right to withdraw your consent at any time. Read more about the right to withdraw consent.</li>
            </ul>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              If you make a request, we must respond to you without undue delay and in any event within one month.
            </p>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              To make a data protection rights request, please contact us using the contact details at the top of this privacy notice.
            </p>
          </section>

          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.4rem', marginBottom: '1rem', color: 'var(--primary)' }}>Our lawful bases for the collection and use of your data</h2>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              Our lawful bases for collecting or using personal information for <strong>the operation of customer accounts and guarantees</strong> are:
            </p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Consent - we have permission from you after we gave you all the relevant information. All of your data protection rights may apply, except the right to object. To be clear, you do have the right to withdraw your consent at any time.</li>
            </ul>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              Our lawful bases for collecting or using personal information for <strong>legal requirements</strong> are:
            </p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Legal obligation – we have to collect or use your information so we can comply with the law. All of your data protection rights may apply, except the right to erasure, the right to object and the right to data portability.</li>
            </ul>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              Our lawful bases for collecting or using personal information for <strong>dealing with queries, complaints or claims</strong> are:
            </p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Consent - we have permission from you after we gave you all the relevant information. All of your data protection rights may apply, except the right to object. To be clear, you do have the right to withdraw your consent at any time.</li>
            </ul>
          </section>

          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.4rem', marginBottom: '1rem', color: 'var(--primary)' }}>Where we get personal information from</h2>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Directly from you</li>
            </ul>
          </section>

          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.4rem', marginBottom: '1rem', color: 'var(--primary)' }}>How long we keep information</h2>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li><strong>Active Accounts:</strong> Data is retained while your account is active.</li>
              <li><strong>Deleted Accounts:</strong> Most personal data is deleted within 30 days. Some data (e.g., moderation logs) may be retained longer for legal compliance.</li>
              <li><strong>Authentication Logs:</strong> Retained for 90 days for security purposes.</li>
              <li><strong>Child Safety Reports:</strong> Retained indefinitely as required by UK law.</li>
            </ul>
          </section>

          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.4rem', marginBottom: '1rem', color: 'var(--primary)' }}>Who we share information with</h2>
            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>Data processors</h3>
            <h4 style={{ fontSize: '1.1rem', marginTop: '1rem', marginBottom: '0.5rem', fontWeight: '600' }}>Cloudflare</h4>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              This data processor does the following activities for us: they maintain and manage our user account database and management system.
            </p>
            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>Others we share personal information with</h3>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Organisations we're legally obliged to share personal information with</li>
            </ul>
          </section>

          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.4rem', marginBottom: '1rem', color: 'var(--primary)' }}>How to complain</h2>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              If you have any concerns about our use of your personal data, you can make a complaint to us using the contact details at the top of this privacy notice.
            </p>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              If you remain unhappy with how we've used your data after raising a complaint with us, you can also complain to the ICO.
            </p>
            <p style={{ marginBottom: '0.5rem', lineHeight: '1.7' }}>
              The ICO's address:
            </p>
            <p style={{ marginBottom: '0.5rem', lineHeight: '1.7' }}>
              Information Commissioner's Office<br />
              Wycliffe House<br />
              Water Lane<br />
              Wilmslow<br />
              Cheshire<br />
              SK9 5AF
            </p>
            <p style={{ marginBottom: '0.5rem', lineHeight: '1.7' }}>
              Helpline number: 0303 123 1113
            </p>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              Website: <a href="https://www.ico.org.uk/make-a-complaint" style={{ color: 'var(--primary)' }}>https://www.ico.org.uk/make-a-complaint</a>
            </p>
          </section>

          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.4rem', marginBottom: '1rem', color: 'var(--primary)' }}>Last updated</h2>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>10 January 2026</p>
          </section>
        </div>

        <div style={{ marginTop: '2rem', paddingTop: '2rem', borderTop: '1px solid var(--border)', textAlign: 'center' }}>
          <Link to="/login" className="btn-primary" style={{ display: 'inline-block', textDecoration: 'none', padding: '0.75rem 2rem' }}>
            Back to Login
          </Link>
        </div>
      </div>
    </div>
  );
}

export default Privacy;
