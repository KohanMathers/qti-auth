import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

function useQuery() {
    return new URLSearchParams(useLocation().search);
}

function AgeVerify({ setUser }) {
    const query = useQuery();
    const navigate = useNavigate();
    const [dob, setDob] = useState('');
    const [status, setStatus] = useState('idle');
    const [message, setMessage] = useState('');

    useEffect(() => {
        // The temp token is issued during OAuth flows for underage users.
        const token = query.get('temp_token');
        if (!token) {
            setStatus('error');
            setMessage('No temp token provided');
        }
    }, []);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setStatus('loading');
        setMessage('');

        const temp_token = query.get('temp_token');
        try {
            const res = await fetch(`${import.meta.env.VITE_API_URL}/auth/age/verify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ temp_token, date_of_birth: dob }),
            });

            const data = await res.json();

            if (!res.ok) {
                setStatus('error');
                setMessage(data.error || 'Verification failed');
                return;
            }

            if (data.token) {
                localStorage.setItem('qti_token', data.token);
            }

            if (data.user) {
                setUser && setUser(data.user);
                localStorage.setItem('qti_temp_user', JSON.stringify(data.user));
            }

            if (data.needs_username) {
                if (data.token) localStorage.setItem('qti_token', data.token);
                navigate('/claim-username');
                return;
            }

            setStatus('success');
            setMessage('Age verified — redirecting...');
            setTimeout(() => navigate('/dashboard'), 1000);
        } catch (err) {
            setStatus('error');
            setMessage('Network error. Please try again.');
        }
    };

    return (
        <div className="auth-container">
            <div className="auth-box">
                <h1>Age Verification</h1>
                <p className={status === 'error' ? 'error-message' : 'message'}>{message}</p>

                <form onSubmit={handleSubmit}>
                    <div className="form-group">
                        <label htmlFor="dob">Date of Birth</label>
                        <input
                            id="dob"
                            type="date"
                            value={dob}
                            onChange={(e) => setDob(e.target.value)}
                            required
                            max={new Date().toISOString().split('T')[0]}
                        />
                    </div>

                    <button type="submit" className="btn-primary">Verify Age</button>
                </form>
            </div>
        </div>
    );
}

export default AgeVerify;
