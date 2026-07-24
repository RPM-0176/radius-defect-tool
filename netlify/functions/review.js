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

  const regPath = 'reports/registry.json';

  async function getRegistry() {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${regPath}?ref=${branch}`, { headers: ghHeaders() });
    if (res.status === 404) return { sha: null, list: [] };
    if (!res.ok) throw new Error('Failed to read registry (' + res.status + ')');
    const j = await res.json();
    const list = JSON.parse(Buffer.from(j.content, 'base64').toString('utf-8'));
    return { sha: j.sha, list };
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

  // ---- GET: view a specific report's PDF (proxied through GitHub's API) ----
  if (event.httpMethod === 'GET' && event.queryStringParameters && event.queryStringParameters.pdf) {
    const slug = String(event.queryStringParameters.pdf).replace(/[^a-zA-Z0-9_\-]/g, '-');
    const path = `reports/${slug}/defect-report.pdf`;
    try {
      const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, { headers: ghHeaders() });
      if (!res.ok) return { statusCode: res.status, body: JSON.stringify({ error: 'PDF not found for that report.' }) };
      const j = await res.json();
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${slug}-defect-report.pdf"` },
        body: (j.content || '').replace(/\n/g, ''),
        isBase64Encoded: true
      };
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

