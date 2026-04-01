/**
 * Main app controller.
 * Wires navigation, scanner, Open Library lookup, and save flow.
 */

(async function () {
  'use strict';

  /* ---------- DOM refs ---------- */
  const views        = document.querySelectorAll('.view');
  const navBtns      = document.querySelectorAll('.nav-btn');
  const scanView     = document.getElementById('view-scan');
  const confirmView  = document.getElementById('view-confirm');
  const libraryView  = document.getElementById('view-library');

  const isbnForm     = document.getElementById('isbn-form');
  const isbnInput    = document.getElementById('isbn-input');

  const confirmCover     = document.getElementById('confirm-cover');
  const confirmTitle     = document.getElementById('confirm-title');
  const confirmAuthor    = document.getElementById('confirm-author');
  const confirmPublisher = document.getElementById('confirm-publisher');
  const confirmYear      = document.getElementById('confirm-year');
  const confirmIsbn      = document.getElementById('confirm-isbn');
  const confirmDuplicate = document.getElementById('confirm-duplicate');
  const confirmOwner     = document.getElementById('confirm-owner');
  const confirmNotes     = document.getElementById('confirm-notes');
  const btnBack          = document.getElementById('btn-back-scan');
  const btnSave          = document.getElementById('btn-save-book');

  const searchInput  = document.getElementById('library-search');
  const filterOwner  = document.getElementById('library-filter-owner');
  const toast        = document.getElementById('toast');

  /* ---------- State ---------- */
  let currentBook = null;   // enriched book data pending save
  let isDuplicate = false;
  let searchTimer = null;

  /* ---------- Navigation ---------- */
  function showView(name) {
    views.forEach((v) => v.classList.remove('active'));
    navBtns.forEach((b) => b.classList.remove('active'));

    if (name === 'scan')    { scanView.classList.add('active');    Scanner.resume(); }
    if (name === 'confirm') { confirmView.classList.add('active'); }
    if (name === 'library') { libraryView.classList.add('active'); Library.load(); }

    const activeBtn = document.querySelector(`.nav-btn[data-view="${name}"]`);
    if (activeBtn) activeBtn.classList.add('active');
  }

  navBtns.forEach((btn) => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });

  /* ---------- ISBN lookup via Open Library ---------- */
  async function lookupIsbn(isbn) {
    const url = `https://openlibrary.org/isbn/${isbn}.json`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();

    // Resolve author names (OL stores author references)
    let authorName = '';
    if (data.authors && data.authors.length > 0) {
      try {
        const authorKey = data.authors[0].key; // e.g. "/authors/OL12345A"
        const aResp = await fetch(`https://openlibrary.org${authorKey}.json`);
        if (aResp.ok) {
          const aData = await aResp.json();
          authorName = aData.name || '';
        }
      } catch (_) {}
    }
    // Fallback: some records have "by_statement"
    if (!authorName && data.by_statement) {
      authorName = data.by_statement.replace(/^by\s+/i, '');
    }

    // Cover image
    let coverUrl = '';
    if (data.covers && data.covers.length > 0) {
      coverUrl = `https://covers.openlibrary.org/b/id/${data.covers[0]}-L.jpg`;
    }

    return {
      isbn:        isbn,
      title:       data.title || 'Unknown title',
      author:      authorName,
      publisher:   (data.publishers && data.publishers[0]) || '',
      publish_year: data.publish_date || '',
      cover_url:   coverUrl
    };
  }

  /* ---------- Handle a scanned / entered ISBN ---------- */
  async function handleIsbn(isbn) {
    showView('confirm');

    // Reset confirm view
    confirmCover.src = '';
    confirmTitle.textContent = 'Looking up…';
    confirmAuthor.textContent = '';
    confirmPublisher.textContent = '';
    confirmYear.textContent = '';
    confirmIsbn.textContent = isbn;
    confirmDuplicate.hidden = true;
    confirmNotes.value = '';
    btnSave.disabled = false;
    btnSave.textContent = 'Add to library';

    // Check for duplicate
    try {
      const existing = await db.findByIsbn(isbn);
      if (existing) {
        isDuplicate = true;
        confirmDuplicate.hidden = false;
      } else {
        isDuplicate = false;
      }
    } catch (_) {
      isDuplicate = false;
    }

    // Enrich
    try {
      const book = await lookupIsbn(isbn);
      if (book) {
        currentBook = book;
        confirmCover.src   = book.cover_url || '';
        confirmTitle.textContent     = book.title;
        confirmAuthor.textContent    = book.author || 'Unknown author';
        confirmPublisher.textContent = book.publisher ? `Published by ${book.publisher}` : '';
        confirmYear.textContent      = book.publish_year || '';
        confirmIsbn.textContent      = `ISBN ${isbn}`;
      } else {
        currentBook = { isbn, title: 'Unknown title', author: '', publisher: '', publish_year: '', cover_url: '' };
        confirmTitle.textContent = 'Book not found — you can still add it';
      }
    } catch (err) {
      console.error('Lookup failed:', err);
      currentBook = { isbn, title: 'Unknown title', author: '', publisher: '', publish_year: '', cover_url: '' };
      confirmTitle.textContent = 'Lookup failed — you can still add it';
    }
  }

  /* ---------- Scanner callback ---------- */
  try {
    await Scanner.start('scanner-region', handleIsbn);
  } catch (err) {
    console.warn('Camera not available, use manual entry.', err);
    document.querySelector('.scanner-hint').textContent = 'Camera unavailable — enter ISBN manually below';
  }

  /* ---------- Manual ISBN entry ---------- */
  isbnForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const isbn = isbnInput.value.trim().replace(/[-\s]/g, '');
    if (isbn.length === 10 || isbn.length === 13) {
      isbnInput.value = '';
      handleIsbn(isbn);
    }
  });

  /* ---------- Confirm screen actions ---------- */
  btnBack.addEventListener('click', () => {
    currentBook = null;
    showView('scan');
  });

  btnSave.addEventListener('click', async () => {
    if (!currentBook) return;
    btnSave.disabled = true;
    btnSave.textContent = 'Saving…';

    const record = {
      isbn:         currentBook.isbn,
      title:        currentBook.title,
      author:       currentBook.author,
      publisher:    currentBook.publisher,
      publish_year: currentBook.publish_year,
      cover_url:    currentBook.cover_url,
      owner:        confirmOwner.value,
      notes:        confirmNotes.value.trim() || null
    };

    try {
      const saved = await db.insert(record);
      Library.addLocal(saved);
      showToast(`"${saved.title}" added!`);
      currentBook = null;
      showView('scan');
    } catch (err) {
      console.error('Save failed:', err);
      showToast('Save failed — check console');
      btnSave.disabled = false;
      btnSave.textContent = 'Add to library';
    }
  });

  /* ---------- Library search ---------- */
  function triggerSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      Library.filter(searchInput.value.trim(), filterOwner.value);
    }, 300);
  }

  searchInput.addEventListener('input', triggerSearch);
  filterOwner.addEventListener('change', triggerSearch);

  /* ---------- Toast ---------- */
  function showToast(message, duration = 2500) {
    toast.textContent = message;
    toast.hidden = false;
    setTimeout(() => { toast.hidden = true; }, duration);
  }

  /* ---------- Service Worker ---------- */
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  /* ---------- Initial library load ---------- */
  // Pre-fetch so switching to Library tab is fast
  try { await Library.load(); } catch (_) {}

})();
