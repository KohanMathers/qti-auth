import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { apiGet } from '../lib/api';
import SearchBar from '../components/SearchBar';
import CategoryNav from '../components/CategoryNav';
import ArticleCard from '../components/ArticleCard';

function KnowledgeBase() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = React.useMemo(() => new URLSearchParams(location.search), [location.search]);
  const query = params.get('search') || '';
  const category = params.get('category') || '';
  const [search, setSearch] = React.useState(query);
  const [sort, setSort] = React.useState('newest');
  const [articles, setArticles] = React.useState([]);
  const [categories, setCategories] = React.useState([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    setSearch(query);
  }, [query]);

  React.useEffect(() => {
    let isMounted = true;

    async function loadData() {
      setLoading(true);
      try {
        const articleParams = new URLSearchParams();
        if (query) articleParams.set('search', query);
        if (category) articleParams.set('category', category);
        articleParams.set('limit', '100');

        const [articleData, categoryData] = await Promise.all([
          apiGet(`/kb/articles?${articleParams.toString()}`),
          apiGet('/kb/categories'),
        ]);

        if (!isMounted) return;
        setArticles(articleData.articles || []);
        setCategories(categoryData.categories || []);
      } catch (error) {
        console.error('Failed to load KB data:', error);
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    loadData();
    return () => { isMounted = false; };
  }, [query, category]);

  const sortedArticles = React.useMemo(() => {
    const list = [...articles];
    if (sort === 'most_viewed') {
      return list.sort((a, b) => b.view_count - a.view_count);
    }
    if (sort === 'most_helpful') {
      return list.sort((a, b) => b.helpful_yes - a.helpful_yes);
    }
    return list.sort((a, b) => b.updated_at - a.updated_at);
  }, [articles, sort]);

  const handleSearch = (event) => {
    event.preventDefault();
    const searchParams = new URLSearchParams(location.search);
    if (search.trim()) {
      searchParams.set('search', search.trim());
    } else {
      searchParams.delete('search');
    }
    navigate(`/kb?${searchParams.toString()}`);
  };

  const handleCategory = (slug) => {
    const searchParams = new URLSearchParams(location.search);
    if (slug) {
      searchParams.set('category', slug);
    } else {
      searchParams.delete('category');
    }
    navigate(`/kb?${searchParams.toString()}`);
  };

  return (
    <section className="page-card">
      <div className="kb-header">
        <div>
          <h1>Knowledge Base</h1>
          <p>Guides, fixes, and product updates curated by the QTI team.</p>
        </div>
        <div className="kb-controls">
          <SearchBar
            value={search}
            onChange={setSearch}
            onSubmit={handleSearch}
            placeholder="Search for answers"
          />
          <div className="select-row">
            <label htmlFor="sort">Sort by</label>
            <select id="sort" value={sort} onChange={(event) => setSort(event.target.value)}>
              <option value="newest">Newest updates</option>
              <option value="most_viewed">Most viewed</option>
              <option value="most_helpful">Most helpful</option>
            </select>
          </div>
        </div>
      </div>

      <CategoryNav
        categories={categories}
        activeSlug={category}
        onSelect={handleCategory}
      />

      {loading ? (
        <p className="muted">Loading articles...</p>
      ) : (
        <div className="article-grid">
          {sortedArticles.map((article) => (
            <ArticleCard key={article.id} article={article} />
          ))}
          {sortedArticles.length === 0 ? (
            <p className="muted">No articles match your search.</p>
          ) : null}
        </div>
      )}
    </section>
  );
}

export default KnowledgeBase;
