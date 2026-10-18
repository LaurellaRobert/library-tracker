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

  // Same ISBN, or same title + author when there's no ISBN, counts as the same book
  function bookKey(b) {
    if (b.isbn) return 'i:' + b.isbn;
    return 't:' + (b.title || '').trim().toLowerCase() + '|' + (b.author || '').trim().toLowerCase();
  }

  // Drop rows already in the library (or repeated within the file)
  async function removeDuplicates(rows) {
    let existing = [];
    try { existing = await db.getAll(); } catch (_) { /* can't check — import everything */ }
    const seen = new Set(existing.map(bookKey));
    const fresh = [];
    for (const r of rows) {
      const k = bookKey(r);
      if (seen.has(k)) continue;
      seen.add(k);
      fresh.push(r);
    }
    return fresh;
  }

  function handleFile(file) {
    if (!file || !file.name.match(/\.csv$/i)) {
      showToast('Please select a CSV file');
      return;
    }
    const reader = new FileReader();
    reader.onload = async (e) => {
      const { rows, error } = parseCSV(e.target.result);
      if (error) { showToast(error, 4000); return; }
      if (rows.length === 0) {
        showToast('No importable rows found — the file needs isbn and/or title columns', 4000);
        return;
      }

      const fresh   = await removeDuplicates(rows);
      const skipped = rows.length - fresh.length;
      const plural  = (n) => n + ' book' + (n !== 1 ? 's' : '');
      if (fresh.length === 0) {
        showToast('All ' + plural(rows.length) + ' in this file are already in your library', 4000);
        reset();
        return;
      }
      parsedRows = fresh;

      document.getElementById('import-count').textContent = plural(fresh.length) + ' ready to import' +
        (skipped ? ' · ' + skipped + ' already in your library will be skipped' : '');
      document.getElementById('btn-import-go').textContent = 'Import ' + plural(fresh.length);

      renderPreview(fresh);
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
      Tools.refresh();
    } catch (err) {
      console.error('Import failed:', err);
      if (err.message === 'AUTH_REQUIRED') { auth.signOut(); location.reload(); return; }
      showToast('Import failed: ' + err.message, 4000);
      showState('preview');
    }
  }

  /* ---------- Init / reset ---------- */

  function reset() {
    parsedRows = [];
    const fi = document.getElementById('import-file-input');
    if (fi) fi.value = '';
    showState('pick');
  }

  function init() {
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
