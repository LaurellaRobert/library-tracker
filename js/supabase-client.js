const SUPABASE_URL  = 'https://fleionvdiskrwapgtvkz.supabase.co';
const SUPABASE_ANON = 'sb_publishable_XsaDr96GwZfb9PMdxkfqKg_PIQTVMEa';

const REST_BASE = `${SUPABASE_URL}/rest/v1`;
const AUTH_BASE = `${SUPABASE_URL}/auth/v1`;
const TOKEN_KEY = 'library-tracker-auth';

/* ---------- Token storage ---------- */

function getStoredAuth() {
  try { return JSON.parse(localStorage.getItem(TOKEN_KEY)); } catch { return null; }
}

function storeAuth(data) {
  localStorage.setItem(TOKEN_KEY, JSON.stringify({
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_at:    data.expires_at ?? (Date.now() / 1000 + (data.expires_in ?? 3600)),
  }));
}

function authHeaders() {
  const token = getStoredAuth()?.access_token ?? SUPABASE_ANON;
  return {
    'apikey':        SUPABASE_ANON,
    'Authorization': `Bearer ${token}`,
    'Content-Type':  'application/json',
  };
}

/* ---------- Auth API ---------- */

// Supabase Auth reports errors as `msg` (newer) or `error_description` / `message` (older)
function authError(data, fallback) {
  return new Error(data.msg || data.error_description || data.message || fallback);
}

async function signIn(email, password) {
  const res = await fetch(`${AUTH_BASE}/token?grant_type=password`, {
    method:  'POST',
    headers: { apikey: SUPABASE_ANON, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw authError(data, 'Sign-in failed');
  storeAuth(data);
  return data;
}

// Emails a reset link that opens this app with a recovery token in the URL hash
async function requestPasswordReset(email) {
  const redirectTo = location.origin + location.pathname;
  const res = await fetch(`${AUTH_BASE}/recover?redirect_to=${encodeURIComponent(redirectTo)}`, {
    method:  'POST',
    headers: { apikey: SUPABASE_ANON, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ email }),
  });
  if (!res.ok) throw authError(await res.json().catch(() => ({})), 'Could not send reset email');
}

// Sets a new password for the signed-in user (e.g. after following a reset/invite link)
async function updatePassword(password) {
  const res = await fetch(`${AUTH_BASE}/user`, {
    method:  'PUT',
    headers: authHeaders(),
    body:    JSON.stringify({ password }),
  });
  if (!res.ok) throw authError(await res.json().catch(() => ({})), 'Could not update password');
}

/**
 * Reset, invite and magic links land here with the session (or an error) in
 * the URL hash. Stores the session, clears the hash, and reports what happened:
 * { type: 'recovery' | 'invite' | 'signup' | 'magiclink' } or { error: message } or null.
 */
function consumeAuthRedirect() {
  if (!location.hash || location.hash.length < 2) return null;
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.has('access_token') && !p.has('error')) return null;
  history.replaceState(null, '', location.pathname + location.search);

  if (p.has('error')) {
    const code = p.get('error_code');
    return {
      error: code === 'otp_expired'
        ? 'That link has expired or was already used. Request a new one below.'
        : (p.get('error_description') || 'That link didn’t work. Request a new one below.').replace(/\+/g, ' '),
    };
  }
  storeAuth({
    access_token:  p.get('access_token'),
    refresh_token: p.get('refresh_token'),
    expires_at:    p.has('expires_at') ? Number(p.get('expires_at')) : undefined,
    expires_in:    p.has('expires_in') ? Number(p.get('expires_in')) : undefined,
  });
  return { type: p.get('type') || 'magiclink' };
}

async function refreshSession() {
  const stored = getStoredAuth();
  if (!stored?.refresh_token) return null;
  const res = await fetch(`${AUTH_BASE}/token?grant_type=refresh_token`, {
    method:  'POST',
    headers: { apikey: SUPABASE_ANON, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ refresh_token: stored.refresh_token }),
  });
  if (!res.ok) { localStorage.removeItem(TOKEN_KEY); return null; }
  const data = await res.json();
  storeAuth(data);
  return data;
}

function isAuthenticated() {
  const a = getStoredAuth();
  if (!a?.access_token) return false;
  // expires_at is a unix timestamp in seconds; give 60s buffer
  if (a.expires_at && Date.now() / 1000 > a.expires_at - 60) return false;
  return true;
}

function signOut() {
  localStorage.removeItem(TOKEN_KEY);
}

/* ---------- PostgREST fetch ---------- */

async function sbFetch(path, opts = {}) {
  const attempt = () => fetch(`${REST_BASE}${path}`, {
    ...opts,
    headers: { ...authHeaders(), ...(opts.headers ?? {}) },
  });

  let res = await attempt();

  // On 401, try a silent token refresh then retry once
  if (res.status === 401) {
    const refreshed = await refreshSession();
    if (!refreshed) throw new Error('AUTH_REQUIRED');
    res = await attempt();
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? `Supabase error ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

/* ---------- Books CRUD ---------- */

const db = {
  async getAll() {
    return sbFetch('/books?select=*&order=added_at.desc');
  },

  async findByIsbn(isbn) {
    const rows = await sbFetch(`/books?isbn=eq.${encodeURIComponent(isbn)}&select=*&limit=1`);
    return rows?.length ? rows[0] : null;
  },

  async insert(book) {
    const rows = await sbFetch('/books?select=*', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(book),
    });
    return Array.isArray(rows) ? rows[0] : rows;
  },

  async update(id, fields) {
    const rows = await sbFetch(`/books?id=eq.${id}&select=*`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(fields),
    });
    return Array.isArray(rows) ? rows[0] : rows;
  },

  async remove(id) {
    await sbFetch(`/books?id=eq.${id}`, { method: 'DELETE' });
  },

  async getUnenriched() {
    return sbFetch('/books?isbn=not.is.null&cover_url=is.null&select=id,isbn&order=added_at.asc');
  },

  async bulkInsert(books) {
    if (!books.length) return [];
    const rows = await sbFetch('/books?select=*', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(books),
    });
    return Array.isArray(rows) ? rows : rows ? [rows] : [];
  },
};

const auth = {
  signIn, signOut, refreshSession, isAuthenticated,
  requestPasswordReset, updatePassword, consumeAuthRedirect,
};
