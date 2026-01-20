import React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle';
import AuthForm from '../components/AuthForm';

function Signup() {
  const [searchParams] = useSearchParams();
  const redirect = searchParams.get('redirect');

  React.useEffect(() => {
    if (redirect) {
      localStorage.setItem('post_login_redirect', redirect);
    }

    const existingToken = localStorage.getItem('qti_token');
    if (!existingToken) {
      return;
    }

    fetch(`${import.meta.env.VITE_API_URL}/me`, {
      headers: { 'Authorization': `Bearer ${existingToken}` },
    })
      .then(res => res.json())
      .then(data => {
        if (data.user) {
          const target = localStorage.getItem('post_login_redirect');
          const redirectTarget = target || '/dashboard';

          fetch(`${import.meta.env.VITE_API_URL}/auth/session`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${existingToken}` },
            credentials: 'include',
          })
            .then(res => {
              if (res.ok) {
                if (target) {
                  localStorage.removeItem('post_login_redirect');
                }
                window.location.href = redirectTarget;
              } else {
                localStorage.removeItem('qti_token');
              }
            })
            .catch(() => {
              localStorage.removeItem('qti_token');
            });
        } else {
          localStorage.removeItem('qti_token');
        }
      })
      .catch(() => {
        localStorage.removeItem('qti_token');
      });
  }, [redirect]);

  return (
    <div className="auth-container">
      <ThemeToggle />
      <div className="auth-box">
        <h1>QTI Auth</h1>
        <p className="subtitle">Sign up for a QTI account</p>

        <AuthForm isSignup={true} />

        <p className="footer-text">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>

        <p className="legal-text">
          By continuing, you agree to our{' '}
          <a href="/terms" target="_blank">Terms of Service</a> and{' '}
          <a href="/privacy" target="_blank">Privacy Policy</a>
        </p>
      </div>
    </div>
  );
}

export default Signup;
