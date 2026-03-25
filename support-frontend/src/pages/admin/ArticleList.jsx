import React from 'react';
import { Link } from 'react-router-dom';
import { apiDelete, apiGet, apiPut } from '../../lib/api';

function ArticleList() {
  const [articles, setArticles] = React.useState([]);
  const [search, setSearch] = React.useState('');
  const [query, setQuery] = React.useState('');
  const [published, setPublished] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [actionError, setActionError] = React.useState('');
  const [actionLoading, setActionLoading] = React.useState(false);

  const loadArticles = React.useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set('search', query.trim());
      if (published !== '') params.set('published', published);
      const data = await apiGet(`/kb/admin/articles?${params.toString()}`);
      setArticles(data.articles || []);
    } catch (err) {
      setError(err.message || 'Failed to load articles.');
    } finally {
      setLoading(false);
    }
  }, [query, published]);

  React.useEffect(() => {
    loadArticles();
  }, [loadArticles]);

  const handleSearch = (event) => {
    event.preventDefault();
    setQuery(search);
  };

  const handleTogglePublish = async (article) => {
    setActionLoading(true);
    setActionError('');
    try {
      await apiPut(`/kb/articles/${article.id}`, { is_published: !article.is_published });
      await loadArticles();
    } catch (err) {
      setActionError(err.message || 'Failed to update article.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDelete = async (article) => {
    const confirmed = window.confirm(`Delete "${article.title}"? This cannot be undone.`);
    if (!confirmed) return;
    setActionLoading(true);
    setActionError('');
    try {
      await apiDelete(`/kb/articles/${article.id}`);
      await loadArticles();
    } catch (err) {
      setActionError(err.message || 'Failed to delete article.');
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <section className="page-card">
      <div className="section-header">
        <div>
          <h1>Article Management</h1>
          <p>Draft, edit, and publish knowledge base articles.</p>
        </div>
        <Link className="pill primary" to="/admin/articles/new">New Article</Link>
      </div>

      <form className="queue-filters" onSubmit={handleSearch}>
        <input
          type="search"
          placeholder="Search title or slug"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select value={published} onChange={(event) => setPublished(event.target.value)}>
          <option value="">All</option>
          <option value="true">Published</option>
          <option value="false">Draft</option>
        </select>
        <button className="pill" type="submit">Filter</button>
      </form>

      {error ? <p className="form-error">{error}</p> : null}
      {actionError ? <p className="form-error">{actionError}</p> : null}
      {loading ? <p className="muted">Loading articles...</p> : null}

      {!loading ? (
        <div className="article-admin-list">
          {articles.map((article) => (
            <div key={article.id} className="article-admin-card">
              <div>
                <h3>{article.title}</h3>
                <p className="muted">{article.slug} • {article.category}</p>
              </div>
              <div className="article-admin-actions">
                <span className={`ticket-status ${article.is_published ? 'resolved' : 'closed'}`}>
                  {article.is_published ? 'published' : 'draft'}
                </span>
                <Link className="pill" to={`/admin/articles/${article.id}/edit`}>Edit</Link>
                <button
                  type="button"
                  className="pill"
                  onClick={() => handleTogglePublish(article)}
                  disabled={actionLoading}
                >
                  {article.is_published ? 'Unpublish' : 'Publish'}
                </button>
                <button
                  type="button"
                  className="pill danger"
                  onClick={() => handleDelete(article)}
                  disabled={actionLoading}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
          {articles.length === 0 ? <p className="muted">No articles found.</p> : null}
        </div>
      ) : null}
    </section>
  );
}

export default ArticleList;
