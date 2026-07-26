// Radius Defect Checklist — work-in-progress cross-device sync
//
// Lets someone continue an inspection they started on one device (say, their
// phone on site) from a different device (their laptop back at the office).
// This is separate from the reviewed/approved central record — it's just a
// convenience copy of the LIVE, editable data (every tick, note, and photo),
// scoped to whoever's personal key created it.
//
// The tool quietly uploads a copy of the in-progress inspection to
// reports/<slug>/wip-data.json (via submit-inspection.js, kind:'wip') every
// so often while someone's working. This function lets another device find
// and pull that copy back down:
//   GET  (no params)              -> list of your own in-progress inspections
//   GET  ?download=<slug>&chunk=N -> one chunk of a specific inspection's data
//
// Downloads are chunked the same way uploads are — a full inspection's worth
// of photos can be several MB, too big to send back in one response.

const GITHUB_API = 'https://api.github.com';
const CHUNK_SIZE = 900000; // matches the upload chunk size used elsewhere

exports.handler = async (event) => {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!token || !owner || !repo) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server is not configured yet (missing GITHUB_TOKEN/OWNER/REPO).' }) };
  }

  function ghHeaders() {
    return {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'radius-defect-checklist-tool'
    };
  }

  const KEYS_PATH = 'reports/team-keys.json';
  async function resolveSubmitter(suppliedKey) {
    if (!suppliedKey) return { ok: false, reason: 'No key supplied.' };
    try {
      const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${KEYS_PATH}?ref=${branch}`, { headers: ghHeaders() });
      if (res.status === 200) {
        const j = await res.json();
        const parsed = JSON.parse(Buffer.from(j.content, 'base64').toString('utf-8'));
        const match = (parsed.keys || []).find(k => k.key === suppliedKey);
        if (!match) return { ok: false, reason: 'Key not recognised.' };
        if (match.active === false) return { ok: false, reason: 'This key has been deactivated.' };
        return { ok: true, name: match.name };
      }
      if (res.status !== 404) return { ok: false, reason: 'Could not check team-keys.json (status ' + res.status + ').' };
      const legacy = process.env.SUBMIT_SECRET;
      if (legacy && suppliedKey === legacy) return { ok: true, name: 'Unassigned (shared key)' };
      return { ok: false, reason: 'Key not recognised.' };
    } catch (err) {
      return { ok: false, reason: String(err && err.message ? err.message : err) };
    }
  }

  const suppliedKey = event.headers['x-submit-key'] || event.headers['X-Submit-Key'];
  const auth = await resolveSubmitter(suppliedKey);
  if (!auth.ok) {
    return { statusCode: 401, body: JSON.stringify({ error: auth.reason || 'Invalid or missing key.' }) };
  }

  const WIP_INDEX_PATH = 'reports/wip-index.json';
  async function getWipIndex() {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${WIP_INDEX_PATH}?ref=${branch}`, { headers: ghHeaders() });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error('Failed to read wip-index (' + res.status + ')');
    const j = await res.json();
    return JSON.parse(Buffer.from(j.content, 'base64').toString('utf-8'));
  }

  const qp = event.queryStringParameters || {};

  // ---- Download one chunk of a specific in-progress inspection ----
  if (event.httpMethod === 'GET' && qp.download) {
    const slug = String(qp.download).replace(/[^a-zA-Z0-9_\-]/g, '-');
    const chunkIndex = parseInt(qp.chunk || '0', 10);
    try {
      const list = await getWipIndex();
      const entry = list.find(r => r.slug === slug);
      if (!entry) return { statusCode: 404, body: JSON.stringify({ error: 'No in-progress copy found for that job.' }) };
      if (entry.submittedBy !== auth.name) {
        return { statusCode: 403, body: JSON.stringify({ error: 'That in-progress inspection belongs to a different key.' }) };
      }
      const path = `reports/${slug}/wip-data.json`;
      const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, { headers: ghHeaders() });
      if (!res.ok) return { statusCode: res.status, body: JSON.stringify({ error: 'Could not fetch the in-progress data.' }) };
      const j = await res.json();
      const fullBase64 = (j.content || '').replace(/\n/g, '');
      const totalChunks = Math.max(Math.ceil(fullBase64.length / CHUNK_SIZE), 1);
      const chunkData = fullBase64.slice(chunkIndex * CHUNK_SIZE, (chunkIndex + 1) * CHUNK_SIZE);
      return { statusCode: 200, body: JSON.stringify({ ok: true, chunkData, chunkIndex, totalChunks, meta: entry.meta }) };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message ? err.message : err) }) };
    }
  }

  // ---- List my own in-progress inspections ----
  try {
    const list = await getWipIndex();
    const mine = list.filter(r => r.submittedBy === auth.name);
    return { statusCode: 200, body: JSON.stringify({ ok: true, list: mine }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message ? err.message : err) }) };
  }
};

