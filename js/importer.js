const Importer = (() => {
  let parsedRows = [];

  /* ---------- CSV parsing ---------- */

  function parseCSVRow(line) {
    const cells = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (c === ',' && !inQ) {
        cells.push(cur); cur = '';
      } else {
        cur += c;
      }
    }
    cells.push(cur);
    return cells.map((s) => s.trim());
  }

  function parseCSV(text) {
    const clean = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text; // strip BOM
    const lines = clean.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return { rows: [], error: 'File appears empty.' };

    const norm = (h) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
    const headers = parseCSVRow(lines[0]).map(norm);

    const find = (...cands) => headers.findIndex((h) => cands.includes(h));
    const isbnIdx   = find('isbn', 'isbn13', 'isbn10', 'barcode', 'ean');
    const titleIdx  = find('title', 'booktitle', 'name');
    const authorIdx = find('author', 'authors', 'authorname', 'writer', 'writers');

    if (isbnIdx === -1 && titleIdx === -1) {
      return { rows: [], error: 'Could not find an isbn or title column. Check your column headers.' };
    }

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cells   = parseCSVRow(lines[i]);
      const rawIsbn = isbnIdx >= 0 ? (cells[isbnIdx] || '').replace(/[-\s]/g, '') : '';
      const isbn    = /^\d{10}$|^\d{13}$/.test(rawIsbn) ? rawIsbn : '';
      const title   = titleIdx  >= 0 ? (cells[titleIdx]  || '') : '';
      const author  = authorIdx >= 0 ? (cells[authorIdx] || '') : '';
      if (!isbn && !title) continue;
      rows.push({ isbn: isbn || null, title: title || 'Unknown title', author: author || null });
    }

    return { rows, error: null };
  }

  /* ---------- Helpers ---------- */

  function escHtml(s) {
    return (s || '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function showState(name) {
    ['pick', 'preview', 'progress', 'done'].forEach((s) => {
      document.getElementById('import-' + s).hidden = (s !== name);
    });
  }

  /* ---------- File handling ---------- */

  function handleFile(file) {
    if (!file || !file.name.match(/\.csv$/i)) {
      alert('Please select a CSV file.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const { rows, error } = parseCSV(e.target.result);
      if (error) { alert(error); return; }
      if (rows.length === 0) {
        alert('No importable rows found. Make sure the file has isbn and/or title columns.');
        return;
      }
      parsedRows = rows;

      const label = rows.length + ' book' + (rows.length !== 1 ? 's' : '');
      document.getElementById('import-count').textContent = label + ' ready to import';
      document.getElementById('btn-import-go').textContent = 'Import ' + label;

      renderPreview(rows);
      showState('preview');
    };
    reader.readAsText(file);
  }

  function renderPreview(rows) {
    const list = document.getElementById('import-preview-list');
    const SHOW = 5;
    list.innerHTML = rows.slice(0, SHOW).map((r) =>
      '<div class="import-preview-row">' +
        '<span class="import-preview-title">'  + escHtml(r.title)           + '</span>' +
        '<span class="import-preview-author">' + escHtml(r.author || '--')  + '</span>' +
        '<span class="import-preview-isbn">'   + escHtml(r.isbn   || '--')  + '</span>' +
      '</div>'
    ).join('');
    if (rows.length > SHOW) {
      const more = document.createElement('p');
      more.className = 'import-more';
      more.textContent = '... and ' + (rows.length - SHOW) + ' more';
      list.appendChild(more);
    }
  }

  /* ---------- Import ---------- */

  async function runImport() {
    const owner = document.getElementById('import-owner').value;
    const total = parsedRows.length;
    const CHUNK = 100;
    let done = 0;

    const progressText = document.getElementById('import-progress-text');
    const progressBar  = document.getElementById('import-progress-bar');

    showState('progress');
    progressBar.style.width = '0%';
    progressText.textContent = 'Importing... 0 / ' + total;

    try {
      for (let i = 0; i < parsedRows.length; i += CHUNK) {
        const chunk = parsedRows.slice(i, i + CHUNK).map((r) => ({
          isbn:         r.isbn,
          title:        r.title,
          author:       r.author,
          publisher:    null,
          publish_year: null,
          cover_url:    null,
          owner,
          notes:        null,
        }));
        await db.bulkInsert(chunk);
        done += chunk.length;
        progressText.textContent = 'Importing... ' + done + ' / ' + total;
        progressBar.style.width  = Math.round(done / total * 100) + '%';
      }

      const label = total + ' book' + (total !== 1 ? 's' : '');
      document.getElementById('import-done-msg').textContent = label + ' imported successfully.';
      showState('done');
      Library.load();
    } catch (err) {
      console.error('Import failed:', err);
      if (err.message === 'AUTH_REQUIRED') { auth.signOut(); location.reload(); return; }
      alert('Import failed: ' + err.message);
      showState('preview');
    }
  }

  /* ---------- Cleanup ---------- */

  const PARTICLES = new Set([
    'a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor', 'on', 'at', 'to',
    'by', 'in', 'of', 'up', 'as', 'is', 'it', 'its', 'with', 'from', 'into',
  ]);

  // Build stray-quote regex from char codes -- avoids non-ASCII in source
  const _sqChars = [0x2018, 0x2019, 0x201c, 0x201d, 0x27, 0x22]
    .map((c) => String.fromCharCode(c)).join('');
  const STRAY_QUOTES = new RegExp('^[' + _sqChars + ']|[' + _sqChars + ']$', 'g');

  function applyTitleCase(s) {
    const chunks  = s.split(/(\s+)/);
    const wordIdx = chunks.reduce((a, c, i) => (/\S/.test(c) ? a.concat(i) : a), []);
    const first   = wordIdx[0];
    const last    = wordIdx[wordIdx.length - 1];
    return chunks.map((chunk, i) => {
      if (/\s/.test(chunk) || !chunk) return chunk;
      const lower = chunk.toLowerCase();
      if (i !== first && i !== last && PARTICLES.has(lower)) return lower;
      return chunk.split('-').map((p) => p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p).join('-');
    }).join('');
  }

  function applyNameCase(s) {
    return s.split(/(\s+)/).map((chunk) => {
      if (/\s/.test(chunk) || !chunk) return chunk;
      return chunk.split('-').map((p) => p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p).join('-');
    }).join('');
  }

  function needsCase(s) {
    const letters = s.replace(/[^a-zA-Z]/g, '');
    if (letters.length < 2) return false;
    if (letters === letters.toUpperCase() || letters === letters.toLowerCase()) return true;
    const words = s.trim().split(/\s+/);
    if (words.length > 1) {
      const rest = letters.slice(1);
      if (letters[0] === letters[0].toUpperCase() && rest === rest.toLowerCase()) return true;
    }
    return false;
  }

  function cleanAuthor(s) {
    if (!s) return null;
    let r = s.trim().replace(/\s+/g, ' ');
    r = r.replace(/^[Bb]y\s+/, '');
    r = r.replace(/[.,;:]+$/, '').trim();
    r = r.replace(STRAY_QUOTES, '').trim();
    if (needsCase(r)) r = applyNameCase(r);
    return r || null;
  }

  function cleanTitle(s) {
    if (!s) return null;
    let r = s.trim().replace(/\s+/g, ' ');
    r = r.replace(/[,;:]+$/, '').trim();
    r = r.replace(STRAY_QUOTES, '').trim();
    if (needsCase(r)) r = applyTitleCase(r);
    return r || null;
  }

  function isBroken(book) {
    const noIsbn   = !book.isbn   || !book.isbn.trim();
    const noAuthor = !book.author || !book.author.trim();
    const noTitle  = !book.title  || !book.title.trim() || book.title.trim() === 'Unknown title';
    return noIsbn && noAuthor && noTitle;
  }

  function computeFixes(books) {
    const toUpdate = [], toDelete = [];
    for (const book of books) {
      if (isBroken(book)) { toDelete.push(book); continue; }
      const newTitle  = cleanTitle(book.title);
      const newAuthor = cleanAuthor(book.author);
      const fields = {};
      if (newTitle  !== book.title)  fields.title  = newTitle;
      if (newAuthor !== book.author) fields.author = newAuthor;
      if (Object.keys(fields).length) toUpdate.push({ book, fields });
    }
    return { toUpdate, toDelete };
  }

  function renderCleanupResults(toUpdate, toDelete) {
    const el = document.getElementById('cleanup-results-content');
    if (toUpdate.length === 0 && toDelete.length === 0) {
      el.innerHTML = '<p class="cleanup-clean">No issues found -- library looks good!</p>';
      document.getElementById('btn-cleanup-apply').hidden = true;
      document.getElementById('btn-cleanup-cancel').textContent = 'Done';
    } else {
      document.getElementById('btn-cleanup-apply').hidden = false;
      document.getElementById('btn-cleanup-apply').textContent =
        'Apply fixes (' + (toUpdate.length + toDelete.length) + ')';
      document.getElementById('btn-cleanup-cancel').textContent = 'Cancel';

      const examples = toUpdate.slice(0, 4).map(function(item) {
        const book   = item.book;
        const fields = item.fields;
        if (fields.author && fields.title) return '"' + escHtml(book.author) + '" + title -> corrected';
        if (fields.author) return escHtml(book.author) + ' -> ' + escHtml(fields.author);
        if (fields.title)  return escHtml(book.title)  + ' -> ' + escHtml(fields.title);
        return '';
      });

      let html = '';
      if (toUpdate.length) {
        html += '<p class="cleanup-stat"><strong>' + toUpdate.length + '</strong> book' +
          (toUpdate.length !== 1 ? 's' : '') + ' with fixable text</p>';
        if (examples.length) {
          html += '<ul class="cleanup-examples">' +
            examples.map((e) => '<li>' + e + '</li>').join('') + '</ul>';
          if (toUpdate.length > examples.length) {
            html += '<p class="cleanup-more">...and ' + (toUpdate.length - examples.length) + ' more</p>';
          }
        }
      }
      if (toDelete.length) {
        html += '<p class="cleanup-stat cleanup-danger"><strong>' + toDelete.length +
          '</strong> broken entr' + (toDelete.length !== 1 ? 'ies' : 'y') +
          ' with no useful data (will be deleted)</p>';
      }
      el.innerHTML = html;
    }
  }

  function showCleanupState(name) {
    ['idle', 'results', 'working', 'done'].forEach((s) => {
      document.getElementById('cleanup-' + s).hidden = (s !== name);
    });
  }

  async function runCleanup(toUpdate, toDelete) {
    try {
      for (const item of toUpdate) {
        const updated = await db.update(item.book.id, item.fields);
        Library.updateLocal(updated);
      }
      for (const book of toDelete) {
        await db.remove(book.id);
        Library.removeLocal(book.id);
      }
      const parts = [];
      if (toUpdate.length) parts.push(toUpdate.length + ' corrected');
      if (toDelete.length) parts.push(toDelete.length + ' deleted');
      document.getElementById('cleanup-done-msg').textContent = 'Done -- ' + parts.join(', ') + '.';
      showCleanupState('done');
    } catch (err) {
      console.error('Cleanup failed:', err);
      if (err.message === 'AUTH_REQUIRED') { auth.signOut(); location.reload(); return; }
      alert('Cleanup failed: ' + err.message);
      showCleanupState('idle');
    }
  }

  /* ---------- Enrich ---------- */

  function showEnrichState(name) {
    ['idle', 'running', 'done'].forEach((s) => {
      document.getElementById('enrich-' + s).hidden = (s !== name);
    });
  }

  async function runEnrich() {
    console.log('[Enrich] starting');
    showEnrichState('running');

    const progressText = document.getElementById('enrich-progress-text');
    const progressBar  = document.getElementById('enrich-progress-bar');
    progressBar.style.width = '0%';

    let books;
    try {
      books = await db.getUnenriched();
      console.log('[Enrich] unenriched count:', books ? books.length : 0);
    } catch (err) {
      console.error('[Enrich] fetch error:', err);
      alert('Could not fetch books: ' + err.message);
      showEnrichState('idle');
      return;
    }

    if (!books || books.length === 0) {
      document.getElementById('enrich-done-msg').textContent =
        'Nothing to enrich -- all ISBNs already have cover data.';
      showEnrichState('done');
      return;
    }

    let enriched = 0, notFound = 0;
    const total = books.length;

    for (let i = 0; i < books.length; i++) {
      progressText.textContent = 'Looking up ' + (i + 1) + ' of ' + total + '...';
      progressBar.style.width  = Math.round((i / total) * 100) + '%';
      await new Promise((r) => setTimeout(r, 600));
      try {
        const data = await lookupIsbn(books[i].isbn);
        if (!data) { notFound++; continue; }
        const fields = {};
        if (data.cover_url)    fields.cover_url    = data.cover_url;
        if (data.publisher)    fields.publisher    = data.publisher;
        if (data.publish_year) fields.publish_year = data.publish_year;
        if (Object.keys(fields).length === 0) { notFound++; continue; }
        const updated = await db.update(books[i].id, fields);
        Library.updateLocal(updated);
        enriched++;
      } catch (err) {
        if (err.message === 'AUTH_REQUIRED') { auth.signOut(); location.reload(); return; }
        notFound++;
      }
    }

    progressBar.style.width = '100%';
    const parts = [];
    if (enriched)  parts.push(enriched + ' updated');
    if (notFound)  parts.push(notFound + ' not found on Open Library');
    const remaining = await db.getUnenriched().catch(() => null);
    if (remaining && remaining.length > 0) parts.push(remaining.length + ' more still pending');
    document.getElementById('enrich-done-msg').textContent = (parts.join(', ') || 'Done') + '.';
    showEnrichState('done');
  }

  function initEnrich() {
    document.getElementById('btn-enrich-now').addEventListener('click', () => {
      console.log('[Enrich] button clicked');
      runEnrich().catch((err) => console.error('[Enrich] error:', err));
    });
    document.getElementById('btn-enrich-again').addEventListener('click', () => showEnrichState('idle'));
  }

  function setCleanupWorkingMsg(text) {
    document.getElementById('cleanup-working-msg').textContent = text;
  }

  function initCleanup() {
    let pendingUpdate = [], pendingDelete = [];

    document.getElementById('btn-cleanup-scan').addEventListener('click', async () => {
      console.log('[Cleanup] scan clicked');
      setCleanupWorkingMsg('Scanning library...');
      showCleanupState('working');
      try {
        const books = await db.getAll();
        console.log('[Cleanup] books fetched:', books ? books.length : 0);
        const result = computeFixes(books);
        pendingUpdate = result.toUpdate;
        pendingDelete = result.toDelete;
        renderCleanupResults(pendingUpdate, pendingDelete);
        showCleanupState('results');
      } catch (err) {
        alert('Scan failed: ' + err.message);
        showCleanupState('idle');
      }
    });

    document.getElementById('btn-cleanup-apply').addEventListener('click', () => {
      setCleanupWorkingMsg('Applying fixes...');
      showCleanupState('working');
      runCleanup(pendingUpdate, pendingDelete);
    });

    document.getElementById('btn-cleanup-cancel').addEventListener('click', () => showCleanupState('idle'));
    document.getElementById('btn-cleanup-again').addEventListener('click', () => showCleanupState('idle'));
  }

  /* ---------- Init / reset ---------- */

  function reset() {
    parsedRows = [];
    const fi = document.getElementById('import-file-input');
    if (fi) fi.value = '';
    showState('pick');
  }

  function init() {
    console.log('[Importer] init() called');
    initEnrich();
    initCleanup();

    const fileInput = document.getElementById('import-file-input');
    const dropzone  = document.getElementById('import-dropzone');

    fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      handleFile(e.dataTransfer.files[0]);
    });

    document.getElementById('btn-import-go').addEventListener('click', runImport);
    document.getElementById('btn-import-clear').addEventListener('click', reset);
    document.getElementById('btn-import-again').addEventListener('click', reset);
  }

  return { init, reset };
})();
