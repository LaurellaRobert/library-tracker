const Library = (() => {
  const VIEW_MODE_KEY = 'library-tracker-view-mode';
  const SORT_KEY      = 'library-tracker-sort';
  const SORT_DIR_KEY  = 'library-tracker-sort-dir';

  let allBooks     = [];
  let lastRendered = [];
  let viewMode     = localStorage.getItem(VIEW_MODE_KEY) || 'grid';
  let sortMode     = localStorage.getItem(SORT_KEY)      || 'added';
  let sortDir      = localStorage.getItem(SORT_DIR_KEY)  || 'asc';

  const PLACEHOLDER_COVER = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300" fill="%23e7e5e4">' +
    '<rect width="200" height="300"/>' +
    '<text x="100" y="155" text-anchor="middle" fill="%23a8a29e" font-family="sans-serif" font-size="14">No cover</text>' +
    '</svg>'
  );

  /* ---------- Sort helpers ---------- */

  function lastName(author) {
    if (!author) return '￿'; // sort unknowns to end
    const parts = author.trim().split(/\s+/);
    return parts[parts.length - 1].toLowerCase();
  }

  function extractYear(s) {
    if (!s) return 0;
    const m = String(s).match(/\d{4}/);
    return m ? parseInt(m[0], 10) : 0;
  }

  function sortBooks(books) {
    if (sortMode === 'added') return books;
    const d = sortDir === 'desc' ? -1 : 1;
    const arr = [...books];
    if (sortMode === 'title') {
      arr.sort((a, b) => d * (a.title || '').localeCompare(b.title || ''));
    } else if (sortMode === 'author') {
      arr.sort((a, b) => {
        const diff = lastName(a.author).localeCompare(lastName(b.author));
        return d * (diff !== 0 ? diff : (a.author || '').localeCompare(b.author || ''));
      });
    } else if (sortMode === 'year') {
      arr.sort((a, b) => {
        const diff = extractYear(a.publish_year) - extractYear(b.publish_year);
        return d * (diff !== 0 ? diff : (a.title || '').localeCompare(b.title || ''));
      });
    }
    return arr;
  }

  /* ---------- Data operations ---------- */

  async function load() {
    syncControls();
    render(allBooks);
    try {
      allBooks = await db.getAll();
      render(allBooks);
    } catch (err) {
      console.error('Failed to load library:', err);
    }
  }

  async function filter(query, owner) {
    try {
      const results = await db.search(query, owner);
      render(results);
    } catch (err) {
      console.error('Search error:', err);
    }
  }

  function addLocal(book) {
    allBooks.unshift(book);
    render(allBooks);
  }

  function removeLocal(id) {
    allBooks = allBooks.filter((b) => b.id !== id);
    render(allBooks);
  }

  function updateLocal(book) {
    const idx = allBooks.findIndex((b) => b.id === book.id);
    if (idx !== -1) allBooks[idx] = book;
    render(allBooks);
  }

  /* ---------- UI state ---------- */

  function setViewMode(mode) {
    viewMode = mode;
    localStorage.setItem(VIEW_MODE_KEY, mode);
    syncControls();
    render(lastRendered);
  }

  function setSort(mode) {
    sortMode = mode;
    sortDir  = 'asc';
    localStorage.setItem(SORT_KEY,     mode);
    localStorage.setItem(SORT_DIR_KEY, 'asc');
    syncControls();
    render(lastRendered);
  }

  function getViewMode() { return viewMode; }

  function syncControls() {
    const gridBtn = document.getElementById('btn-view-grid');
    const listBtn = document.getElementById('btn-view-list');
    const sortSel = document.getElementById('library-sort');
    if (gridBtn) gridBtn.classList.toggle('active', viewMode === 'grid');
    if (listBtn) listBtn.classList.toggle('active', viewMode === 'list');
    if (sortSel && sortSel.value !== sortMode) sortSel.value = sortMode;
  }

  /* ---------- Rendering ---------- */

  function render(books) {
    lastRendered = books;
    const toShow = sortBooks(books);

    const container = document.getElementById('library-grid');
    const empty     = document.getElementById('library-empty');
    const noResult  = document.getElementById('library-no-results');

    container.className = viewMode === 'list' ? 'library-list' : 'library-grid';
    container.innerHTML = '';

    if (allBooks.length === 0) {
      empty.hidden    = false;
      noResult.hidden = true;
      return;
    }

    empty.hidden = true;

    if (toShow.length === 0) {
      noResult.hidden = false;
      return;
    }

    noResult.hidden = true;

    const fragment = document.createDocumentFragment();

    if (viewMode === 'list') {
      // Column header row — buttons on sortable columns
      const header = document.createElement('div');
      header.className = 'list-header';
      const cols = [
        { label: 'Title',     sort: 'title'  },
        { label: 'Author',    sort: 'author' },
        { label: 'Published', sort: 'year'   },
        { label: 'Owner',     sort: null     },
      ];
      header.innerHTML = cols.map(({ label, sort }) => {
        const isActive = sort && sort === sortMode;
        const arrow = isActive
          ? `<span class="sort-arrow">${sortDir === 'asc' ? '↑' : '↓'}</span>`
          : '';
        if (sort) {
          return `<button class="list-header-cell${isActive ? ' active' : ''}" data-sort="${sort}">${label}${arrow}</button>`;
        }
        return `<span class="list-header-cell">${label}</span>`;
      }).join('');
      header.querySelectorAll('[data-sort]').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (btn.dataset.sort === sortMode) {
            // Same column — toggle direction
            sortDir = sortDir === 'asc' ? 'desc' : 'asc';
            localStorage.setItem(SORT_DIR_KEY, sortDir);
            render(lastRendered);
          } else {
            // Different column — switch field, reset to asc
            setSort(btn.dataset.sort);
          }
        });
      });
      fragment.appendChild(header);
    }

    toShow.forEach((book) => {
      const el = document.createElement('div');

      if (viewMode === 'list') {
        const year = extractYear(book.publish_year) || '—';
        el.className = 'book-list-item';
        el.innerHTML = `
          <span class="list-col-title">${escapeHtml(book.title)}</span>
          <span class="list-col-author">${escapeHtml(book.author || '—')}</span>
          <span class="list-col-year">${year}</span>
          <span class="list-col-owner">${escapeHtml(book.owner)}</span>
        `;
      } else {
        el.className = 'book-card';
        el.innerHTML = `
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
      }

      el.addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('book:edit', { detail: book }));
      });
      fragment.appendChild(el);
    });

    container.appendChild(fragment);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  return { load, filter, addLocal, removeLocal, updateLocal, setViewMode, setSort, getViewMode };
})();
