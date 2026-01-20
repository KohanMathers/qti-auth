import React from 'react';

function CategoryNav({ categories, activeSlug, onSelect }) {
  return (
    <div className="category-nav">
      <button
        type="button"
        className={activeSlug ? '' : 'active'}
        onClick={() => onSelect(null)}
      >
        All
      </button>
      {categories.map((category) => (
        <button
          key={category.id || category.slug}
          type="button"
          className={activeSlug === category.slug ? 'active' : ''}
          onClick={() => onSelect(category.slug)}
        >
          {category.name}
        </button>
      ))}
    </div>
  );
}

export default CategoryNav;
