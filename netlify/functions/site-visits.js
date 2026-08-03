// Radius Defect Checklist — list and review logged site visits
//
// Two ways in:
//   - Personal key (X-Submit-Key): lists every visit, used by "Recent
//     visits" in the Log Site Visit modal for viewing/editing your own or a
//     teammate's recent entries.
//   - Manager key (X-Review-Key): same listing, plus the ability to approve
//     one — this is what powers the Site Visits section inside the same
//     Review queue used for inspection reports.
//
// Required Netlify environment variables:
//   GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH (optional)
//   REVIEW_SECRET (for the manager/approve path)

const GITHUB_API = 'https://api.github.com';

exports.handler = async (event) => {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  if (!token || !owner || !repo) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server is not configured yet.' }) };
  }

  function ghHeaders() {
    return {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'radius-defect-checklist-tool'
    };
  }
  async function ghGetRaw(path) {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, { headers: ghHeaders() });
    if (res.status === 404) return { exists: false };
    if (!res.ok) throw new Error('GitHub GET ' + path + ' failed (' + res.status + ')');
    const j = await res.json();
    if (j.content) return { exists: true, sha: j.sha, content: j.content };
    if (j.sha) {
      const blobRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/blobs/${j.sha}`, { headers: ghHeaders() });
      if (blobRes.ok) {
        const blobJson = await blobRes.json();
        return { exists: true, sha: j.sha, content: (blobJson.content || '').replace(/\n/g, '') };
      }
    }
    return { exists: true, sha: j.sha, content: '' };
  }
  async function ghPutContent(path, contentBase64, message, sha) {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`, {
      method: 'PUT', headers: ghHeaders(),
      body: JSON.stringify({ message, content: contentBase64, branch, ...(sha ? { sha } : {}) })
    });
    if (!res.ok) throw new Error('GitHub PUT failed (' + res.status + '): ' + (await res.text()));
    return res.json();
  }
  async function ghListDir(path) {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, { headers: ghHeaders() });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error('GitHub list ' + path + ' failed (' + res.status + ')');
    const j = await res.json();
    return Array.isArray(j) ? j : [];
  }

  const KEYS_PATH = 'reports/team-keys.json';
  async function resolveSubmitter(suppliedKey) {
    if (!suppliedKey) return { ok: false, reason: 'No key supplied.' };
    try {
      const r = await ghGetRaw(KEYS_PATH);
      if (r.exists) {
        const parsed = JSON.parse(Buffer.from(r.content, 'base64').toString('utf-8'));
        const match = (parsed.keys || []).find(k => k.key === suppliedKey);
        if (!match) return { ok: false, reason: 'Key not recognised.' };
        if (match.active === false) return { ok: false, reason: 'This key has been deactivated.' };
        return { ok: true, name: match.name };
      }
      const legacy = process.env.SUBMIT_SECRET;
      if (legacy && suppliedKey === legacy) return { ok: true, name: 'Unassigned (shared key)' };
      return { ok: false, reason: 'Key not recognised.' };
    } catch (err) {
      return { ok: false, reason: String(err && err.message ? err.message : err) };
    }
  }

  const reviewKey = event.headers['x-review-key'] || event.headers['X-Review-Key'];
  const submitKey = event.headers['x-submit-key'] || event.headers['X-Submit-Key'];
  const REVIEW_SECRET = process.env.REVIEW_SECRET;
  const isManager = reviewKey && (!REVIEW_SECRET || reviewKey === REVIEW_SECRET);

  if (!isManager) {
    const auth = await resolveSubmitter(submitKey);
    if (!auth.ok) {
      return { statusCode: 401, body: JSON.stringify({ error: auth.reason || 'Invalid or missing key.' }) };
    }
  }

  async function listVisits() {
    const folders = await ghListDir('site-visits');
    const visits = [];
    for (const folder of folders) {
      if (folder.type !== 'dir') continue;
      const r = await ghGetRaw(`site-visits/${folder.name}/visit.json`);
      if (!r.exists) continue;
      try {
        const v = JSON.parse(Buffer.from(r.content, 'base64').toString('utf-8'));
        visits.push({ id: folder.name, sha: r.sha, ...v });
      } catch (e) { /* skip anything unreadable */ }
    }
    visits.sort((a, b) => new Date(b.loggedAt || b.date) - new Date(a.loggedAt || a.date));
    return visits;
  }

  // ---- POST: approve a site visit (manager only) ----
  if (event.httpMethod === 'POST') {
    if (!isManager) return { statusCode: 401, body: JSON.stringify({ error: 'Manager review key required to approve.' }) };
    let payload;
    try { payload = JSON.parse(event.body); } catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
    const { id, action } = payload;
    if (!id || action !== 'approve') return { statusCode: 400, body: JSON.stringify({ error: 'Missing id, or unsupported action.' }) };
    const safeId = String(id).replace(/[^a-zA-Z0-9_\-]/g, '-');
    try {
      const path = `site-visits/${safeId}/visit.json`;
      const existing = await ghGetRaw(path);
      if (!existing.exists) return { statusCode: 404, body: JSON.stringify({ error: 'Site visit not found.' }) };
      const v = JSON.parse(Buffer.from(existing.content, 'base64').toString('utf-8'));
      v.status = 'approved';
      v.reviewedAt = new Date().toISOString();
      await ghPutContent(path, Buffer.from(JSON.stringify(v, null, 2), 'utf-8').toString('base64'), `Site visit approved: ${safeId}`, existing.sha);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message ? err.message : err) }) };
    }
  }

  // ---- GET: list visits ----
  try {
    const visits = await listVisits();
    return { statusCode: 200, body: JSON.stringify({ ok: true, visits }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message ? err.message : err) }) };
  }
};

