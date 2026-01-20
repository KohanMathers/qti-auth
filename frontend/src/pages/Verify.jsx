import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

function useQuery() {
    return new URLSearchParams(useLocation().search);
}

function Verify({ setUser }) {
    const query = useQuery();
    const navigate = useNavigate();
    const [status, setStatus] = useState('verifying');
    const [message, setMessage] = useState('Verifying...');

    useEffect(() => {
        const token = query.get('token');
        const consumeRedirect = () => {
            const target = localStorage.getItem('post_login_redirect') || sessionStorage.getItem('post_login_redirect');
            if (target) {
                localStorage.removeItem('post_login_redirect');
                sessionStorage.removeItem('post_login_redirect');
                return target;
            }
            return null;
        };
        const ensureSessionCookie = async (authToken) => {
            if (!authToken) return;
            try {
                await fetch(`${import.meta.env.VITE_API_URL}/auth/session`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${authToken}` },
                    credentials: 'include',
                });
            } catch (e) {
            }
        };

        // Guard against duplicate verifies on re-renders or back/forward cache.
        const verifyKey = `verify_attempted_${token}`;
        if (sessionStorage.getItem(verifyKey)) {
            return;
        }
        sessionStorage.setItem(verifyKey, 'true');

        if (!token) {
            setStatus('error');
            setMessage('No token provided');
            setTimeout(() => navigate('/login'), 2000);
            return;
        }

        // JWT from OAuth vs UUID from magic link.
        if (token.startsWith('eyJ')) {
            localStorage.setItem('qti_token', token);

            fetch(`${import.meta.env.VITE_API_URL}/me`, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            })
                .then(res => res.json())
                .then(data => {
                    if (data.user && setUser) {
                        setUser(data.user);
                    }
                })
                .catch(e => {
                    console.error('Failed to fetch user profile:', e);
                    try {
                        const payload = JSON.parse(atob(token.split('.')[1]));
                        if (setUser) {
                            setUser({
                                id: payload.user_id,
                                username: payload.username,
                                username_original: payload.username,
                                role: payload.role,
                                is_child: payload.is_child
                            });
                        }
                    } catch (err) {
                        console.error('Failed to decode JWT:', err);
                    }
                });

            setStatus('success');
            setMessage('Signed in successfully! Redirecting...');
            const redirectTarget = consumeRedirect();
            setTimeout(() => {
                if (redirectTarget) {
                    ensureSessionCookie(token).finally(() => {
                        window.location.href = redirectTarget;
                    });
                } else {
                    navigate('/dashboard');
                }
            }, 1000);
        } else {
            fetch(`${import.meta.env.VITE_API_URL}/auth/email/verify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token })
            })
                .then(res => res.json())
                .then(data => {
                    if (data.token) {
                        localStorage.setItem('qti_token', data.token);

                        fetch(`${import.meta.env.VITE_API_URL}/me`, {
                            method: 'GET',
                            headers: {
                                'Authorization': `Bearer ${data.token}`
                            }
                        })
                            .then(res => res.json())
                            .then(userData => {
                                if (userData.user && setUser) {
                                    setUser(userData.user);
                                }
                            })
                            .catch(e => {
                                console.error('Failed to fetch user profile:', e);
                            });

                        setStatus('success');
                        setMessage('Email verified! Redirecting...');
                        setTimeout(() => {
                            if (data.needs_username) {
                                navigate('/claim-username');
                            } else {
                                const redirectTarget = consumeRedirect();
                                if (redirectTarget) {
                                    ensureSessionCookie(data.token).finally(() => {
                                        window.location.href = redirectTarget;
                                    });
                                } else {
                                    navigate('/dashboard');
                                }
                            }
                        }, 1000);
                    } else {
                        setStatus('error');
                        setMessage(data.error || 'Verification failed');
                    }
                })
                .catch(err => {
                    setStatus('error');
                    setMessage('Failed to verify. Please try again.');
                });
        }
    }, [query, navigate]);


    return (
        <div className="auth-container">
            <div className="auth-box">
                <h1>Verification</h1>
                <p className={status === 'error' ? 'error-message' : 'message'}>{message}</p>
            </div>
        </div>
    );
}

export default Verify;
