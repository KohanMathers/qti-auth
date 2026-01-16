import React from 'react';
import { Link } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle';
import AuthForm from '../components/AuthForm';

function Signup() {
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
