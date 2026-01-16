import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle';

function ClaimUsername({ user, setUser }) {
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    // If redirected from OAuth with a token in query, store it and try to fetch /me
    const params = new URLSearchParams(location.search);
    const tokenParam = params.get('token');
    const existing = localStorage.getItem('qti_token');

    if (!existing && tokenParam) {
      localStorage.setItem('qti_token', tokenParam);
      fetch(`${import.meta.env.VITE_API_URL}/me`, {
        headers: { 'Authorization': `Bearer ${tokenParam}` },
      })
        .then(r => r.json())
        .then(data => {
          if (data.user) {
            setUser && setUser(data.user);
          } else {
            // If /me didn't return a user, do NOT immediately bounce to login.
            // Some environments may have timing/CORS/cookie propagation issues —
            // allow the user to continue and submit a username using the token
            // stored in localStorage.
            console.warn('Could not fetch /me after OAuth redirect; continuing to claim username.');
          }
        })
        .catch((err) => {
          console.warn('Error fetching /me after OAuth redirect:', err);
          // Don't redirect to login; let the user proceed with the token.
        });
    } else if (!existing && !tokenParam) {
      // No token and no user -> redirect to login
      navigate('/login');
    }
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setChecking(true);

    const token = localStorage.getItem('qti_token');

    try {
      const res = await fetch(`${import.meta.env.VITE_API_URL}/username/claim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ username }),
      });

      const data = await res.json();

      if (res.ok) {
        // Update user state with username
        setUser({ ...user, username_original: data.username });
        navigate('/dashboard');
      } else {
        setError(data.error);
      }
    } catch (err) {
      setError('Network error. Please try again.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="auth-container">
      <ThemeToggle />
      <div className="auth-box">
        <h1>Choose Your Username</h1>
        <p className="subtitle">This will be your identity across all QTI games.</p>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="username">Username</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              placeholder="YourUsername"
              minLength={8}
              maxLength={18}
              pattern="[A-Za-z0-9_]+"
              autoFocus
            />
            <div className="username-rules">
              <p className="rule">✓ 8-18 characters</p>
              <p className="rule">✓ Letters, numbers, and underscores only</p>
              <p className="rule">✓ Cannot start with QTI_ (reserved for admins)</p>
            </div>
          </div>

          {error && <div className="error-message">{error}</div>}

          <button type="submit" className="btn-primary" disabled={checking}>
            {checking ? 'Checking...' : 'Claim Username'}
          </button>
        </form>

        <div className="info-box">
          <h3>Important</h3>
          <p>You can change your username later, but there are limits:</p>
          <ul>
            <li>30-day cooldown between changes</li>
            <li>Maximum 3 changes per year</li>
            <li>Username history is tracked for security</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

export default ClaimUsername;
