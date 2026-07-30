// Radius Defect Checklist — review queue
//
// Lets a manager (someone holding REVIEW_SECRET) see every report the team
// has submitted, open the PDF, and mark it Approved or Changes requested.
// This never emails the client itself — it just gates what's been looked at.
//
// Required Netlify environment variables (same repo/token as submit-inspection.js):
//   GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH (optional)
//   REVIEW_SECRET   - a passphrase separate from SUBMIT_SECRET, so only the
//                      manager(s) who should approve reports can see and act
//                      on the queue. Give this to reviewers only.

const GITHUB_API = 'https://api.github.com';

exports.handler = async (event) => {
  const REVIEW_SECRET = process.env.REVIEW_SECRET;
  const suppliedKey = event.headers['x-review-key'] || event.headers['X-Review-Key'];
  if (REVIEW_SECRET && suppliedKey !== REVIEW_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or missing manager review key.' }) };
  }

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

  const regPath = 'reports/registry.json';
  const DOWNLOAD_CHUNK_SIZE = 900000; // matches the upload chunk size used elsewhere

  async function getRegistry() {
    const r = await ghGetRaw(regPath);
    if (!r.exists) return { sha: null, list: [] };
    const list = JSON.parse(Buffer.from(r.content, 'base64').toString('utf-8'));
    return { sha: r.sha, list };
  }

  async function putRegistry(list, sha) {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${regPath}`, {
      method: 'PUT',
      headers: ghHeaders(),
      body: JSON.stringify({
        message: 'Update review registry',
        content: Buffer.from(JSON.stringify(list, null, 2), 'utf-8').toString('base64'),
        branch,
        ...(sha ? { sha } : {})
      })
    });
    if (!res.ok) throw new Error('Failed to write registry (' + res.status + ')');
  }

  // ---- GET: view a specific report's PDF, one chunk at a time (proxied through GitHub's API) ----
  if (event.httpMethod === 'GET' && event.queryStringParameters && event.queryStringParameters.pdf) {
    const slug = String(event.queryStringParameters.pdf).replace(/[^a-zA-Z0-9_\-]/g, '-');
    const chunkIndex = parseInt((event.queryStringParameters.chunk || '0'), 10);
    const path = `reports/${slug}/defect-report.pdf`;
    try {
      const r = await ghGetRaw(path);
      if (!r.exists) return { statusCode: 404, body: JSON.stringify({ error: 'PDF not found for that report.' }) };
      const fullBase64 = r.content;
      const totalChunks = Math.max(Math.ceil(fullBase64.length / DOWNLOAD_CHUNK_SIZE), 1);
      const chunkData = fullBase64.slice(chunkIndex * DOWNLOAD_CHUNK_SIZE, (chunkIndex + 1) * DOWNLOAD_CHUNK_SIZE);
      return { statusCode: 200, body: JSON.stringify({ ok: true, chunkData, chunkIndex, totalChunks }) };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message ? err.message : err) }) };
    }
  }

  // ---- GET: list the queue ----
  if (event.httpMethod === 'GET') {
    try {
      const { list } = await getRegistry();
      return { statusCode: 200, body: JSON.stringify({ ok: true, list }) };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message ? err.message : err) }) };
    }
  }

  // ---- POST: approve / request changes ----
  if (event.httpMethod === 'POST') {
    let payload;
    try { payload = JSON.parse(event.body); } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }
    const { slug, action, note } = payload;
    if (!slug || !action) return { statusCode: 400, body: JSON.stringify({ error: 'Missing slug or action' }) };
    if (action !== 'approve' && action !== 'request_changes') {
      return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };
    }
    try {
      const { list, sha } = await getRegistry();
      const idx = list.findIndex(r => r.slug === slug);
      if (idx === -1) return { statusCode: 404, body: JSON.stringify({ error: 'Report not found in registry' }) };
      list[idx].status = action === 'approve' ? 'approved' : 'changes_requested';
      list[idx].reviewedAt = new Date().toISOString();
      list[idx].reviewNote = note || '';
      await putRegistry(list, sha);
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message ? err.message : err) }) };
    }
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
