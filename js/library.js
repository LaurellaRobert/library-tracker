const Library = (() => {
  const VIEW_MODE_KEY = 'library-tracker-view-mode';
  const SORT_KEY      = 'library-tracker-sort';
  const SORT_DIR_KEY  = 'library-tracker-sort-dir';

  let allBooks     = [];
  let loaded       = false; // true once the first fetch has succeeded
  let loadFailed   = false;
  let query        = '';    // current search text, applied on every render
  let ownerFilter  = '';
  let viewMode     = localStorage.getItem(VIEW_MODE_KEY) || 'grid';
  let sortMode     = localStorage.getItem(SORT_KEY)      || 'added';
  let sortDir      = localStorage.getItem(SORT_DIR_KEY)  || 'asc';

  const PLACEHOLDER_COVER = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300" fill="#e7e5e4">' +
    '<rect width="200" height="300"/>' +
    '<text x="100" y="155" text-anchor="middle" fill="#a8a29e" font-family="sans-serif" font-size="14">No cover</text>' +
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
    render();
    try {
      allBooks   = await db.getAll();
      loaded     = true;
      loadFailed = false;
    } catch (err) {
      console.error('Failed to load library:', err);
      loadFailed = !loaded;
    }
    render();
  }

  // Search runs locally over the loaded books, so it's instant and survives
  // tab switches and edits.
  function filter(q, owner) {
    query       = q;
    ownerFilter = owner;
    render();
  }

  function matches(book) {
    if (ownerFilter && book.owner !== ownerFilter) return false;
    if (!query) return true;
    const q     = query.toLowerCase();
    const qIsbn = q.replace(/[-\s]/g, '');
    return (book.title  || '').toLowerCase().includes(q)
        || (book.author || '').toLowerCase().includes(q)
        || (!!qIsbn && (book.isbn || '').toLowerCase().includes(qIsbn));
  }

  function addLocal(book) {
    allBooks.unshift(book);
    render();
  }

  function removeLocal(id) {
    allBooks = allBooks.filter((b) => b.id !== id);
    render();
  }

  function updateLocal(book) {
    const idx = allBooks.findIndex((b) => b.id === book.id);
    if (idx !== -1) allBooks[idx] = book;
    render();
  }

  /* ---------- UI state ---------- */

  function setViewMode(mode) {
    viewMode = mode;
    localStorage.setItem(VIEW_MODE_KEY, mode);
    syncControls();
    render();
  }

  function setSort(mode) {
    sortMode = mode;
    sortDir  = 'asc';
    localStorage.setItem(SORT_KEY,     mode);
    localStorage.setItem(SORT_DIR_KEY, 'asc');
    syncControls();
    render();
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

  function render() {
    const toShow = sortBooks(allBooks.filter(matches));

    const container = document.getElementById('library-grid');
    const loading   = document.getElementById('library-loading');
    const empty     = document.getElementById('library-empty');
    const noResult  = document.getElementById('library-no-results');
    const count     = document.getElementById('library-count');

    container.className = viewMode === 'list' ? 'library-list' : 'library-grid';
    container.innerHTML = '';
    loading.hidden  = true;
    empty.hidden    = true;
    noResult.hidden = true;

    const total  = allBooks.length;
    const plural = (n) => n + ' book' + (n !== 1 ? 's' : '');
    count.textContent = !total ? ''
      : toShow.length === total ? plural(total)
      : `${toShow.length} of ${plural(total)}`;

    if (total === 0) {
      if (loaded) {
        empty.hidden = false;
      } else {
        loading.textContent = loadFailed
          ? "Couldn't load your library — check your connection"
          : 'Loading your library…';
        loading.hidden = false;
      }
      return;
    }

    if (toShow.length === 0) {
      noResult.hidden = false;
      return;
    }

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
            render();
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
               src="${escapeHtml(book.cover_url) || PLACEHOLDER_COVER}"
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

  return { load, filter, addLocal, removeLocal, updateLocal, setViewMode, setSort, getViewMode, PLACEHOLDER_COVER };
})();
