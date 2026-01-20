import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { apiGet } from '../lib/api';
import ArticleCard from '../components/ArticleCard';

function CategoryView() {
  const { slug } = useParams();
  const [category, setCategory] = React.useState(null);
  const [articles, setArticles] = React.useState([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let isMounted = true;

    async function loadCategory() {
      setLoading(true);
      try {
        const [categoryData, articleData] = await Promise.all([
          apiGet('/kb/categories'),
          apiGet(`/kb/articles?category=${encodeURIComponent(slug)}&limit=100`),
        ]);
        if (!isMounted) return;
        const matched = (categoryData.categories || []).find((item) => item.slug === slug);
        setCategory(matched || null);
        setArticles(articleData.articles || []);
      } catch (error) {
        console.error('Failed to load category:', error);
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    loadCategory();
    return () => { isMounted = false; };
  }, [slug]);

  return (
    <section className="page-card">
      <div className="section-header">
        <div>
          <h1>{category ? category.name : 'Category'}</h1>
          <p>{category?.description || 'Articles in this category.'}</p>
        </div>
        <Link className="pill" to="/kb">Back to Knowledge Base</Link>
      </div>
      {loading ? (
        <p className="muted">Loading articles...</p>
      ) : (
        <div className="article-grid">
          {articles.map((article) => (
            <ArticleCard key={article.id} article={article} />
          ))}
          {articles.length === 0 ? (
            <p className="muted">No articles published in this category yet.</p>
          ) : null}
        </div>
      )}
    </section>
  );
}

export default CategoryView;
