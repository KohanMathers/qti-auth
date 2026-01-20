import React from 'react';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api';
import ArticleCard from '../components/ArticleCard';

const CATEGORIES = [
  { value: 'account', label: 'Account' },
  { value: 'bug', label: 'Bug' },
  { value: 'billing', label: 'Billing' },
  { value: 'feature', label: 'Feature Request' },
  { value: 'other', label: 'Other' },
];

const PRIORITIES = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

function SubmitTicket({ user }) {
  const navigate = useNavigate();
  const [subject, setSubject] = React.useState('');
  const [category, setCategory] = React.useState(CATEGORIES[0].value);
  const [priority, setPriority] = React.useState('normal');
  const [message, setMessage] = React.useState('');
  const [error, setError] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [suggested, setSuggested] = React.useState([]);

  React.useEffect(() => {
    if (!subject.trim()) {
      setSuggested([]);
      return undefined;
    }

    const timeout = setTimeout(async () => {
      try {
        const data = await apiGet(`/kb/articles?search=${encodeURIComponent(subject.trim())}&limit=3`);
        setSuggested(data.articles || []);
      } catch (err) {
        console.error('Failed to load suggested articles:', err);
      }
    }, 400);

    return () => clearTimeout(timeout);
  }, [subject]);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      const data = await apiPost('/support/tickets', {
        subject,
        category,
        priority,
        message,
      });
      navigate(`/tickets/${data.id}`);
    } catch (err) {
      setError(err.message || 'Failed to submit ticket.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="page-card">
      <div className="section-header">
        <div>
          <h1>Submit a Ticket</h1>
          <p>Tell us what is happening and the support team will respond.</p>
        </div>
        {user ? <span className="muted">Signed in as {user.username_original || user.email}</span> : null}
      </div>

      <form className="ticket-form" onSubmit={handleSubmit}>
        <div className="field-row">
          <label htmlFor="subject">Subject</label>
          <input
            id="subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            placeholder="Summarize the issue"
            required
          />
        </div>
        <div className="field-row">
          <label htmlFor="category">Category</label>
          <select id="category" value={category} onChange={(event) => setCategory(event.target.value)}>
            {CATEGORIES.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        </div>
        <div className="field-row">
          <label htmlFor="priority">Priority</label>
          <select id="priority" value={priority} onChange={(event) => setPriority(event.target.value)}>
            {PRIORITIES.map((item) => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        </div>
        <div className="field-row">
          <label htmlFor="message">Description</label>
          <textarea
            id="message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Include steps to reproduce, screenshots, or URLs."
            rows={6}
            required
          />
        </div>
        {error ? <p className="form-error">{error}</p> : null}
        <button className="pill primary" type="submit" disabled={submitting}>
          {submitting ? 'Submitting...' : 'Submit Ticket'}
        </button>
      </form>

      {suggested.length > 0 ? (
        <div className="suggested-articles">
          <h2>Suggested articles</h2>
          <div className="article-grid">
            {suggested.map((article) => (
              <ArticleCard key={article.id} article={article} />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

export default SubmitTicket;
