// Radius Defect Checklist — "my submissions" lookup
//
// Lets a team member (using their own personal key, the same one used for
// "Send to central record") see the status of reports THEY submitted, and
// download the approved PDF once it's been signed off — so nothing except
// an approved report ever leaves the building, but the inspector doesn't
// have to ask anyone or hunt through GitHub to get it.
//
// Uses the same reports/team-keys.json and reports/registry.json as the
// other two functions. No new environment variables needed beyond what
// submit-inspection.js and review.js already use.

const GITHUB_API = 'https://api.github.com';

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

  // GitHub only inlines a file's content for files under ~1MB — beyond that
  // this comes back empty even though the file exists. Fall back to the Git
  // blob API, which reliably returns full base64 content up to 100MB.
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

  async function ghDeleteFile(path, sha, message) {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`, {
      method: 'DELETE',
      headers: ghHeaders(),
      body: JSON.stringify({ message, sha, branch })
    });
    if (!res.ok && res.status !== 404) throw new Error('GitHub DELETE ' + path + ' failed (' + res.status + ')');
  }

  async function ghPutContent(path, contentBase64, message, sha) {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`, {
      method: 'PUT', headers: ghHeaders(),
      body: JSON.stringify({ message, content: contentBase64, branch, ...(sha ? { sha } : {}) })
    });
    if (!res.ok) throw new Error('GitHub PUT ' + path + ' failed (' + res.status + ')');
  }

  const KEYS_PATH = 'reports/team-keys.json';
  const REG_PATH = 'reports/registry.json';
  const DOWNLOAD_CHUNK_SIZE = 900000;

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

  // ---- GET: download the approved PDF for one of MY OWN reports, one chunk at a time ----
  if (event.httpMethod === 'GET' && event.queryStringParameters && event.queryStringParameters.pdf) {
    const slug = String(event.queryStringParameters.pdf).replace(/[^a-zA-Z0-9_\-]/g, '-');
    const chunkIndex = parseInt((event.queryStringParameters.chunk || '0'), 10);
    try {
      const regR = await ghGetRaw(REG_PATH);
      if (!regR.exists) return { statusCode: 404, body: JSON.stringify({ error: 'No records found yet.' }) };
      const list = JSON.parse(Buffer.from(regR.content, 'base64').toString('utf-8'));
      const entry = list.find(r => r.slug === slug);
      if (!entry) return { statusCode: 404, body: JSON.stringify({ error: 'Report not found.' }) };
      if (entry.submittedBy !== auth.name) return { statusCode: 403, body: JSON.stringify({ error: 'That report was not submitted with your key.' }) };
      if (entry.status !== 'approved') return { statusCode: 403, body: JSON.stringify({ error: 'This report hasn\u2019t been approved yet \u2014 check back after it\u2019s been reviewed.' }) };

      const path = `reports/${slug}/defect-report.pdf`;
      const fileR = await ghGetRaw(path);
      if (!fileR.exists) return { statusCode: 404, body: JSON.stringify({ error: 'PDF not found for that report.' }) };
      const fullBase64 = fileR.content;
      const totalChunks = Math.max(Math.ceil(fullBase64.length / DOWNLOAD_CHUNK_SIZE), 1);
      const chunkData = fullBase64.slice(chunkIndex * DOWNLOAD_CHUNK_SIZE, (chunkIndex + 1) * DOWNLOAD_CHUNK_SIZE);
      return { statusCode: 200, body: JSON.stringify({ ok: true, chunkData, chunkIndex, totalChunks }) };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message ? err.message : err) }) };
    }
  }

  // ---- POST: delete one of MY OWN submissions (any status) ----
  if (event.httpMethod === 'POST') {
    let payload;
    try { payload = JSON.parse(event.body); } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }
    const { slug, action } = payload;
    if (!slug || action !== 'delete') return { statusCode: 400, body: JSON.stringify({ error: 'Missing slug, or unsupported action.' }) };
    const safeSlug = String(slug).replace(/[^a-zA-Z0-9_\-]/g, '-');
    try {
      const regR = await ghGetRaw(REG_PATH);
      if (!regR.exists) return { statusCode: 404, body: JSON.stringify({ error: 'No records found yet.' }) };
      const list = JSON.parse(Buffer.from(regR.content, 'base64').toString('utf-8'));
      const idx = list.findIndex(r => r.slug === safeSlug);
      if (idx === -1) return { statusCode: 404, body: JSON.stringify({ error: 'Report not found.' }) };
      if (list[idx].submittedBy !== auth.name) {
        return { statusCode: 403, body: JSON.stringify({ error: 'That report was not submitted with your key \u2014 you can only delete your own.' }) };
      }

      const pdfPath = `reports/${safeSlug}/defect-report.pdf`;
      const pdfR = await ghGetRaw(pdfPath);
      if (pdfR.exists) {
        await ghDeleteFile(pdfPath, pdfR.sha, `Delete report file: ${safeSlug}`);
      }

      list.splice(idx, 1);
      await ghPutContent(REG_PATH, Buffer.from(JSON.stringify(list, null, 2), 'utf-8').toString('base64'), `Delete report from registry: ${safeSlug}`, regR.sha);

      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message ? err.message : err) }) };
    }
  }

  // ---- GET: list only MY OWN submissions ----
  try {
    const regR = await ghGetRaw(REG_PATH);
    if (!regR.exists) return { statusCode: 200, body: JSON.stringify({ ok: true, list: [] }) };
    const list = JSON.parse(Buffer.from(regR.content, 'base64').toString('utf-8'));
    const mine = list.filter(r => r.submittedBy === auth.name);
    return { statusCode: 200, body: JSON.stringify({ ok: true, list: mine }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message ? err.message : err) }) };
  }
};
