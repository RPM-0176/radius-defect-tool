// Radius Defect Checklist — list logged site visits
//
// "Log site visit" saves data reliably but had nowhere to actually view it
// afterward — this fills that gap. Lists everything under site-visits/,
// newest first, gated by the same personal key as everything else (not
// scoped to "your own" specifically, since there's no strong reason to hide
// one teammate's site visits from another — unlike inspection reports,
// these never go to a client and don't need an approval gate).
//
// Required Netlify environment variables (same as the rest of the tool):
//   GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH (optional)

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
    if (j.content) return { exists: true, content: j.content };
    if (j.sha) {
      const blobRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/git/blobs/${j.sha}`, { headers: ghHeaders() });
      if (blobRes.ok) {
        const blobJson = await blobRes.json();
        return { exists: true, content: (blobJson.content || '').replace(/\n/g, '') };
      }
    }
    return { exists: true, content: '' };
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

  const suppliedKey = event.headers['x-submit-key'] || event.headers['X-Submit-Key'];
  const auth = await resolveSubmitter(suppliedKey);
  if (!auth.ok) {
    return { statusCode: 401, body: JSON.stringify({ error: auth.reason || 'Invalid or missing key.' }) };
  }

  try {
    const folders = await ghListDir('site-visits');
    const visits = [];
    for (const folder of folders) {
      if (folder.type !== 'dir') continue;
      const r = await ghGetRaw(`site-visits/${folder.name}/visit.json`);
      if (!r.exists) continue;
      try {
        const v = JSON.parse(Buffer.from(r.content, 'base64').toString('utf-8'));
        visits.push({ id: folder.name, ...v });
      } catch (e) { /* skip anything unreadable */ }
    }
    visits.sort((a, b) => new Date(b.loggedAt || b.date) - new Date(a.loggedAt || a.date));
    return { statusCode: 200, body: JSON.stringify({ ok: true, visits }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message ? err.message : err) }) };
  }
};
