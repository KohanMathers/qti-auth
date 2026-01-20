import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiGet, apiPost } from '../lib/api';
import MarkdownRenderer from '../components/MarkdownRenderer';
import ArticleCard from '../components/ArticleCard';

function ArticleView() {
  const { slug } = useParams();
  const [article, setArticle] = React.useState(null);
  const [related, setRelated] = React.useState([]);
  const [feedback, setFeedback] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    let isMounted = true;

    async function loadArticle() {
      setLoading(true);
      setError('');
      try {
        const data = await apiGet(`/kb/articles/${encodeURIComponent(slug)}`);
        if (!isMounted) return;
        setArticle(data.article);

        if (data.article?.category) {
          const relatedData = await apiGet(`/kb/articles?category=${encodeURIComponent(data.article.category)}&limit=4`);
          if (!isMounted) return;
          const filtered = (relatedData.articles || []).filter((item) => item.slug !== slug);
          setRelated(filtered);
        } else {
          setRelated([]);
        }
      } catch (err) {
        console.error('Failed to load article:', err);
        if (isMounted) setError('Unable to load this article.');
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    loadArticle();
    return () => { isMounted = false; };
  }, [slug]);

  const handleFeedback = async (helpful) => {
    if (!article || feedback !== null) return;
    try {
      await apiPost(`/kb/articles/${article.id}/feedback`, { helpful });
      setFeedback(helpful);
    } catch (err) {
      console.error('Failed to record feedback:', err);
    }
  };

  if (loading) {
    return (
      <section className="page-card">
        <p className="muted">Loading article...</p>
      </section>
    );
  }

  if (error || !article) {
    return (
      <section className="page-card">
        <h1>Article not found</h1>
        <p>{error || 'This article may have been removed.'}</p>
        <Link className="pill" to="/kb">Back to Knowledge Base</Link>
      </section>
    );
  }

  return (
    <div className="article-layout">
      <article className="page-card article-body">
        <div className="article-meta">
          <span>{article.category}</span>
          <span>Updated {new Date(article.updated_at * 1000).toLocaleDateString()}</span>
        </div>
        <h1>{article.title}</h1>
        <MarkdownRenderer content={article.content} />
        <div className="feedback-panel">
          <p>Was this helpful?</p>
          <div className="feedback-actions">
            <button
              type="button"
              className={feedback === true ? 'active' : ''}
              onClick={() => handleFeedback(true)}
            >
              Yes
            </button>
            <button
              type="button"
              className={feedback === false ? 'active' : ''}
              onClick={() => handleFeedback(false)}
            >
              No
            </button>
          </div>
          {feedback !== null ? <span className="muted">Thanks for the feedback.</span> : null}
        </div>
      </article>

      <aside className="article-sidebar">
        <div className="page-card">
          <h2>Need more help?</h2>
          <p>Submit a ticket and our staff will respond directly.</p>
          <Link className="pill primary" to="/tickets/new">Submit Ticket</Link>
        </div>
        {related.length > 0 ? (
          <div className="page-card">
            <h2>Related articles</h2>
            <div className="related-list">
              {related.map((item) => (
                <ArticleCard key={item.id} article={item} />
              ))}
            </div>
          </div>
        ) : null}
      </aside>
    </div>
  );
}

export default ArticleView;
