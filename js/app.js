/* ---------- ISBN lookup with multi-source cover fallback ---------- */

async function fetchOpenLibrary(isbn) {
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

  // If the edition has no cover, try the parent Work record — it often does
  if (!coverUrl && data.works && data.works.length > 0) {
    try {
      const wResp = await fetch(`https://openlibrary.org${data.works[0].key}.json`);
      if (wResp.ok) {
        const wData = await wResp.json();
        if (wData.covers && wData.covers.length > 0) {
          coverUrl = `https://covers.openlibrary.org/b/id/${wData.covers[0]}-L.jpg`;
        }
      }
    } catch (_) {}
  }

  return {
    isbn,
    title:        data.title || '',
    author:       authorName,
    publisher:    (data.publishers && data.publishers[0]) || '',
    publish_year: data.publish_date || '',
    cover_url:    coverUrl,
  };
}

async function fetchGoogleBooks(isbn) {
  try {
    const resp = await fetch(
      `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&maxResults=1&fields=items(volumeInfo)`
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.items?.length) return null;

    const info = data.items[0].volumeInfo;
    let coverUrl = '';
    if (info.imageLinks?.thumbnail) {
      coverUrl = info.imageLinks.thumbnail
        .replace('http://', 'https://')
        .replace('&edge=curl', '')
        .replace(/zoom=\d+/, 'zoom=0');
    }

    return {
      isbn,
      title:        info.title || '',
      author:       (info.authors && info.authors[0]) || '',
      publisher:    info.publisher || '',
      publish_year: info.publishedDate ? info.publishedDate.split('-')[0] : '',
      cover_url:    coverUrl,
    };
  } catch (_) {
    return null;
  }
}

/* ---------- Extra cover sources, tried when Open Library and Google have none ---------- */

// Amazon image URLs use ISBN-10; 979-prefixed ISBNs have no ISBN-10 equivalent
function isbn13to10(isbn) {
  if (/^\d{9}[\dX]$/.test(isbn)) return isbn;
  if (!/^978\d{10}$/.test(isbn)) return null;
  const core = isbn.slice(3, 12);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(core[i]);
  const check = (11 - (sum % 11)) % 11;
  return core + (check === 10 ? 'X' : String(check));
}

// True if the URL loads as a real image (Amazon serves a 1×1 GIF when it has no cover)
function imageLoads(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => done(false), timeoutMs);
    function done(ok) { clearTimeout(timer); img.onload = img.onerror = null; resolve(ok); }
    img.onload  = () => done(img.naturalWidth > 1 && img.naturalHeight > 1);
    img.onerror = () => done(false);
    img.src = url;
  });
}

let appleNextAt = 0; // Apple's lookup API allows roughly 20 calls a minute
async function fetchAppleBooksCover(isbn) {
  const wait = appleNextAt - Date.now();
  appleNextAt = Math.max(Date.now(), appleNextAt) + 3100;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  try {
    const resp = await fetch(`https://itunes.apple.com/lookup?isbn=${isbn}`);
    if (!resp.ok) return '';
    const data = await resp.json();
    const art  = data.results?.find((r) => r.artworkUrl100)?.artworkUrl100;
    if (!art) return '';
    const url = art.replace(/\/\d+x\d+bb\./, '/600x600bb.');
    return (await imageLoads(url)) ? url : '';
  } catch (_) {
    return '';
  }
}

async function fetchAmazonCover(isbn) {
  const isbn10 = isbn13to10(isbn);
  if (!isbn10) return '';
  const url = `https://images-na.ssl-images-amazon.com/images/P/${isbn10}.01.L.jpg`;
  return (await imageLoads(url)) ? url : '';
}

// Apple Books is preferred; Amazon's image URLs are unofficial and could stop working
async function findExtraCover(isbn) {
  const [apple, amazon] = await Promise.all([fetchAppleBooksCover(isbn), fetchAmazonCover(isbn)]);
  if (apple)  return { url: apple,  source: 'Apple Books' };
  if (amazon) return { url: amazon, source: 'Amazon' };
  return null;
}

async function lookupIsbn(isbn) {
  const [ol, gb] = await Promise.all([fetchOpenLibrary(isbn), fetchGoogleBooks(isbn)]);
  if (!ol && !gb) return null;

  let coverUrl = ol?.cover_url || gb?.cover_url || '';
  if (!coverUrl) coverUrl = (await findExtraCover(isbn))?.url || '';

  // Prefer OL metadata (more structured), fill gaps with Google Books
  return {
    isbn,
    title:        ol?.title        || gb?.title        || 'Unknown title',
    author:       ol?.author       || gb?.author       || '',
    publisher:    ol?.publisher    || gb?.publisher    || '',
    publish_year: ol?.publish_year || gb?.publish_year || '',
    cover_url:    coverUrl,
  };
}

// Cover (plus publisher/year when available) for an existing book, with where it came from
async function findCover(isbn) {
  const [ol, gb] = await Promise.all([fetchOpenLibrary(isbn).catch(() => null), fetchGoogleBooks(isbn)]);
  const meta = {
    publisher:    ol?.publisher    || gb?.publisher    || '',
    publish_year: ol?.publish_year || gb?.publish_year || '',
  };
  if (ol?.cover_url) return { ...meta, url: ol.cover_url, source: 'Open Library' };
  if (gb?.cover_url) return { ...meta, url: gb.cover_url, source: 'Google Books' };
  const extra = await findExtraCover(isbn);
  return extra ? { ...meta, ...extra } : { ...meta, url: '', source: '' };
}

/* ---------- Toast (shared with importer.js and tools.js) ---------- */

let toastTimer = null;
function showToast(message, duration = 2500) {
  const toast = document.getElementById('toast');
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, duration);
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
  const loginCard     = document.getElementById('login-card');
  const loginInfo     = document.getElementById('login-info');
  const btnForgot     = document.getElementById('btn-forgot');
  const passwordCard  = document.getElementById('password-card');
  const passwordForm  = document.getElementById('password-form');
  const newPassword   = document.getElementById('new-password');
  const newPassword2  = document.getElementById('new-password-confirm');
  const passwordError = document.getElementById('password-error');
  const btnSetPassword = document.getElementById('btn-set-password');

  async function ensureAuth() {
    // Arriving from a reset/invite email: the link carries a session; ask for a new password
    const redirect = auth.consumeAuthRedirect();
    if (redirect && (redirect.type === 'recovery' || redirect.type === 'invite')) {
      await showSetPasswordScreen();
      return;
    }
    if (redirect && redirect.error) {
      await showLoginScreen(redirect.error);
      return;
    }

    if (auth.isAuthenticated()) return;
    const refreshed = await auth.refreshSession().catch(() => null);
    if (refreshed) return;
    await showLoginScreen();
  }

  btnForgot.addEventListener('click', async () => {
    const email = loginEmail.value.trim();
    loginError.hidden = true;
    loginInfo.hidden  = true;
    if (!email) {
      loginError.textContent = 'Enter your email above, then tap "Forgot password?"';
      loginError.hidden = false;
      loginEmail.focus();
      return;
    }
    btnForgot.disabled = true;
    try {
      await auth.requestPasswordReset(email);
      loginInfo.textContent = `Check ${email} for a link to set a new password.`;
      loginInfo.hidden = false;
    } catch (err) {
      loginError.textContent = err.message;
      loginError.hidden = false;
    } finally {
      btnForgot.disabled = false;
    }
  });

  function showSetPasswordScreen() {
    loginOverlay.hidden    = false;
    loginCard.hidden       = true;
    passwordCard.hidden    = false;
    newPassword.value      = '';
    newPassword2.value     = '';
    passwordError.hidden   = true;
    btnSetPassword.disabled    = false;
    btnSetPassword.textContent = 'Save password';
    newPassword.focus();
    return new Promise((resolve) => {
      passwordForm.addEventListener('submit', async function handler(e) {
        e.preventDefault();
        passwordError.hidden = true;
        if (newPassword.value !== newPassword2.value) {
          passwordError.textContent = "Passwords don't match";
          passwordError.hidden = false;
          return;
        }
        btnSetPassword.disabled    = true;
        btnSetPassword.textContent = 'Saving…';
        try {
          await auth.updatePassword(newPassword.value);
          passwordForm.removeEventListener('submit', handler);
          passwordCard.hidden = true;
          loginCard.hidden    = false;
          loginOverlay.hidden = true;
          showToast("Password saved — you're signed in");
          resolve();
        } catch (err) {
          if (/jwt|expired|session|token/i.test(err.message)) {
            // The link's session ran out before they saved — send them back for a new link
            passwordForm.removeEventListener('submit', handler);
            auth.signOut();
            showLoginScreen('Your reset link has expired. Enter your email and tap "Forgot password?" for a new one.').then(resolve);
            return;
          }
          passwordError.textContent  = err.message;
          passwordError.hidden       = false;
          btnSetPassword.disabled    = false;
          btnSetPassword.textContent = 'Save password';
        }
      });
    });
  }

  function showLoginScreen(message) {
    loginOverlay.hidden = false;
    loginCard.hidden    = false;
    passwordCard.hidden = true;
    loginEmail.value    = '';
    loginPassword.value = '';
    loginError.textContent = message || '';
    loginError.hidden   = !message;
    loginInfo.hidden    = true;
    btnLogin.disabled   = false;
    btnLogin.textContent = 'Sign in';
    loginEmail.focus();
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
    showLoginScreen().then(syncCamera);
    syncCamera();
  });

  /* ---------- DOM refs ---------- */
  const views       = document.querySelectorAll('.view');
  const navBtns     = document.querySelectorAll('.nav-btn');
  const scanView    = document.getElementById('view-scan');
  const foundView   = document.getElementById('view-found');
  const confirmView = document.getElementById('view-confirm');
  const libraryView = document.getElementById('view-library');
  const importView  = document.getElementById('view-import');
  const savedView   = document.getElementById('view-saved');

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
  const savedCover      = document.getElementById('saved-cover');
  const savedTitle      = document.getElementById('saved-title');
  const savedAuthor     = document.getElementById('saved-author');
  const savedIsbn       = document.getElementById('saved-isbn');
  const btnSavedScan    = document.getElementById('btn-saved-scan');
  const btnSavedLibrary = document.getElementById('btn-saved-library');

  const btnBack          = document.getElementById('btn-back-scan');
  const btnDelete        = document.getElementById('btn-delete-book');
  const btnSave          = document.getElementById('btn-save-book');

  const appMain      = document.querySelector('.app-main');
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
  let lookupSeq            = 0;    // bumps per lookup; stale results are dropped
  let libraryScroll        = 0;    // restored when returning to the library

  /* ---------- Covers ---------- */
  const PLACEHOLDER_COVER = Library.PLACEHOLDER_COVER;
  [confirmCover, foundCover, savedCover].forEach((img) => {
    img.addEventListener('error', () => {
      if (img.src !== PLACEHOLDER_COVER) img.src = PLACEHOLDER_COVER;
    });
  });
  const setCover   = (img, url) => { img.src = url || PLACEHOLDER_COVER; };
  const clearCover = (img) => img.removeAttribute('src');

  /* ---------- Owner preference ---------- */
  const OWNER_KEY = 'library-tracker-last-owner';
  const getLastOwner  = () => localStorage.getItem(OWNER_KEY) || 'Robert';
  const saveLastOwner = (o) => localStorage.setItem(OWNER_KEY, o);

  /* ---------- Camera ---------- */
  // The camera runs only while the scan view is on screen and the page is visible.
  const scannerHint = document.querySelector('.scanner-hint');
  let currentView   = 'scan';

  function syncCamera() {
    if (currentView === 'scan' && !document.hidden && loginOverlay.hidden) {
      scannerHint.textContent = 'Starting camera…';
      Scanner.start('scanner-region', handleIsbn)
        .then(() => { scannerHint.textContent = "Point your camera at a book's barcode"; })
        .catch((err) => {
          console.warn('Camera not available:', err);
          scannerHint.textContent = 'Camera unavailable — enter ISBN manually below';
        });
    } else {
      Scanner.stop();
    }
  }

  document.addEventListener('visibilitychange', syncCamera);

  /* ---------- Navigation ---------- */
  function showView(name) {
    // Read before hiding the library, or the browser reports 0
    if (currentView === 'library') libraryScroll = appMain.scrollTop;

    views.forEach((v) => v.classList.remove('active'));
    navBtns.forEach((b) => b.classList.remove('active'));

    currentView = name;
    syncCamera();

    if (name === 'scan')    { scanView.classList.add('active'); }
    if (name === 'found')   { foundView.classList.add('active'); }
    if (name === 'saved')   { savedView.classList.add('active'); }
    if (name === 'confirm') { confirmView.classList.add('active'); }
    if (name === 'library') { libraryView.classList.add('active'); Library.load(); }
    if (name === 'import')  { importView.classList.add('active'); Tools.refresh(); }

    appMain.scrollTop = name === 'library' ? libraryScroll : 0;

    // Highlight the nav button that makes contextual sense
    let navTarget = name;
    if (name === 'found' || name === 'saved' || (name === 'confirm' && !editingBook)) navTarget = 'scan';
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
    setCover(foundCover, book.cover_url);
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

  btnSavedScan.addEventListener('click', () => showView('scan'));
  btnSavedLibrary.addEventListener('click', () => showView('library'));

  btnFoundAddAnyway.addEventListener('click', () => {
    const isbn = foundIsbnVal;
    foundIsbnVal = null;
    handleIsbn(isbn, true);
  });

  /* ---------- Handle a scanned / entered ISBN ---------- */
  async function handleIsbn(isbn, forceAdd = false) {
    // Results that arrive after the user has moved on (Back, another scan,
    // opening an edit) are dropped instead of yanking them to another screen.
    const seq = ++lookupSeq;
    const stale = () => seq !== lookupSeq || currentView !== 'confirm';

    // Navigate immediately so the user sees something right away
    editingBook = null;
    pendingBook = null;
    enterAddMode();
    clearCover(confirmCover);
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
      if (stale()) return;
      if (existing) {
        showFoundView(existing);
        return;
      }
    }

    // Not in library — enrich via Open Library / Google Books
    confirmTitle.textContent = 'Looking up…';

    let book = null, failed = false;
    try {
      book = await lookupIsbn(isbn);
    } catch (err) {
      console.error('Lookup failed:', err);
      failed = true;
    }
    if (stale()) return;

    confirmIsbn.textContent = `ISBN ${isbn}`;
    if (book) {
      pendingBook = book;
      setCover(confirmCover, book.cover_url);
      confirmTitle.textContent     = book.title;
      confirmAuthor.textContent    = book.author || 'Unknown author';
      confirmPublisher.textContent = book.publisher ? `Published by ${book.publisher}` : '';
      confirmYear.textContent      = book.publish_year || '';
    } else {
      // No match — let the user type the details in rather than saving "Unknown title"
      pendingBook = { isbn };
      showDetailFields({});
      setCover(confirmCover, '');
      // Apple Books / Amazon may still have a cover even when there's no metadata
      findExtraCover(isbn).then((extra) => {
        if (extra && !stale() && !editCoverUrl.value) {
          editCoverUrl.value = extra.url;
          setCover(confirmCover, extra.url);
        }
      });
      showToast(failed ? 'Lookup failed — enter the details yourself' : 'No match found — enter the details yourself', 3500);
    }

    btnSave.disabled = false;
  }

  /* ---------- Edit mode ---------- */
  function openEditView(book) {
    lookupSeq++; // cancel any lookup still in flight
    editingBook = book;
    pendingBook = null;
    enterEditMode();
    showView('confirm');

    setCover(confirmCover, book.cover_url);
    showDetailFields(book);
    confirmIsbn.textContent = book.isbn ? `ISBN ${book.isbn}` : '';
    confirmOwner.value      = book.owner;
    confirmNotes.value      = book.notes || '';
    btnSave.disabled        = false;
  }

  document.addEventListener('book:edit', (e) => openEditView(e.detail));

  editCoverUrl.addEventListener('input', () => {
    setCover(confirmCover, editCoverUrl.value.trim());
  });

  // Enter in any field on the add/edit screen saves
  [confirmNotes, editTitle, editAuthor, editPublisher, editYear, editCoverUrl].forEach((input) => {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !btnSave.disabled) { e.preventDefault(); btnSave.click(); }
    });
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
  }

  // Swap the read-only details for editable fields, prefilled from `book`
  function showDetailFields(book) {
    editTitle.value          = book.title || '';
    editAuthor.value         = book.author || '';
    editPublisher.value      = book.publisher || '';
    editYear.value           = book.publish_year || '';
    editCoverUrl.value       = book.cover_url || '';
    confirmDisplay.hidden    = true;
    confirmEditFields.hidden = false;
    editCoverUrl.hidden      = false;
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
      showToast("Couldn't remove — check your connection and try again", 3500);
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
        const typed = !confirmEditFields.hidden; // lookup found nothing; user filled in details
        const record = typed ? {
          isbn:         pendingBook.isbn,
          title:        editTitle.value.trim() || 'Unknown title',
          author:       editAuthor.value.trim() || null,
          publisher:    editPublisher.value.trim() || null,
          publish_year: editYear.value.trim() || null,
          cover_url:    editCoverUrl.value.trim() || null,
          owner,
          notes,
        } : {
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
        pendingBook = null;
        setCover(savedCover, saved.cover_url);
        savedTitle.textContent  = saved.title;
        savedAuthor.textContent = saved.author || '';
        savedIsbn.textContent   = saved.isbn ? `ISBN ${saved.isbn}` : '';
        showView('saved');
      }
    } catch (err) {
      if (err.message === 'AUTH_REQUIRED') { auth.signOut(); showLoginScreen(); return; }
      console.error('Save failed:', err);
      showToast("Couldn't save — check your connection and try again", 3500);
      btnSave.disabled    = false;
      btnSave.textContent = savedLabel;
    }
  });

  /* ---------- Scanner ---------- */
  syncCamera();

  /* ---------- Manual ISBN entry ---------- */
  isbnForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const isbn = isbnInput.value.trim().replace(/[-\s]/g, '').toUpperCase();
    if (Scanner.isValidIsbn(isbn)) {
      isbnInput.value = '';
      isbnInput.blur(); // dismiss the mobile keyboard
      handleIsbn(isbn);
    } else if (/^\d{9}[\dX]$|^\d{13}$/.test(isbn)) {
      showToast("That ISBN doesn't add up — check for a typo", 3500);
    } else if (isbn) {
      showToast('An ISBN is 10 or 13 digits — check and try again');
    }
  });

  /* ---------- View mode toggle ---------- */
  btnViewGrid.addEventListener('click', () => Library.setViewMode('grid'));
  btnViewList.addEventListener('click', () => Library.setViewMode('list'));

  /* ---------- Sort ---------- */
  sortSelect.addEventListener('change', () => Library.setSort(sortSelect.value));

  /* ---------- Library search & filter (local, instant) ---------- */
  function applySearch() {
    Library.filter(searchInput.value.trim(), filterOwner.value);
  }
  searchInput.addEventListener('input', applySearch);
  filterOwner.addEventListener('change', applySearch);

  /* ---------- Service Worker ---------- */
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  /* ---------- Tools tab (import + library maintenance) ---------- */
  Importer.init();
  Tools.init();

  /* ---------- Initial library pre-fetch ---------- */
  try { await Library.load(); } catch (_) {}


})();
