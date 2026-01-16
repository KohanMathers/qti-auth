import React from 'react';
import { Link } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle';
import AuthForm from '../components/AuthForm';

function Login() {
  return (
    <div className="auth-container">
      <ThemeToggle />
      <div className="auth-box">
        <h1>QTI Auth</h1>
        <p className="subtitle">Log in to your QTI account</p>

        <AuthForm isSignup={false} />

        <p className="footer-text">
          Don't have an account? <Link to="/signup">Sign up</Link>
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

export default Login;
