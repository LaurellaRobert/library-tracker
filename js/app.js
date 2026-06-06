/* ---------- Open Library ISBN lookup (global so importer can use it) ---------- */
async function lookupIsbn(isbn) {
  const resp = await fetch(`https://openlibrary.org/isbn/${isbn}.json`);
  if (!resp.ok) return null;
  const data = await resp.json();

  let authorName = '';
  if (data.authors && data.authors.length > 0) {
    try {
      const aResp = await fetch(`https://openlibrary.org${data.authors[0].key}.json`);
      if (aResp.ok) {
        const aData = await aResp.json();
        authorName = aData.name || '';
      }
    } catch (_) {}
  }
  if (!authorName && data.by_statement) {
    authorName = data.by_statement.replace(/^by\s+/i, '');
  }

  let coverUrl = '';
  if (data.covers && data.covers.length > 0) {
    coverUrl = `https://covers.openlibrary.org/b/id/${data.covers[0]}-L.jpg`;
  }

  return {
    isbn,
    title:        data.title || 'Unknown title',
    author:       authorName,
    publisher:    (data.publishers && data.publishers[0]) || '',
    publish_year: data.publish_date || '',
    cover_url:    coverUrl,
  };
}

(async function () {
  'use strict';

  /* ---------- Auth gate ---------- */
  const loginOverlay  = document.getElementById('view-login');
  const loginForm     = document.getElementById('login-form');
  const loginEmail    = document.getElementById('login-email');
  const loginPassword = document.getElementById('login-password');
  const loginError    = document.getElementById('login-error');
  const btnLogin      = document.getElementById('btn-login');
  const btnSignOut    = document.getElementById('btn-signout');

  async function ensureAuth() {
    if (auth.isAuthenticated()) return;
    const refreshed = await auth.refreshSession().catch(() => null);
    if (refreshed) return;
    await showLoginScreen();
  }

  function showLoginScreen() {
    loginOverlay.hidden = false;
    loginEmail.value    = '';
    loginPassword.value = '';
    loginError.hidden   = true;
    btnLogin.disabled   = false;
    btnLogin.textContent = 'Sign in';
    return new Promise((resolve) => {
      loginForm.addEventListener('submit', async function handler(e) {
        e.preventDefault();
        btnLogin.disabled    = true;
        btnLogin.textContent = 'Signing in…';
        loginError.hidden    = true;
        try {
          await auth.signIn(loginEmail.value.trim(), loginPassword.value);
          loginOverlay.hidden = true;
          loginForm.removeEventListener('submit', handler);
          resolve();
        } catch (err) {
          loginError.textContent = err.message;
          loginError.hidden      = false;
          btnLogin.disabled      = false;
          btnLogin.textContent   = 'Sign in';
        }
      });
    });
  }

  await ensureAuth();

  btnSignOut.addEventListener('click', () => {
    auth.signOut();
    showLoginScreen();
  });

  /* ---------- DOM refs ---------- */
  const views       = document.querySelectorAll('.view');
  const navBtns     = document.querySelectorAll('.nav-btn');
  const scanView    = document.getElementById('view-scan');
  const foundView   = document.getElementById('view-found');
  const confirmView = document.getElementById('view-confirm');
  const libraryView = document.getElementById('view-library');
  const importView  = document.getElementById('view-import');

  const isbnForm  = document.getElementById('isbn-form');
  const isbnInput = document.getElementById('isbn-input');

  const foundCover      = document.getElementById('found-cover');
  const foundTitle      = document.getElementById('found-title');
  const foundAuthor     = document.getElementById('found-author');
  const foundPublisher  = document.getElementById('found-publisher');
  const foundYear       = document.getElementById('found-year');
  const foundIsbn       = document.getElementById('found-isbn');
  const foundOwnerLine  = document.getElementById('found-owner-line');
  const foundNotes      = document.getElementById('found-notes');
  const foundAdded      = document.getElementById('found-added');
  const btnFoundDone    = document.getElementById('btn-found-done');
  const btnFoundAddAnyway = document.getElementById('btn-found-add-anyway');

  const confirmCover      = document.getElementById('confirm-cover');
  const editCoverUrl      = document.getElementById('edit-cover-url');
  const confirmDisplay    = document.getElementById('confirm-display');
  const confirmTitle      = document.getElementById('confirm-title');
  const confirmAuthor     = document.getElementById('confirm-author');
  const confirmPublisher  = document.getElementById('confirm-publisher');
  const confirmYear       = document.getElementById('confirm-year');
  const confirmEditFields = document.getElementById('confirm-edit-fields');
  const editTitle         = document.getElementById('edit-title');
  const editAuthor        = document.getElementById('edit-author');
  const editPublisher     = document.getElementById('edit-publisher');
  const editYear          = document.getElementById('edit-year');
  const confirmIsbn       = document.getElementById('confirm-isbn');
  const confirmOwner      = document.getElementById('confirm-owner');
  const confirmNotes      = document.getElementById('confirm-notes');
  const btnBack          = document.getElementById('btn-back-scan');
  const btnDelete        = document.getElementById('btn-delete-book');
  const btnSave          = document.getElementById('btn-save-book');
  const toast            = document.getElementById('toast');

  const searchInput  = document.getElementById('library-search');
  const filterOwner  = document.getElementById('library-filter-owner');
  const sortSelect   = document.getElementById('library-sort');
  const btnViewGrid  = document.getElementById('btn-view-grid');
  const btnViewList  = document.getElementById('btn-view-list');

  /* ---------- State ---------- */
  let pendingBook          = null; // enriched book data for a new add
  let editingBook          = null; // existing DB record being edited
  let foundIsbnVal         = null; // ISBN carried from found view → "add anyway"
  let deleteConfirmPending = false;
  let searchTimer          = null;

  /* ---------- Owner preference ---------- */
  const OWNER_KEY = 'library-tracker-last-owner';
  const getLastOwner  = () => localStorage.getItem(OWNER_KEY) || 'Robert';
  const saveLastOwner = (o) => localStorage.setItem(OWNER_KEY, o);

  /* ---------- Navigation ---------- */
  function showView(name) {
    views.forEach((v) => v.classList.remove('active'));
    navBtns.forEach((b) => b.classList.remove('active'));

    if (name === 'scan')    { scanView.classList.add('active');    Scanner.resume(); }
    if (name === 'found')   { foundView.classList.add('active'); }
    if (name === 'confirm') { confirmView.classList.add('active'); }
    if (name === 'library') { libraryView.classList.add('active'); Library.load(); }
    if (name === 'import')  { importView.classList.add('active'); }

    // Highlight the nav button that makes contextual sense
    let navTarget = name;
    if (name === 'found' || (name === 'confirm' && !editingBook)) navTarget = 'scan';
    if (name === 'confirm' && editingBook) navTarget = 'library';
    const activeBtn = document.querySelector(`.nav-btn[data-view="${navTarget}"]`);
    if (activeBtn) activeBtn.classList.add('active');

    if (name !== 'confirm') resetDeleteConfirm();
  }

  navBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      editingBook = null;
      pendingBook = null;
      showView(btn.dataset.view);
    });
  });

  /* ---------- Found view ---------- */
  function showFoundView(book) {
    foundIsbnVal             = book.isbn;
    foundCover.src           = book.cover_url || '';
    foundTitle.textContent   = book.title;
    foundAuthor.textContent  = book.author || 'Unknown author';
    foundPublisher.textContent = book.publisher ? `Published by ${book.publisher}` : '';
    foundYear.textContent    = book.publish_year || '';
    foundIsbn.textContent    = book.isbn ? `ISBN ${book.isbn}` : '';
    foundOwnerLine.textContent = ownerLabel(book.owner);
    foundNotes.textContent   = book.notes || '';
    foundNotes.hidden        = !book.notes;
    foundAdded.textContent   = book.added_at
      ? `Added ${new Date(book.added_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`
      : '';
    showView('found');
  }

  function ownerLabel(owner) {
    if (owner === 'Robert') return "In Robert's library";
    if (owner === 'Mom')    return "In Mom's library";
    return 'Shared copy';
  }

  btnFoundDone.addEventListener('click', () => {
    foundIsbnVal = null;
    showView('scan');
  });

  btnFoundAddAnyway.addEventListener('click', () => {
    const isbn = foundIsbnVal;
    foundIsbnVal = null;
    handleIsbn(isbn, true);
  });

  /* ---------- Handle a scanned / entered ISBN ---------- */
  async function handleIsbn(isbn, forceAdd = false) {
    // Navigate immediately so the user sees something right away
    editingBook = null;
    pendingBook = null;
    enterAddMode();
    confirmCover.src             = '';
    confirmTitle.textContent     = 'Checking…';
    confirmAuthor.textContent    = '';
    confirmPublisher.textContent = '';
    confirmYear.textContent      = '';
    confirmIsbn.textContent      = isbn;
    confirmNotes.value           = '';
    confirmOwner.value           = getLastOwner();
    btnSave.disabled             = true; // disabled until we have a pendingBook
    showView('confirm');

    // Duplicate check
    if (!forceAdd) {
      let existing = null;
      try { existing = await db.findByIsbn(isbn); } catch (_) {}
      if (existing) {
        showFoundView(existing);
        return;
      }
    }

    // Not in library — enrich via Open Library
    confirmTitle.textContent = 'Looking up…';

    try {
      const book = await lookupIsbn(isbn);
      pendingBook = book || { isbn, title: 'Unknown title', author: '', publisher: '', publish_year: '', cover_url: '' };
      confirmCover.src             = pendingBook.cover_url || '';
      confirmTitle.textContent     = pendingBook.title;
      confirmAuthor.textContent    = pendingBook.author || 'Unknown author';
      confirmPublisher.textContent = pendingBook.publisher ? `Published by ${pendingBook.publisher}` : '';
      confirmYear.textContent      = pendingBook.publish_year || '';
      confirmIsbn.textContent      = `ISBN ${isbn}`;
      if (!book) confirmTitle.textContent = 'Book not found — you can still add it';
    } catch (err) {
      console.error('Lookup failed:', err);
      pendingBook = { isbn, title: 'Unknown title', author: '', publisher: '', publish_year: '', cover_url: '' };
      confirmTitle.textContent = 'Lookup failed — you can still add it';
    }

    btnSave.disabled = false;
  }

  /* ---------- Edit mode ---------- */
  function openEditView(book) {
    editingBook = book;
    pendingBook = null;
    enterEditMode();
    showView('confirm');

    confirmCover.src        = book.cover_url || '';
    editCoverUrl.value      = book.cover_url || '';
    confirmIsbn.textContent = book.isbn ? `ISBN ${book.isbn}` : '';
    confirmOwner.value      = book.owner;
    confirmNotes.value      = book.notes || '';
    editTitle.value         = book.title || '';
    editAuthor.value        = book.author || '';
    editPublisher.value     = book.publisher || '';
    editYear.value          = book.publish_year || '';
    btnSave.disabled        = false;
  }

  document.addEventListener('book:edit', (e) => openEditView(e.detail));

  editCoverUrl.addEventListener('input', () => {
    confirmCover.src = editCoverUrl.value.trim();
  });

  /* ---------- Confirm view modes ---------- */
  function enterAddMode() {
    btnSave.textContent          = 'Add to library';
    btnBack.textContent          = 'Back';
    btnDelete.hidden             = true;
    confirmDisplay.hidden        = false;
    confirmEditFields.hidden     = true;
    editCoverUrl.hidden          = true;
  }

  function enterEditMode() {
    btnSave.textContent          = 'Save changes';
    btnBack.textContent          = 'Cancel';
    btnDelete.hidden             = false;
    btnDelete.textContent        = 'Remove from library';
    btnDelete.classList.remove('btn-delete-confirming');
    confirmDisplay.hidden        = true;
    confirmEditFields.hidden     = false;
    editCoverUrl.hidden          = false;
  }

  /* ---------- Delete with two-tap confirm ---------- */
  function resetDeleteConfirm() {
    if (deleteConfirmPending) {
      deleteConfirmPending  = false;
      btnDelete.textContent = 'Remove from library';
      btnDelete.classList.remove('btn-delete-confirming');
    }
  }

  btnDelete.addEventListener('click', async () => {
    if (!editingBook) return;

    if (!deleteConfirmPending) {
      deleteConfirmPending = true;
      btnDelete.textContent = 'Tap again to confirm';
      btnDelete.classList.add('btn-delete-confirming');
      setTimeout(resetDeleteConfirm, 3000);
      return;
    }

    btnDelete.disabled = true;
    try {
      await db.remove(editingBook.id);
      Library.removeLocal(editingBook.id);
      showToast(`"${editingBook.title}" removed`);
      editingBook = null;
      showView('library');
    } catch (err) {
      if (err.message === 'AUTH_REQUIRED') { auth.signOut(); showLoginScreen(); return; }
      console.error('Delete failed:', err);
      showToast('Delete failed — check console');
      btnDelete.disabled = false;
    }
  });

  /* ---------- Back button ---------- */
  btnBack.addEventListener('click', () => {
    const wasEditing = !!editingBook;
    editingBook = null;
    pendingBook = null;
    showView(wasEditing ? 'library' : 'scan');
  });

  /* ---------- Save button ---------- */
  btnSave.addEventListener('click', async () => {
    if (!editingBook && !pendingBook) return;
    btnSave.disabled = true;
    const savedLabel = btnSave.textContent;
    btnSave.textContent = 'Saving…';

    const owner = confirmOwner.value;
    const notes = confirmNotes.value.trim() || null;

    try {
      if (editingBook) {
        const updated = await db.update(editingBook.id, {
          owner,
          notes,
          title:        editTitle.value.trim() || editingBook.title,
          author:       editAuthor.value.trim() || null,
          publisher:    editPublisher.value.trim() || null,
          publish_year: editYear.value.trim() || null,
          cover_url:    editCoverUrl.value.trim() || null,
        });
        Library.updateLocal(updated);
        saveLastOwner(owner);
        showToast('Changes saved');
        editingBook = null;
        showView('library');
      } else {
        const record = {
          isbn:         pendingBook.isbn,
          title:        pendingBook.title,
          author:       pendingBook.author,
          publisher:    pendingBook.publisher,
          publish_year: pendingBook.publish_year,
          cover_url:    pendingBook.cover_url,
          owner,
          notes,
        };
        const saved = await db.insert(record);
        Library.addLocal(saved);
        saveLastOwner(owner);
        showToast(`"${saved.title}" added!`);
        pendingBook = null;
        showView('scan');
      }
    } catch (err) {
      if (err.message === 'AUTH_REQUIRED') { auth.signOut(); showLoginScreen(); return; }
      console.error('Save failed:', err);
      showToast('Save failed — check console');
      btnSave.disabled    = false;
      btnSave.textContent = savedLabel;
    }
  });

  /* ---------- Scanner ---------- */
  try {
    await Scanner.start('scanner-region', handleIsbn);
  } catch (err) {
    console.warn('Camera not available:', err);
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

  /* ---------- View mode toggle ---------- */
  btnViewGrid.addEventListener('click', () => Library.setViewMode('grid'));
  btnViewList.addEventListener('click', () => Library.setViewMode('list'));

  /* ---------- Sort ---------- */
  sortSelect.addEventListener('change', () => Library.setSort(sortSelect.value));

  /* ---------- Library search & filter ---------- */
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

  /* ---------- Import ---------- */
  if (typeof Importer === 'undefined') {
    console.error('importer.js not loaded — check script tag in index.html');
  } else {
    Importer.init();
  }

  /* ---------- Initial library pre-fetch ---------- */
  try { await Library.load(); } catch (_) {}


})();
