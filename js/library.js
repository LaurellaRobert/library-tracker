/**
 * Library browse & search module.
 * Renders the book grid and handles filtering.
 */

const Library = (() => {
  let allBooks = [];
  const PLACEHOLDER_COVER = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300" fill="%23e7e5e4">' +
    '<rect width="200" height="300"/>' +
    '<text x="100" y="155" text-anchor="middle" fill="%23a8a29e" font-family="sans-serif" font-size="14">No cover</text>' +
    '</svg>'
  );

  /**
   * Load all books from Supabase and render.
   */
  async function load() {
    try {
      allBooks = await db.getAll();
      render(allBooks);
    } catch (err) {
      console.error('Failed to load library:', err);
    }
  }

  /**
   * Search/filter and re-render.
   */
  async function filter(query, owner) {
    try {
      const results = await db.search(query, owner);
      render(results);
    } catch (err) {
      console.error('Search error:', err);
    }
  }

  /**
   * Add a book to the local cache and re-render (avoids a full reload).
   */
  function addLocal(book) {
    allBooks.unshift(book);
    render(allBooks);
  }

  /**
   * Render book cards into the grid.
   */
  function render(books) {
    const grid     = document.getElementById('library-grid');
    const empty    = document.getElementById('library-empty');
    const noResult = document.getElementById('library-no-results');

    grid.innerHTML = '';

    if (allBooks.length === 0) {
      empty.hidden    = false;
      noResult.hidden = true;
      return;
    }

    empty.hidden = true;

    if (books.length === 0) {
      noResult.hidden = false;
      return;
    }

    noResult.hidden = true;

    const fragment = document.createDocumentFragment();

    books.forEach((book) => {
      const card = document.createElement('div');
      card.className = 'book-card';
      card.innerHTML = `
        <img class="book-card-cover"
             src="${book.cover_url || PLACEHOLDER_COVER}"
             alt="${escapeHtml(book.title)}"
             loading="lazy"
             onerror="this.src='${PLACEHOLDER_COVER}'">
        <div class="book-card-info">
          <div class="book-card-title">${escapeHtml(book.title)}</div>
          <div class="book-card-author">${escapeHtml(book.author || 'Unknown author')}</div>
          <span class="book-card-owner">${escapeHtml(book.owner)}</span>
        </div>
      `;
      fragment.appendChild(card);
    });

    grid.appendChild(fragment);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  return { load, filter, addLocal };
})();
