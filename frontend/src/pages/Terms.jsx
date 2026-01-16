import React from 'react';
import { Link } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle';

function Terms() {
  return (
    <div className="auth-container">
      <ThemeToggle />
      <div className="auth-box" style={{ maxWidth: '900px', maxHeight: '85vh', overflowY: 'auto' }}>
        <h1>Terms of Service</h1>
        <p className="subtitle">Last Updated: January 10, 2025</p>

        <div style={{ textAlign: 'left', marginTop: '2rem', fontSize: '0.95rem' }}>
          <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
            Welcome to Quiet Terminal Interactive. These Terms of Service ("Terms") govern your use of our games, websites, and services (collectively, the "Services"). By creating an account or using our Services, you agree to these Terms.
          </p>

          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.4rem', marginBottom: '1rem', color: 'var(--primary)' }}>1. Acceptance of Terms</h2>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>By accessing or using Quiet Terminal Interactive, you confirm that:</p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>You have read and understood these Terms</li>
              <li>You agree to be bound by these Terms</li>
              <li>You are at least 13 years old (or the minimum age required in your country)</li>
              <li>If you are under 18, you have parental or guardian consent to use our Services</li>
            </ul>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              If you do not agree to these Terms, you must not use our Services.
            </p>
          </section>

          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.4rem', marginBottom: '1rem', color: 'var(--primary)' }}>2. Account Registration</h2>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>2.1 Creating an Account</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>To use Quiet Terminal Interactive, you must create an account by providing:</p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>A valid email address OR OAuth authentication (Google, GitHub, Discord)</li>
              <li>Your date of birth (required for age verification under UK law)</li>
              <li>A unique username</li>
            </ul>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>2.2 Age Verification</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              We verify your age at registration to comply with the UK Online Safety Act. If you are under 18:
            </p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Your account will be flagged as a child account</li>
              <li>Enhanced safety features will apply</li>
              <li>Certain content may be restricted</li>
            </ul>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              <strong>Providing false age information is prohibited and may result in immediate account termination.</strong>
            </p>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>2.3 Account Security</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>You are responsible for:</p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Maintaining the confidentiality of your account</li>
              <li>All activities that occur under your account</li>
              <li>Notifying us immediately of any unauthorized use</li>
            </ul>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              We use passwordless authentication (email magic links or OAuth) for your security. Never share your login emails or OAuth credentials.
            </p>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>2.4 One Person, One Account (Mostly)</h3>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>You may have up to <strong>2 accounts per email address</strong></li>
              <li>Each account must have a unique username</li>
              <li>Accounts created to evade bans or restrictions will be terminated</li>
              <li>You may not sell, trade, or transfer your account</li>
            </ul>
          </section>

          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.4rem', marginBottom: '1rem', color: 'var(--primary)' }}>3. Username Rules</h2>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>3.1 Allowed Usernames</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>Your username must:</p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Be 8-18 characters long</li>
              <li>Contain only letters (A-Z), numbers (0-9), and underscores (_)</li>
              <li>Be unique (case-insensitive)</li>
              <li>Not contain profanity, slurs, or hate speech</li>
              <li>Not impersonate QTI staff, moderators, or other users</li>
            </ul>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>3.2 Reserved Prefixes</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              Usernames starting with <strong>QTI_</strong> are reserved for official QTI staff and moderators only.
            </p>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>3.3 Username Changes</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>You may change your username, subject to:</p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li><strong>30-day cooldown</strong> between changes</li>
              <li><strong>Maximum 3 changes per year</strong></li>
              <li>Same username rules apply</li>
              <li>Username history is tracked for security</li>
            </ul>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              Admins may override these restrictions in exceptional circumstances.
            </p>
          </section>

          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.4rem', marginBottom: '1rem', color: 'var(--primary)' }}>4. Acceptable Use</h2>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>4.1 You Must Not</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>When using Quiet Terminal Interactive, you must not:</p>

            <p style={{ marginBottom: '0.5rem', marginTop: '1rem', lineHeight: '1.7' }}><strong>Content Violations:</strong></p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Post, share, or transmit illegal content</li>
              <li>Post child sexual abuse material (CSAM) - <strong>zero tolerance, immediate ban and legal reporting</strong></li>
              <li>Share pornographic, sexually explicit, or age-inappropriate content</li>
              <li>Promote violence, terrorism, or extreme harm</li>
              <li>Post content that promotes self-harm, suicide, or eating disorders</li>
              <li>Share hateful, racist, homophobic, or discriminatory content</li>
              <li>Harass, bully, stalk, or threaten other users</li>
              <li>Dox (share personal information of) other users</li>
              <li>Impersonate others or create fake accounts</li>
            </ul>

            <p style={{ marginBottom: '0.5rem', marginTop: '1rem', lineHeight: '1.7' }}><strong>Gameplay Violations:</strong></p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Cheat, hack, or use unauthorized third-party software</li>
              <li>Exploit bugs or glitches for unfair advantage</li>
              <li>Use bots or automated tools</li>
              <li>Grief, sabotage, or intentionally ruin others' experience</li>
            </ul>

            <p style={{ marginBottom: '0.5rem', marginTop: '1rem', lineHeight: '1.7' }}><strong>Platform Violations:</strong></p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Spam messages, links, or advertisements</li>
              <li>Attempt to gain unauthorized access to accounts or systems</li>
              <li>Circumvent security measures or restrictions</li>
              <li>Scrape, crawl, or extract data from our Services</li>
              <li>Resell, trade, or commercialize accounts or in-game items (unless explicitly allowed)</li>
            </ul>

            <p style={{ marginBottom: '0.5rem', marginTop: '1rem', lineHeight: '1.7' }}><strong>Other Violations:</strong></p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Violate any applicable laws or regulations</li>
              <li>Infringe on intellectual property rights</li>
              <li>Engage in fraud, phishing, or scams</li>
              <li>Use the Services for any unlawful purpose</li>
            </ul>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>4.2 Child Safety</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              We take child safety extremely seriously. If you are under 18:
            </p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>You must not share personal information (address, phone number, school, etc.)</li>
              <li>You must not arrange to meet users you only know online</li>
              <li>Report any inappropriate contact from adults immediately</li>
            </ul>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>Adults must not:</p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Attempt to contact, groom, or solicit minors</li>
              <li>Request personal information from minors</li>
              <li>Share age-inappropriate content with minors</li>
            </ul>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              <strong>Violations of child safety rules result in immediate permanent bans and reporting to authorities.</strong>
            </p>
          </section>

          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.4rem', marginBottom: '1rem', color: 'var(--primary)' }}>5. User-Generated Content</h2>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>5.1 Your Content</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              When you post content (messages, images, videos, etc.) on Quiet Terminal Interactive:
            </p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>You retain ownership of your content</li>
              <li>You grant us a license to use, display, and distribute your content within our Services</li>
              <li>You confirm you have the right to post the content</li>
              <li>You confirm the content does not violate these Terms or any laws</li>
            </ul>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>5.2 Our Rights</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>We reserve the right to:</p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Remove any content that violates these Terms</li>
              <li>Remove content that we deem inappropriate, even if not explicitly prohibited</li>
              <li>Remove content without prior notice</li>
              <li>Not restore deleted content</li>
            </ul>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>5.3 Responsibility</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              You are solely responsible for the content you post. We are not liable for user-generated content, but we will take action against violations when reported or detected.
            </p>
          </section>

          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.4rem', marginBottom: '1rem', color: 'var(--primary)' }}>6. Reporting and Moderation</h2>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>6.1 Reporting Violations</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              If you encounter content or behavior that violates these Terms:
            </p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Use the in-game report button</li>
              <li>Provide a clear description of the violation</li>
              <li>Do not engage with or retaliate against the violator</li>
            </ul>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              We review all reports within <strong>24 hours</strong> (urgent reports faster).
            </p>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>6.2 Our Moderation Process</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              When violations are reported or detected, we may:
            </p>

            <p style={{ marginBottom: '0.5rem', marginTop: '1rem', lineHeight: '1.7' }}><strong>First Offense (Minor):</strong></p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Issue a warning</li>
              <li>Temporary timeout (24 hours to 7 days)</li>
              <li>Remove offending content</li>
            </ul>

            <p style={{ marginBottom: '0.5rem', marginTop: '1rem', lineHeight: '1.7' }}><strong>Repeat or Serious Offenses:</strong></p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Temporary suspension (7-30 days)</li>
              <li>Permanent ban</li>
              <li>Report to law enforcement (for illegal content)</li>
            </ul>

            <p style={{ marginBottom: '0.5rem', marginTop: '1rem', lineHeight: '1.7' }}><strong>Immediate Permanent Ban:</strong></p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>CSAM (child sexual abuse material)</li>
              <li>Terrorism content</li>
              <li>Credible threats of violence</li>
              <li>Severe or repeated harassment</li>
              <li>Ban evasion</li>
            </ul>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>6.3 Appeals</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              If you believe a moderation action was made in error:
            </p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Contact us at moderation@quietterminal.co.uk</li>
              <li>Include your username and reason for appeal</li>
              <li>We will review within 7 days</li>
              <li>Our decision after review is final</li>
            </ul>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>6.4 Transparency</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>You will be notified of:</p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>The reason for any moderation action</li>
              <li>The duration (if temporary)</li>
              <li>How to appeal (if applicable)</li>
            </ul>
          </section>

          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.4rem', marginBottom: '1rem', color: 'var(--primary)' }}>7. Intellectual Property</h2>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>7.1 Our Rights</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              Quiet Terminal Interactive, including all content, features, code, designs, logos, and trademarks, are owned by QTI or our licensors. You may not:
            </p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Copy, modify, or distribute our content</li>
              <li>Reverse engineer our software</li>
              <li>Use our trademarks without permission</li>
              <li>Create derivative works</li>
            </ul>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>7.2 Fan Content</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              You may create fan art, videos, or other content featuring Quiet Terminal Interactive, provided:
            </p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>It is non-commercial (unless we grant permission)</li>
              <li>It does not misrepresent or damage our brand</li>
              <li>It complies with these Terms</li>
            </ul>
          </section>

          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.4rem', marginBottom: '1rem', color: 'var(--primary)' }}>8. Privacy and Data</h2>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>8.1 Data We Collect</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>We collect:</p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Account information (email, date of birth, username)</li>
              <li>Chat logs and user-generated content</li>
              <li>Moderation history and reports</li>
              <li>Usage data and analytics</li>
            </ul>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              See our <strong>Privacy Policy</strong> for full details.
            </p>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>8.2 How We Use Data</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>We use your data to:</p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Provide and improve our Services</li>
              <li>Enforce these Terms and Community Guidelines</li>
              <li>Comply with legal obligations (UK Online Safety Act, GDPR)</li>
              <li>Prevent fraud and abuse</li>
              <li>Communicate with you about the Services</li>
            </ul>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>8.3 Your Rights</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              Under GDPR and UK law, you have the right to:
            </p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Access your data</li>
              <li>Correct inaccurate data</li>
              <li>Request deletion of your data (with exceptions for legal compliance)</li>
              <li>Export your data</li>
              <li>Object to processing</li>
            </ul>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              Contact us at <a href="mailto:kohan@quietterminal.co.uk" style={{ color: 'var(--primary)' }}>kohan@quietterminal.co.uk</a> to exercise these rights.
            </p>
          </section>

          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.4rem', marginBottom: '1rem', color: 'var(--primary)' }}>9. Termination</h2>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>9.1 By You</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              You may delete your account at any time through your account settings or by contacting us.
            </p>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>9.2 By Us</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>We may suspend or terminate your account if:</p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>You violate these Terms</li>
              <li>We suspect fraudulent or illegal activity</li>
              <li>We are required to do so by law</li>
              <li>We discontinue the Services (with notice)</li>
            </ul>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>9.3 Effects of Termination</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>Upon termination:</p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Your access to the Services will be revoked</li>
              <li>Your content may be deleted (we may retain some data for legal compliance)</li>
              <li>You remain liable for any violations that occurred before termination</li>
              <li>Bans may apply to all your accounts</li>
            </ul>
          </section>

          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.4rem', marginBottom: '1rem', color: 'var(--primary)' }}>10. Disclaimers and Limitations of Liability</h2>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>10.1 Service "As Is"</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              Quiet Terminal Interactive is provided "as is" and "as available" without warranties of any kind, including:
            </p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Availability, reliability, or error-free operation</li>
              <li>Fitness for a particular purpose</li>
              <li>Non-infringement</li>
            </ul>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>10.2 User Interactions</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>We are not responsible for:</p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Actions or content of other users</li>
              <li>Disputes between users</li>
              <li>Harm resulting from user interactions (though we will moderate violations)</li>
            </ul>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>10.3 Limitation of Liability</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>To the maximum extent permitted by law:</p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>We are not liable for indirect, incidental, or consequential damages</li>
              <li>Our total liability is limited to the amount you paid us in the last 12 months (or £100, whichever is greater)</li>
              <li>This does not limit liability for death, personal injury, or fraud</li>
            </ul>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>10.4 Your Responsibility</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              You use Quiet Terminal Interactive at your own risk. You are responsible for:
            </p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Your interactions with other users</li>
              <li>Protecting your account security</li>
              <li>Complying with these Terms</li>
            </ul>
          </section>

          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.4rem', marginBottom: '1rem', color: 'var(--primary)' }}>11. Dispute Resolution</h2>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>11.1 Governing Law</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              These Terms are governed by the laws of England and Wales.
            </p>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>11.2 Jurisdiction</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              Any disputes will be resolved in the courts of England and Wales.
            </p>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>11.3 Informal Resolution</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              Before filing a claim, please contact us at <a href="mailto:kohan@quietterminal.co.uk" style={{ color: 'var(--primary)' }}>kohan@quietterminal.co.uk</a> to attempt informal resolution.
            </p>
          </section>

          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.4rem', marginBottom: '1rem', color: 'var(--primary)' }}>12. Changes to Terms</h2>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>12.1 Updates</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              We may update these Terms from time to time. Changes may be made to:
            </p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Comply with legal requirements</li>
              <li>Reflect new features or services</li>
              <li>Improve clarity or fairness</li>
            </ul>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>12.2 Notice</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              We will notify you of material changes by:
            </p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Email to your registered address</li>
              <li>Notice on our website or in-app</li>
              <li>Requiring re-acceptance on next login</li>
            </ul>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              Continued use after changes constitutes acceptance of the new Terms.
            </p>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>12.3 Effective Date</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              Changes take effect 30 days after notice (or immediately for legal requirements).
            </p>
          </section>

          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.4rem', marginBottom: '1rem', color: 'var(--primary)' }}>13. General Provisions</h2>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>13.1 Entire Agreement</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              These Terms, together with our Privacy Policy and Community Guidelines, constitute the entire agreement between you and QTI.
            </p>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>13.2 Severability</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              If any provision is found invalid, the remaining provisions remain in effect.
            </p>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>13.3 Waiver</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              Our failure to enforce any provision does not waive our right to enforce it later.
            </p>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>13.4 Assignment</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              You may not transfer your rights under these Terms. We may assign our rights to a successor or affiliate.
            </p>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>13.5 Force Majeure</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              We are not liable for delays or failures due to circumstances beyond our control (natural disasters, wars, pandemics, etc.).
            </p>
          </section>

          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.4rem', marginBottom: '1rem', color: 'var(--primary)' }}>14. Contact Us</h2>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              If you have questions about these Terms:
            </p>
            <p style={{ marginBottom: '0.5rem', lineHeight: '1.7' }}>
              <strong>Email:</strong> <a href="mailto:kohan@quietterminal.co.uk" style={{ color: 'var(--primary)' }}>kohan@quietterminal.co.uk</a>
            </p>
            <p style={{ marginBottom: '0.5rem', lineHeight: '1.7' }}>
              <strong>Moderation:</strong> <a href="mailto:moderation@quietterminal.co.uk" style={{ color: 'var(--primary)' }}>moderation@quietterminal.co.uk</a>
            </p>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              <strong>Telephone:</strong> 07841974811
            </p>
          </section>

          <section style={{ marginBottom: '2rem' }}>
            <h2 style={{ fontSize: '1.4rem', marginBottom: '1rem', color: 'var(--primary)' }}>15. Specific Legal Notices</h2>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>15.1 UK Online Safety Act Compliance</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              These Terms are designed to comply with the UK Online Safety Act 2023. We:
            </p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Verify user ages at registration</li>
              <li>Provide enhanced protections for child users</li>
              <li>Maintain systems to detect and remove illegal content</li>
              <li>Review user reports within 24 hours</li>
              <li>Maintain audit logs for regulatory compliance</li>
            </ul>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>15.2 GDPR Compliance</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              We process personal data in accordance with UK GDPR and the Data Protection Act 2018. See our Privacy Policy for details.
            </p>

            <h3 style={{ fontSize: '1.2rem', marginTop: '1.5rem', marginBottom: '0.75rem', fontWeight: '600' }}>15.3 Children's Rights</h3>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              If you are under 18, you have specific rights under UK law, including enhanced privacy protections and content filtering. We will not process your data in ways that could harm you.
            </p>
          </section>

          <section style={{ marginBottom: '2rem', padding: '1.5rem', background: 'rgba(91, 177, 239, 0.1)', borderRadius: '8px', border: '1px solid var(--primary)' }}>
            <h2 style={{ fontSize: '1.3rem', marginBottom: '1rem', color: 'var(--primary)' }}>Summary (Not Legally Binding - Read Full Terms Above)</h2>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}><strong>In plain English:</strong></p>

            <p style={{ marginBottom: '0.5rem', lineHeight: '1.7' }}><strong>✅ You can:</strong></p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Play games and have fun</li>
              <li>Chat with other players respectfully</li>
              <li>Report violations</li>
              <li>Change your username (with limits)</li>
              <li>Request your data or delete your account</li>
            </ul>

            <p style={{ marginBottom: '0.5rem', lineHeight: '1.7' }}><strong>❌ You cannot:</strong></p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Be hateful, abusive, or harass others</li>
              <li>Cheat or exploit bugs</li>
              <li>Post illegal or age-inappropriate content</li>
              <li>Impersonate staff or other users</li>
              <li>Lie about your age</li>
              <li>Evade bans</li>
            </ul>

            <p style={{ marginBottom: '0.5rem', lineHeight: '1.7' }}><strong>⚖️ We will:</strong></p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Review reports within 24 hours</li>
              <li>Be transparent about moderation actions</li>
              <li>Protect child users with enhanced safety</li>
              <li>Respect your privacy and data rights</li>
              <li>Give you a chance to appeal (except for severe violations)</li>
            </ul>

            <p style={{ marginBottom: '0.5rem', lineHeight: '1.7' }}><strong>🚫 We can:</strong></p>
            <ul style={{ marginLeft: '1.5rem', marginBottom: '1rem', lineHeight: '1.7' }}>
              <li>Remove content or ban accounts for violations</li>
              <li>Update these Terms with notice</li>
              <li>Report illegal content to authorities</li>
            </ul>

            <p style={{ marginBottom: '1rem', lineHeight: '1.7' }}>
              <strong>If you break the rules, we'll take action. Serious violations = serious consequences.</strong>
            </p>
            <p style={{ marginBottom: '0', lineHeight: '1.7' }}>
              <strong>Still have questions? Read the full Terms above or contact us.</strong>
            </p>
          </section>

          <div style={{ textAlign: 'center', padding: '2rem 0', borderTop: '1px solid var(--border)' }}>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7', fontWeight: '600' }}>
              By using Quiet Terminal Interactive, you agree to these Terms of Service.
            </p>
            <p style={{ marginBottom: '1rem', lineHeight: '1.7', fontWeight: '600' }}>
              Effective Date: January 10, 2025
            </p>
            <p style={{ marginBottom: '0', lineHeight: '1.7', fontSize: '0.9rem', fontStyle: 'italic', color: 'var(--text-secondary)' }}>
              These Terms are provided in good faith to protect our community and comply with UK law. They are not intended to restrict your rights under applicable law. If you have concerns about any provision, please contact us.
            </p>
          </div>
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

export default Terms;
