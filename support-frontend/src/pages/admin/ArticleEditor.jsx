import React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { apiGet, apiPost, apiPut } from '../../lib/api';
import MarkdownRenderer from '../../components/MarkdownRenderer';

function ArticleEditor({ user }) {
  const navigate = useNavigate();
  const { id } = useParams();
  const isEditing = Boolean(id);
  const [title, setTitle] = React.useState('');
  const [slug, setSlug] = React.useState('');
  const [category, setCategory] = React.useState('');
  const [tags, setTags] = React.useState('');
  const [content, setContent] = React.useState('');
  const [isPublished, setIsPublished] = React.useState(false);
  const [loading, setLoading] = React.useState(isEditing);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    if (!isEditing) return;
    let isMounted = true;

    async function loadArticle() {
      setLoading(true);
      setError('');
      try {
        const data = await apiGet(`/kb/admin/articles/${id}`);
        const article = data.article;
        if (isMounted && article) {
          let tagValue = '';
          try {
            tagValue = article.tags ? JSON.parse(article.tags).join(', ') : '';
          } catch (parseError) {
            tagValue = '';
          }
          setTitle(article.title || '');
          setSlug(article.slug || '');
          setCategory(article.category || '');
          setTags(tagValue);
          setContent(article.content || '');
          setIsPublished(Boolean(article.is_published));
        }
      } catch (err) {
        if (isMounted) setError(err.message || 'Failed to load article.');
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    loadArticle();
    return () => { isMounted = false; };
  }, [id, isEditing]);

  const handleSave = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const tagList = tags.split(',').map((item) => item.trim()).filter(Boolean);
      const payload = {
        title,
        slug: slug || undefined,
        category,
        tags: tagList,
        content,
        is_published: isPublished,
      };
      if (isEditing) {
        await apiPut(`/kb/articles/${id}`, payload);
      } else {
        const data = await apiPost('/kb/articles', payload);
        navigate(`/admin/articles/${data.id}/edit`);
        return;
      }
      navigate('/admin/articles');
    } catch (err) {
      setError(err.message || 'Failed to save article.');
    } finally {
      setSaving(false);
    }
  };

  const handlePreviewSlug = () => {
    if (slug) return slug;
    return title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  };

  if (loading) {
    return (
      <section className="page-card">
        <p className="muted">Loading article...</p>
      </section>
    );
  }

  return (
    <section className="page-card article-editor">
      <div className="section-header">
        <div>
          <h1>{isEditing ? 'Edit Article' : 'New Article'}</h1>
          <p>Markdown content with live preview.</p>
        </div>
        <Link className="pill" to="/admin/articles">Back to list</Link>
      </div>

      {error ? <p className="form-error">{error}</p> : null}

      <form className="editor-form" onSubmit={handleSave}>
        <div className="field-row">
          <label htmlFor="title">Title</label>
          <input
            id="title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
          />
        </div>
        <div className="field-row">
          <label htmlFor="slug">Slug</label>
          <input
            id="slug"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            placeholder={handlePreviewSlug()}
          />
        </div>
        <div className="field-row">
          <label htmlFor="category">Category</label>
          <input
            id="category"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            required
          />
        </div>
        <div className="field-row">
          <label htmlFor="tags">Tags</label>
          <input
            id="tags"
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="auth, billing, bugs"
          />
        </div>
        <div className="field-row">
          <label htmlFor="content">Content (Markdown)</label>
          <textarea
            id="content"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={10}
            required
          />
        </div>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={isPublished}
            onChange={(event) => setIsPublished(event.target.checked)}
          />
          Publish immediately
        </label>
        <button className="pill primary" type="submit" disabled={saving}>
          {saving ? 'Saving...' : 'Save Article'}
        </button>
      </form>

      <div className="editor-preview">
        <h2>Live Preview</h2>
        <div className="page-card">
          <div className="article-meta">
            <span>{category || 'category'}</span>
            <span>{isPublished ? 'Published' : 'Draft'}</span>
          </div>
          <h1>{title || 'Article title'}</h1>
          <MarkdownRenderer content={content} />
          <p className="muted">Slug: {handlePreviewSlug() || 'slug'}</p>
        </div>
      </div>
    </section>
  );
}

export default ArticleEditor;
