import React from 'react';

function SearchBar({ value, onChange, onSubmit, placeholder }) {
  return (
    <form className="search-bar" onSubmit={onSubmit}>
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder || 'Search articles'}
        aria-label="Search"
      />
      <button type="submit">Search</button>
    </form>
  );
}

export default SearchBar;
