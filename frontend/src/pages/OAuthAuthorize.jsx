import React, { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle';

function OAuthAuthorize({ user }) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [clientInfo, setClientInfo] = useState(null);
  const [scopes, setScopes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const clientId = searchParams.get('client_id');
  const redirectUri = searchParams.get('redirect_uri');
  const scope = searchParams.get('scope') || 'openid';
  const state = searchParams.get('state');
  const codeChallenge = searchParams.get('code_challenge');
  const codeChallengeMethod = searchParams.get('code_challenge_method');
  const nonce = searchParams.get('nonce');

  useEffect(() => {
    const fetchClientInfo = async () => {
      const token = localStorage.getItem('qti_token');

      try {
        const res = await fetch(
          `${import.meta.env.VITE_API_URL}/oauth/authorize/client-info?client_id=${encodeURIComponent(clientId)}&scope=${encodeURIComponent(scope)}`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
            },
          }
        );

        const data = await res.json();

        if (res.ok) {
          setClientInfo(data.client);
          setScopes(data.scopes);
        } else {
          setError(data.error || 'Failed to load application info');
        }
      } catch (err) {
        setError('Network error. Please try again.');
      } finally {
        setLoading(false);
      }
    };

    if (clientId) {
      fetchClientInfo();
    } else {
      setError('Missing client_id parameter');
      setLoading(false);
    }
  }, [clientId, scope]);

  const handleConsent = async (allow) => {
    setSubmitting(true);
    const token = localStorage.getItem('qti_token');

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/oauth/authorize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          client_id: clientId,
          redirect_uri: redirectUri,
          scope,
          state,
          code_challenge: codeChallenge,
          code_challenge_method: codeChallengeMethod,
          nonce,
          consent: allow ? 'allow' : 'deny',
        }),
      });

      const data = await res.json();

      if (data.redirect) {
        window.location.href = data.redirect;
      } else {
        setError(data.error_description || data.error || 'Authorization failed');
        setSubmitting(false);
      }
    } catch (err) {
      setError('Network error. Please try again.');
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="auth-container">
        <ThemeToggle />
        <div className="auth-box">
          <div className="spinner"></div>
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="auth-container">
        <ThemeToggle />
        <div className="auth-box">
          <h1>Authorization Error</h1>
          <div className="error-message">{error}</div>
          <button onClick={() => navigate('/dashboard')} className="btn-secondary">
            Return to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-container">
      <ThemeToggle />
      <div className="auth-box oauth-consent">
        <h1>Authorize Application</h1>

        <div className="client-info">
          {clientInfo.logo_url && (
            <img src={clientInfo.logo_url} alt={clientInfo.name} className="client-logo" />
          )}
          <h2>{clientInfo.name}</h2>
          {clientInfo.description && (
            <p className="client-description">{clientInfo.description}</p>
          )}
        </div>

        <div className="consent-details">
          <p>
            <strong>{clientInfo.name}</strong> wants to access your QTI account
          </p>

          <div className="scopes-list">
            <p>This application will be able to:</p>
            <ul>
              {scopes.map((s) => (
                <li key={s.name}>
                  <span className="scope-icon">&#10003;</span>
                  {s.description}
                </li>
              ))}
            </ul>
          </div>

          <div className="account-info">
            <p>Signed in as: <strong>{user?.username_original || user?.email}</strong></p>
          </div>
        </div>

        <div className="consent-actions">
          <button
            onClick={() => handleConsent(false)}
            className="btn-secondary"
            disabled={submitting}
          >
            Deny
          </button>
          <button
            onClick={() => handleConsent(true)}
            className="btn-primary"
            disabled={submitting}
          >
            {submitting ? 'Authorizing...' : 'Allow'}
          </button>
        </div>

        {clientInfo.homepage_url && (
          <p className="client-links">
            <a href={clientInfo.homepage_url} target="_blank" rel="noopener noreferrer">
              Visit website
            </a>
            {clientInfo.privacy_policy_url && (
              <>
                {' | '}
                <a href={clientInfo.privacy_policy_url} target="_blank" rel="noopener noreferrer">
                  Privacy policy
                </a>
              </>
            )}
          </p>
        )}

        <p className="legal-text">
          By clicking "Allow", you authorize this application to access your account information
          according to their terms of service. You can revoke access at any time from your{' '}
          <a href="/dashboard">account settings</a>.
        </p>
      </div>
    </div>
  );
}

export default OAuthAuthorize;
