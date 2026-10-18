const Tools = (() => {
  let books      = [];    // fresh copy from the DB each time the Tools tab opens
  let hasChecked = true;  // whether the books table has the cover_checked_at column

  const $ = (id) => document.getElementById(id);
  const plural = (n, word, many = word + 's') => n + ' ' + (n === 1 ? word : many);

  function escHtml(s) {
    return (s || '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function showState(prefix, states, name) {
    states.forEach((s) => { $(prefix + '-' + s).hidden = (s !== name); });
  }

  async function refresh() {
    try {
      books = await db.getAll();
    } catch (err) {
      console.error('[Tools] load failed:', err);
      return;
    }
    hasChecked = books.length === 0 || 'cover_checked_at' in books[0];
    $('covers-setup').hidden = hasChecked;
    if (covers.state === 'idle') renderCoversIdle();
    if (text.state === 'idle')   renderTextIdle();
  }

  /* ================= Missing covers ================= */

  const covers = { state: 'idle', items: [], stop: false };
  const COVER_STATES = ['idle', 'running', 'review', 'done'];

  const missingCover = (b) => !b.cover_url && !isBroken(b); // empty entries belong to Tidy
  const toCheck      = (b) => missingCover(b) && !b.cover_checked_at;

  function setCoversState(name) {
    covers.state = name;
    showState('covers', COVER_STATES, name);
    $('covers-results').hidden = !(name === 'running' || name === 'review');
  }

  function renderCoversIdle() {
    const pending = books.filter(toCheck).length;
    const checked = books.filter((b) => missingCover(b) && b.cover_checked_at).length;
    const badge = $('covers-badge');
    badge.textContent = pending;
    badge.hidden = pending === 0;

    $('covers-desc').textContent = pending
      ? `${plural(pending, 'book')} without a cover. Searches Open Library, Google Books, Apple Books and Amazon — you review before anything is saved.`
      : checked
        ? 'Every book has a cover, apart from ones no source could find.'
        : 'Every book has a cover. ✓';
    $('btn-covers-find').hidden = pending === 0;

    const retry = $('btn-covers-retry');
    retry.hidden = checked === 0;
    retry.textContent = `Search again for ${plural(checked, 'book')} with no cover found`;
    setCoversState('idle');
  }

  async function runCovers(includeChecked) {
    const queue = books.filter(includeChecked ? missingCover : toCheck);
    if (!queue.length) return;

    covers.items = [];
    covers.stop  = false;
    $('covers-found').innerHTML   = '';
    $('covers-missing').innerHTML = '';
    updateCoverHeads();
    setCoversState('running');

    for (let i = 0; i < queue.length && !covers.stop; i++) {
      const book = queue[i];
      $('covers-progress-text').textContent = `Searching ${i + 1} of ${queue.length}…`;
      $('covers-progress-bar').style.width = Math.round((i / queue.length) * 100) + '%';

      let found = null;
      if (book.isbn) {
        try { found = await findCover(book.isbn); } catch (_) {}
      }
      addCoverItem(book, found);
      if (book.isbn) await new Promise((r) => setTimeout(r, 300)); // be gentle with Open Library
    }

    $('covers-progress-bar').style.width = '100%';
    setCoversState('review');
    updateCoverHeads();
  }

  function addCoverItem(book, found) {
    const item = { book, found: found && found.url ? found : null, el: null, picked: true, input: null };
    covers.items.push(item);
    const sub = escHtml(book.author || '');

    if (item.found) {
      const el = document.createElement('label');
      el.className = 'cover-pick';
      el.innerHTML = `
        <input type="checkbox" checked>
        <img src="${escHtml(item.found.url)}" alt="">
        <span class="cover-pick-title">${escHtml(book.title)}</span>
        <span class="cover-pick-meta">${escHtml(item.found.source)}</span>`;
      const box = el.querySelector('input');
      box.addEventListener('change', () => {
        item.picked = box.checked;
        el.classList.toggle('off', !box.checked);
        updateCoverHeads();
      });
      item.el = el;
      $('covers-found').appendChild(el);
    } else {
      const el = document.createElement('div');
      el.className = 'cover-missing';
      el.innerHTML = `
        <img class="cover-missing-thumb" src="${Library.PLACEHOLDER_COVER}" alt="">
        <div class="cover-missing-info">
          <span class="cover-pick-title">${escHtml(book.title)}</span>
          <span class="cover-pick-meta">${[sub, book.isbn ? '' : 'no ISBN'].filter(Boolean).join(' · ') || '&nbsp;'}</span>
          <input type="url" class="text-field cover-missing-url" placeholder="Paste an image link (optional)">
        </div>`;
      const input = el.querySelector('input');
      const thumb = el.querySelector('img');
      thumb.addEventListener('error', () => { thumb.src = Library.PLACEHOLDER_COVER; });
      input.addEventListener('input', () => {
        thumb.src = input.value.trim() || Library.PLACEHOLDER_COVER;
        updateCoverHeads();
      });
      item.el = el;
      item.input = input;
      $('covers-missing').appendChild(el);
    }
    updateCoverHeads();
  }

  function coverChoices() {
    const save = [], mark = [];
    for (const it of covers.items) {
      const pasted = it.input && it.input.value.trim();
      if (it.found && it.picked) save.push({ it, url: it.found.url });
      else if (pasted)           save.push({ it, url: pasted });
      else                       mark.push(it); // rejected or nothing found: don't search again
    }
    return { save, mark };
  }

  function updateCoverHeads() {
    const found   = covers.items.filter((i) => i.found).length;
    const missing = covers.items.length - found;
    $('covers-found-head').textContent = found
      ? `Found ${plural(found, 'cover')} — untick any that look wrong`
      : (covers.state === 'running' ? 'Searching…' : 'No covers found');
    $('covers-found-head').hidden   = covers.state === 'review' && !found;
    $('covers-missing-head').textContent = `No cover found (${missing})`;
    $('covers-missing-head').hidden = missing === 0;
    $('covers-missing-hint').hidden = missing === 0;

    const { save } = coverChoices();
    $('btn-covers-save').textContent = save.length ? `Save ${plural(save.length, 'cover')}` : 'Save';
  }

  async function saveCovers() {
    const { save, mark } = coverChoices();
    $('btn-covers-save').disabled = true;
    $('covers-progress-text').textContent = 'Saving…';
    setCoversState('running');
    $('btn-covers-stop').hidden = true;

    let saved = 0, marked = 0, failed = 0;
    const now = new Date().toISOString();
    try {
      for (const { it, url } of save) {
        const fields = { cover_url: url };
        // Fill publisher/year while we're here, but never overwrite what's there
        if (it.found && url === it.found.url) {
          if (!it.book.publisher    && it.found.publisher)    fields.publisher    = it.found.publisher;
          if (!it.book.publish_year && it.found.publish_year) fields.publish_year = it.found.publish_year;
        }
        try {
          Library.updateLocal(await db.update(it.book.id, fields));
          saved++;
        } catch (err) {
          if (err.message === 'AUTH_REQUIRED') throw err;
          failed++;
        }
      }
      if (hasChecked) {
        for (const it of mark) {
          try {
            Library.updateLocal(await db.update(it.book.id, { cover_checked_at: now }));
            marked++;
          } catch (err) {
            if (err.message === 'AUTH_REQUIRED') throw err;
            failed++;
          }
        }
      }
    } catch (err) {
      if (err.message === 'AUTH_REQUIRED') { auth.signOut(); location.reload(); return; }
      throw err;
    } finally {
      $('btn-covers-save').disabled = false;
      $('btn-covers-stop').hidden = false;
    }

    const parts = [];
    if (saved)  parts.push(`Saved ${plural(saved, 'cover')}.`);
    if (marked) parts.push(`${plural(marked, 'book')} with no cover won't be searched again.`);
    if (!hasChecked && mark.length) parts.push(`${plural(mark.length, 'book')} without a cover will be searched again next time.`);
    if (failed) parts.push(`${failed} couldn't be saved — check your connection and try again.`);
    $('covers-done-msg').textContent = parts.join(' ') || 'Nothing to save.';
    setCoversState('done');
    refresh();
  }

  function initCovers() {
    $('btn-covers-find').addEventListener('click', () => runCovers(false));
    $('btn-covers-retry').addEventListener('click', () => runCovers(true));
    $('btn-covers-stop').addEventListener('click', () => {
      covers.stop = true;
      $('covers-progress-text').textContent = 'Stopping…';
    });
    $('btn-covers-save').addEventListener('click', saveCovers);
    $('btn-covers-cancel').addEventListener('click', () => { covers.items = []; renderCoversIdle(); });
    $('btn-covers-done').addEventListener('click', () => { covers.items = []; renderCoversIdle(); });
    $('btn-copy-sql').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText($('covers-setup-sql').textContent);
        showToast('SQL copied');
      } catch (_) {
        showToast('Select the SQL and copy it manually');
      }
    });
  }

  /* ================= Tidy titles & authors ================= */

  const text = { state: 'idle', changes: [] };
  const TEXT_STATES = ['idle', 'review', 'working', 'done'];

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

  function computeChanges() {
    const changes = [];
    for (const book of books) {
      if (isBroken(book)) { changes.push({ book, remove: true, picked: true }); continue; }
      const fields = {};
      const t = cleanTitle(book.title);
      const a = cleanAuthor(book.author);
      if (t && t !== book.title)  fields.title  = t;
      if (a !== (book.author || null) && (a || book.author)) fields.author = a;
      if (Object.keys(fields).length) changes.push({ book, fields, picked: true });
    }
    return changes;
  }

  function renderTextIdle() {
    text.changes = computeChanges();
    const n = text.changes.length;
    const badge = $('text-badge');
    badge.textContent = n;
    badge.hidden = n === 0;
    $('text-desc').textContent = n
      ? `${plural(n, 'book')} with messy text: odd capitalisation, stray punctuation or quotes, or empty entries. Review each change before applying.`
      : 'Titles and authors look tidy. ✓';
    $('btn-text-review').hidden = n === 0;
    text.state = 'idle';
    showState('text', TEXT_STATES, 'idle');
  }

  function renderTextReview() {
    const list = $('text-list');
    list.innerHTML = '';
    const edits   = text.changes.filter((c) => !c.remove);
    const removes = text.changes.filter((c) => c.remove);

    const section = (title, items, cls) => {
      if (!items.length) return;
      const h = document.createElement('h4');
      h.className = 'tool-subhead' + (cls ? ' ' + cls : '');
      h.textContent = title;
      list.appendChild(h);
      items.forEach((c) => {
        const row = document.createElement('label');
        row.className = 'text-change';
        let body;
        if (c.remove) {
          body = `<span class="text-change-line">Empty entry${c.book.added_at ? ' added ' + new Date(c.book.added_at).toLocaleDateString() : ''} — will be deleted</span>`;
        } else {
          body = Object.entries(c.fields).map(([k, v]) =>
            `<span class="text-change-line"><span class="text-change-field">${k}</span>` +
            `<span class="text-change-old">${escHtml(c.book[k] || '—')}</span>` +
            `<span class="text-change-arrow">→</span>` +
            `<span class="text-change-new">${escHtml(v || '—')}</span></span>`).join('');
        }
        row.innerHTML = `<input type="checkbox" checked><span class="text-change-body">${body}</span>`;
        const box = row.querySelector('input');
        box.addEventListener('change', () => {
          c.picked = box.checked;
          row.classList.toggle('off', !box.checked);
          updateTextApply();
        });
        list.appendChild(row);
      });
    };
    section(`Tidy ${plural(edits.length, 'book')}`, edits);
    section(`Delete ${plural(removes.length, 'empty entry', 'empty entries')}`, removes, 'tool-danger');
    updateTextApply();
    text.state = 'review';
    showState('text', TEXT_STATES, 'review');
  }

  function updateTextApply() {
    const n = text.changes.filter((c) => c.picked).length;
    const btn = $('btn-text-apply');
    btn.textContent = n ? `Apply ${plural(n, 'change')}` : 'Apply';
    btn.disabled = n === 0;
  }

  async function applyText() {
    const picked = text.changes.filter((c) => c.picked);
    text.state = 'working';
    showState('text', TEXT_STATES, 'working');
    let fixed = 0, removed = 0, failed = 0;
    for (let i = 0; i < picked.length; i++) {
      const c = picked[i];
      $('text-working-msg').textContent = `Applying ${i + 1} of ${picked.length}…`;
      try {
        if (c.remove) {
          await db.remove(c.book.id);
          Library.removeLocal(c.book.id);
          removed++;
        } else {
          Library.updateLocal(await db.update(c.book.id, c.fields));
          fixed++;
        }
      } catch (err) {
        if (err.message === 'AUTH_REQUIRED') { auth.signOut(); location.reload(); return; }
        failed++;
      }
    }
    const parts = [];
    if (fixed)   parts.push(`Tidied ${plural(fixed, 'book')}.`);
    if (removed) parts.push(`Deleted ${plural(removed, 'empty entry', 'empty entries')}.`);
    if (failed)  parts.push(`${failed} couldn't be saved — check your connection and try again.`);
    $('text-done-msg').textContent = parts.join(' ') || 'Nothing changed.';
    text.state = 'done';
    showState('text', TEXT_STATES, 'done');
    refresh();
  }

  function initText() {
    $('btn-text-review').addEventListener('click', renderTextReview);
    $('btn-text-cancel').addEventListener('click', renderTextIdle);
    $('btn-text-apply').addEventListener('click', applyText);
    $('btn-text-done').addEventListener('click', renderTextIdle);
  }

  function init() {
    initCovers();
    initText();
  }

  return { init, refresh };
})();
