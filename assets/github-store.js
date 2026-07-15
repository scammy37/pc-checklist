// Shared GitHub-backed data store for the PC Checklist app.
// Data lives in this repo as JSON files (data/index.json, data/checklists/<ticket>.json)
// so techs on different PCs share the same state by reading/writing the same repo.

const GH_OWNER = 'scammy37';
const GH_REPO = 'pc-checklist';
const GH_BRANCH = 'main';
const GH_API = 'https://api.github.com';

const TOKEN_KEY = 'pcChecklistGhToken';

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

function sanitizeTicket(raw) {
  return (raw || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '-').slice(0, 64);
}

function b64EncodeUnicode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function b64DecodeUnicode(str) {
  return decodeURIComponent(escape(atob(str.replace(/\n/g, ''))));
}

function authHeaders(requireToken) {
  const token = getToken();
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  else if (requireToken) throw new Error('A GitHub token is required to save changes. Add one under Settings.');
  return headers;
}

async function ghGetFile(path) {
  const res = await fetch(
    `${GH_API}/repos/${GH_OWNER}/${GH_REPO}/contents/${path}?ref=${GH_BRANCH}&_=${Date.now()}`,
    { headers: authHeaders(false) }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub read failed (${res.status}): ${res.statusText}`);
  const data = await res.json();
  return { json: JSON.parse(b64DecodeUnicode(data.content)), sha: data.sha };
}

async function ghPutFile(path, obj, message, sha) {
  const body = {
    message,
    content: b64EncodeUnicode(JSON.stringify(obj, null, 2)),
    branch: GH_BRANCH,
  };
  if (sha) body.sha = sha;
  const res = await fetch(`${GH_API}/repos/${GH_OWNER}/${GH_REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { ...authHeaders(true), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(`GitHub write failed (${res.status}): ${errBody.message || res.statusText}`);
  }
  return res.json();
}

// Re-fetches the file, applies mutateFn to its current contents, and writes the
// result back with the fresh sha. Retries once on a 409 conflict so a second
// tech saving at nearly the same time doesn't lose their update.
async function saveWithRetry(path, mutateFn, message, emptyDefault) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await ghGetFile(path);
    const nextObj = mutateFn(current ? current.json : emptyDefault);
    try {
      await ghPutFile(path, nextObj, message, current ? current.sha : undefined);
      return nextObj;
    } catch (e) {
      lastErr = e;
      if (attempt === 0 && /\(409\)|\(422\)/.test(e.message)) continue;
      throw e;
    }
  }
  throw lastErr;
}

const INDEX_PATH = 'data/index.json';
const EMPTY_INDEX = { checklists: [] };

function checklistPath(ticket) {
  return `data/checklists/${sanitizeTicket(ticket)}.json`;
}

async function loadIndex() {
  const result = await ghGetFile(INDEX_PATH);
  return result ? result.json : EMPTY_INDEX;
}

async function loadChecklist(ticket) {
  const result = await ghGetFile(checklistPath(ticket));
  return result ? result.json : null;
}

async function upsertIndexEntry(entry) {
  return saveWithRetry(
    INDEX_PATH,
    (indexObj) => {
      const idx = { checklists: [...(indexObj?.checklists || [])] };
      const i = idx.checklists.findIndex((c) => c.ticket === entry.ticket);
      if (i >= 0) idx.checklists[i] = { ...idx.checklists[i], ...entry };
      else idx.checklists.push(entry);
      return idx;
    },
    `Update index for ${entry.ticket}`,
    EMPTY_INDEX
  );
}

async function saveChecklist(ticket, mutateFn, message) {
  return saveWithRetry(checklistPath(ticket), mutateFn, message, null);
}

window.PCStore = {
  getToken,
  setToken,
  sanitizeTicket,
  loadIndex,
  loadChecklist,
  saveChecklist,
  upsertIndexEntry,
};
