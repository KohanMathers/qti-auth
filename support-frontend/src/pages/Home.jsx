import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { apiGet } from '../lib/api';
import SearchBar from '../components/SearchBar';
import ArticleCard from '../components/ArticleCard';
import { SUPPORT_BRANDING } from '../config/branding';

function Home() {
  const navigate = useNavigate();
  const [search, setSearch] = React.useState('');
  const [categories, setCategories] = React.useState([]);
  const [articles, setArticles] = React.useState([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let isMounted = true;

    async function loadContent() {
      try {
        const [categoryData, articleData] = await Promise.all([
          apiGet('/kb/categories'),
          apiGet('/kb/articles?limit=6'),
        ]);
        if (!isMounted) return;
        setCategories(categoryData.categories || []);
        setArticles(articleData.articles || []);
      } catch (error) {
        console.error('Failed to load support home:', error);
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    loadContent();
    return () => { isMounted = false; };
  }, []);

  const handleSearch = (event) => {
    event.preventDefault();
    const query = search.trim();
    navigate(query ? `/kb?search=${encodeURIComponent(query)}` : '/kb');
  };

  return (
    <div className="home-layout">
      <section className="hero-card">
        <div className="hero-content">
          <span className="hero-kicker">{SUPPORT_BRANDING.supportTitle} Desk</span>
          <h1>How can we help?</h1>
          <p>Search the knowledge base or submit a ticket to reach the support team.</p>
          <SearchBar
            value={search}
            onChange={setSearch}
            onSubmit={handleSearch}
            placeholder="Search support articles and policies"
          />
          <div className="hero-actions">
            <Link className="pill primary" to="/tickets/new">Submit Ticket</Link>
            <Link className="pill" to="/kb">Browse Knowledge Base</Link>
          </div>
        </div>
        <div className="hero-panel">
          <div className="hero-panel-card">
            <strong>Popular categories</strong>
            <div className="chip-grid">
              {categories.slice(0, 6).map((category) => (
                <Link key={category.id || category.slug} to={`/kb/category/${category.slug}`}>
                  {category.name}
                </Link>
              ))}
              {!loading && categories.length === 0 ? (
                <span className="muted-chip">No categories yet</span>
              ) : null}
            </div>
          </div>
          <div className="hero-panel-card">
            <strong>Need direct help?</strong>
            <p>We reply to tickets every day. Include as many details as you can.</p>
            <Link className="pill primary" to="/tickets/new">Start a ticket</Link>
          </div>
        </div>
      </section>

      <section className="page-card">
        <div className="section-header">
          <div>
            <h2>Featured articles</h2>
            <p>Fresh answers from the {SUPPORT_BRANDING.supportTitle} team.</p>
          </div>
          <Link className="pill" to="/kb">See all</Link>
        </div>
        {loading ? (
          <p className="muted">Loading articles...</p>
        ) : (
          <div className="article-grid">
            {articles.map((article) => (
              <ArticleCard key={article.id} article={article} />
            ))}
            {articles.length === 0 ? <p className="muted">No published articles yet.</p> : null}
          </div>
        )}
      </section>
    </div>
  );
}

export default Home;
