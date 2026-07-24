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

  const KEYS_PATH = 'reports/team-keys.json';
  const REG_PATH = 'reports/registry.json';

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

  // ---- GET: download the approved PDF for one of MY OWN reports ----
  if (event.httpMethod === 'GET' && event.queryStringParameters && event.queryStringParameters.pdf) {
    const slug = String(event.queryStringParameters.pdf).replace(/[^a-zA-Z0-9_\-]/g, '-');
    try {
      const regRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${REG_PATH}?ref=${branch}`, { headers: ghHeaders() });
      if (!regRes.ok) return { statusCode: 404, body: JSON.stringify({ error: 'No records found yet.' }) };
      const regJson = await regRes.json();
      const list = JSON.parse(Buffer.from(regJson.content, 'base64').toString('utf-8'));
      const entry = list.find(r => r.slug === slug);
      if (!entry) return { statusCode: 404, body: JSON.stringify({ error: 'Report not found.' }) };
      if (entry.submittedBy !== auth.name) return { statusCode: 403, body: JSON.stringify({ error: 'That report was not submitted with your key.' }) };
      if (entry.status !== 'approved') return { statusCode: 403, body: JSON.stringify({ error: 'This report hasn\u2019t been approved yet \u2014 check back after it\u2019s been reviewed.' }) };

      const path = `reports/${slug}/defect-report.pdf`;
      const fileRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, { headers: ghHeaders() });
      if (!fileRes.ok) return { statusCode: fileRes.status, body: JSON.stringify({ error: 'PDF not found for that report.' }) };
      const fileJson = await fileRes.json();
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${slug}-defect-report.pdf"` },
        body: (fileJson.content || '').replace(/\n/g, ''),
        isBase64Encoded: true
      };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message ? err.message : err) }) };
    }
  }

  // ---- GET: list only MY OWN submissions ----
  try {
    const regRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${REG_PATH}?ref=${branch}`, { headers: ghHeaders() });
    if (regRes.status === 404) return { statusCode: 200, body: JSON.stringify({ ok: true, list: [] }) };
    if (!regRes.ok) return { statusCode: regRes.status, body: JSON.stringify({ error: 'Failed to read records.' }) };
    const regJson = await regRes.json();
    const list = JSON.parse(Buffer.from(regJson.content, 'base64').toString('utf-8'));
    const mine = list.filter(r => r.submittedBy === auth.name);
    return { statusCode: 200, body: JSON.stringify({ ok: true, list: mine }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message ? err.message : err) }) };
  }
};
