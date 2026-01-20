import React from 'react';
import { Link } from 'react-router-dom';

function ArticleCard({ article }) {
  const viewCount = article.view_count ?? 0;
  const helpfulCount = article.helpful_yes ?? 0;
  const updatedAt = article.updated_at ? new Date(article.updated_at * 1000).toLocaleDateString() : 'N/A';

  return (
    <Link className="article-card" to={`/kb/${article.slug}`}>
      <div className="article-card-top">
        <span className="article-category">{article.category}</span>
        <span className="article-metric">{viewCount} views</span>
      </div>
      <h3>{article.title}</h3>
      {article.excerpt ? <p>{article.excerpt}</p> : null}
      <div className="article-card-bottom">
        <span>Updated {updatedAt}</span>
        <span>{helpfulCount} helpful</span>
      </div>
    </Link>
  );
}

export default ArticleCard;
