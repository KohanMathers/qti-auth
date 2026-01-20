import React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { handleCallback } from '../lib/auth';

export default function OAuthCallback({ onLoginSuccess }) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = React.useState(null);

  React.useEffect(() => {
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const errorParam = searchParams.get('error');
    const errorDescription = searchParams.get('error_description');

    if (errorParam) {
      setError(errorDescription || errorParam);
      return;
    }

    if (!code || !state) {
      setError('Missing authorization code or state');
      return;
    }

    handleCallback(code, state)
      .then(({ redirectPath }) => {
        onLoginSuccess();
        navigate(redirectPath, { replace: true });
      })
      .catch((err) => {
        setError(err.message);
      });
  }, [searchParams, navigate, onLoginSuccess]);

  if (error) {
    return (
      <section className="page-card">
        <h1>Login Failed</h1>
        <p className="error-text">{error}</p>
        <a href="/" className="pill">Return to Home</a>
      </section>
    );
  }

  return (
    <section className="page-card">
      <p className="muted">Completing login...</p>
    </section>
  );
}
