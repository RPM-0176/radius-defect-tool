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
const MONDAY_API = 'https://api.monday.com/v2';
const MONDAY_FILE_API = 'https://api.monday.com/v2/file';
const RESEND_API = 'https://api.resend.com/emails';
const FILES_COLUMN = 'file_mkt6ghz7'; // existing "Files & Reports" column on the SDA Project Pipeline board

// Maps the short "name" values stored in reports/team-keys.json to each
// person's email, so an approved report can notify whoever submitted it.
// IMPORTANT: these keys must match the "name" field in team-keys.json
// exactly (case-insensitive) — check that repo file and adjust below if
// these don't line up (e.g. if Martin's entry is "Martin" rather than "MG").
const SUBMITTER_EMAILS = {
  'mg': 'martin@radiuspg.com.au',
  'martin': 'martin@radiuspg.com.au',
  'seb': 'projectsqld@radiuspg.com.au',
  'tanya': 'tanya@radiuspg.com.au',
  'jason': 'jason@radiuspg.com.au',
};

function resolveSubmitterEmail(submittedBy) {
  if (!submittedBy) return null;
  const key = String(submittedBy).trim().toLowerCase();
  if (SUBMITTER_EMAILS[key]) return SUBMITTER_EMAILS[key];
  // Fall back to a substring match in case submittedBy is a longer form
  // like "Martin Green" rather than the short key-file name.
  const match = Object.keys(SUBMITTER_EMAILS).find(k => key.includes(k));
  return match ? SUBMITTER_EMAILS[match] : null;
}

// Best-effort — an approval has already succeeded and saved by the time this
// runs, so a failure here is logged only, never surfaced as an approval error.
async function sendApprovalNotice(entry) {
  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.DIGEST_FROM_EMAIL;
  if (!resendKey || !fromEmail) {
    console.log('[review] Skipping approval notice — RESEND_API_KEY/DIGEST_FROM_EMAIL not configured.');
    return;
  }
  const toEmail = resolveSubmitterEmail(entry.submittedBy);
  if (!toEmail) {
    console.log(`[review] No email on file for submitter "${entry.submittedBy}" — skipping approval notice.`);
    return;
  }
  const project = (entry.meta && entry.meta.project) || entry.slug;
  const html = `<div style="font-family:sans-serif;color:#222;max-width:560px;">
    <h3 style="color:#3C7A5C;">Your report was approved</h3>
    <p><b>${project}</b></p>
    <p>Jason has reviewed and approved this report.${entry.reviewNote ? ' Note: "' + entry.reviewNote + '"' : ''}</p>
  </div>`;
  try {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromEmail,
        to: [toEmail],
        subject: `Approved — ${project}`,
        html
      })
    });
    if (!res.ok) {
      console.error('[review] Approval notice email failed:', res.status, await res.text());
    }
  } catch (err) {
    console.error('[review] Approval notice email error (non-fatal):', err && err.message ? err.message : err);
  }
}

// Stages where an approved report should also fill in the matching "Actual X
// Date" column on Monday — but ONLY if that column is currently empty, so an
// approval can never overwrite a date someone's entered manually. Landscaping
// has no Actual-date column on the board, so it's intentionally not listed.
const STAGE_ACTUAL_DATE_COLUMNS = {
  slab: 'date_mkxy5de6',
  frame: 'date_mkxywm1s',
  lockup: 'date_mkxyhkyb',
  rough_in: 'date_mm5vwt9s',
  plaster: 'date_mm5vjcmx',
  paint: 'date_mm5vxq6n',
  fixing: 'date_mm2g2zwr',
  paths_driveways: 'date_mm5vswb4',
  practical_completion: 'date_mm5v5k2w',
};

function normalizeAddress(str) {
  let s = (str || '').toLowerCase();
  s = s.replace(/\b(vic|nsw|qld|sa|wa|tas|nt|act)\b/g, '');
  s = s.replace(/\b\d{4}\b/g, '');
  s = s.replace(/[,.]/g, ' ');
  s = s.replace(/\bstreet\b/g, 'st').replace(/\bavenue\b/g, 'ave').replace(/\broad\b/g, 'rd')
    .replace(/\bcourt\b/g, 'ct').replace(/\bdrive\b/g, 'dr').replace(/\bgrove\b/g, 'gr')
    .replace(/\bplace\b/g, 'pl').replace(/\bcrescent\b/g, 'cres').replace(/\bterrace\b/g, 'tce');
  s = s.replace(/^(\d+)\s+([a-z])\b/, '$1$2');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// Standard edit-distance calculation, so a small typo doesn't break matching
// (e.g. "seperation" vs "separation" is a single substitution, distance 1).
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

// Allows a small typo per word — scaled to the word's length so short words
// (like "st" or "rd") still require an exact match, avoiding false positives.
function tokensMatch(a, b) {
  if (a === b) return true;
  const maxLen = Math.max(a.length, b.length);
  const tolerance = maxLen >= 8 ? 2 : maxLen >= 4 ? 1 : 0;
  return levenshtein(a, b) <= tolerance;
}
function addressesMatch(a, b) {
  const na = normalizeAddress(a), nb = normalizeAddress(b);
  if (!na || !nb) return false;
  const tokensA = na.split(' ').filter(Boolean);
  const tokensB = nb.split(' ').filter(Boolean);
  if (!tokensA.length || !tokensB.length) return false;
  const [shorter, longer] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  return shorter.every(t => longer.some(t2 => tokensMatch(t, t2)));
}

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

  async function ghDeleteFile(path, sha, message) {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`, {
      method: 'DELETE',
      headers: ghHeaders(),
      body: JSON.stringify({ message, sha, branch })
    });
    if (!res.ok && res.status !== 404) throw new Error('GitHub DELETE ' + path + ' failed (' + res.status + ')');
  }

  // Once a report is approved, find the matching property on Monday.com,
  // attach the actual PDF to the existing "Files & Reports" column, and — for
  // a recognised stage inspection — fill in the matching "Actual X Date"
  // column, but only if it's still empty. This is best-effort: if Monday is
  // unreachable, or nothing matches, the approval itself has already
  // succeeded regardless — this just enriches Monday, it never blocks or
  // reverses the approval.
  async function pushApprovedReportToMonday(entry) {
    const mondayToken = process.env.MONDAY_API_TOKEN;
    const mondayBoardId = process.env.MONDAY_BOARD_ID || '5025662448';
    if (!mondayToken) { const msg = 'MONDAY_API_TOKEN not set — skipping Monday sync'; console.log('[review] ' + msg); return { ok: false, reason: msg }; }
    if (!entry.meta || !entry.meta.project) { const msg = 'No project name on this report'; console.log('[review] ' + msg); return { ok: false, reason: msg }; }

    const itemQuery = `query { boards(ids: ${mondayBoardId}) { items_page(limit: 100) { items { id name } } } }`;
    const itemRes = await fetch(MONDAY_API, {
      method: 'POST', headers: { 'Authorization': mondayToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: itemQuery })
    });
    const itemJson = await itemRes.json();
    if (itemJson.errors) throw new Error('Monday item lookup failed: ' + JSON.stringify(itemJson.errors));
    const items = itemJson.data.boards[0].items_page.items;
    const match = items.find(it => addressesMatch(it.name, entry.meta.project));
    if (!match) {
      const msg = `No Monday.com property matched "${entry.meta.project}"`;
      console.log('[review] ' + msg + ' — skipping sync');
      return { ok: false, reason: msg };
    }

    // Fetch the actual approved PDF to attach
    const pdfR = await ghGetRaw(entry.pdfPath);
    if (!pdfR.exists) { const msg = 'Could not find the PDF file to attach'; console.log('[review] ' + msg); return { ok: false, reason: msg }; }
    const pdfBuffer = Buffer.from(pdfR.content, 'base64');

    // Upload it into the existing "Files & Reports" column
    const form = new FormData();
    const uploadQuery = `mutation ($file: File!) { add_file_to_column (file: $file, item_id: ${match.id}, column_id: "${FILES_COLUMN}") { id } }`;
    form.append('query', uploadQuery);
    form.append('variables[file]', new Blob([pdfBuffer], { type: 'application/pdf' }), `${entry.slug}.pdf`);
    const uploadRes = await fetch(MONDAY_FILE_API, { method: 'POST', headers: { 'Authorization': mondayToken }, body: form });
    const uploadJson = await uploadRes.json();
    if (uploadJson.errors) throw new Error('Monday file upload failed: ' + JSON.stringify(uploadJson.errors));
    console.log(`[review] Uploaded ${entry.slug}.pdf to Monday item "${match.name}"`);

    // For a recognised stage, fill in the Actual Date column — only if empty
    let dateUpdated = false, dateNote = null;
    const actualCol = entry.meta.stage && STAGE_ACTUAL_DATE_COLUMNS[entry.meta.stage];
    if (actualCol && entry.meta.date) {
      const checkQuery = `query { items(ids: ${match.id}) { column_values(ids: ["${actualCol}"]) { text } } }`;
      const checkRes = await fetch(MONDAY_API, {
        method: 'POST', headers: { 'Authorization': mondayToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: checkQuery })
      });
      const checkJson = await checkRes.json();
      const currentValue = checkJson.data && checkJson.data.items[0] && checkJson.data.items[0].column_values[0].text;
      if (!currentValue) {
        const valueJson = JSON.stringify(JSON.stringify({ date: entry.meta.date }));
        const setQuery = `mutation { change_column_value (board_id: ${mondayBoardId}, item_id: ${match.id}, column_id: "${actualCol}", value: ${valueJson}) { id } }`;
        const setRes = await fetch(MONDAY_API, {
          method: 'POST', headers: { 'Authorization': mondayToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: setQuery })
        });
        const setJson = await setRes.json();
        if (setJson.errors) throw new Error('Monday date update failed: ' + JSON.stringify(setJson.errors));
        console.log(`[review] Filled in ${actualCol} = ${entry.meta.date} on Monday item "${match.name}"`);
        dateUpdated = true;
      } else {
        console.log(`[review] ${actualCol} already has a value ("${currentValue}") — left untouched`);
        dateNote = `date already set to "${currentValue}", left untouched`;
      }
    }
    return { ok: true, propertyName: match.name, dateUpdated, dateNote };
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

  // ---- POST: approve / request changes / retry the Monday sync manually ----
  if (event.httpMethod === 'POST') {
    let payload;
    try { payload = JSON.parse(event.body); } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }
    const { slug, action, note } = payload;
    if (!slug || !action) return { statusCode: 400, body: JSON.stringify({ error: 'Missing slug or action' }) };
    if (action !== 'approve' && action !== 'request_changes' && action !== 'sync_monday' && action !== 'delete') {
      return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };
    }

    // Manually retry the Monday sync on an already-approved report — for
    // when the first attempt didn't match (e.g. a typo) and you've now fixed
    // it on one side or the other, without needing to re-approve.
    if (action === 'sync_monday') {
      try {
        const { list } = await getRegistry();
        const entry = list.find(r => r.slug === slug);
        if (!entry) return { statusCode: 404, body: JSON.stringify({ error: 'Report not found in registry' }) };
        if (entry.status !== 'approved') return { statusCode: 400, body: JSON.stringify({ error: 'Only approved reports can be synced to Monday.' }) };
        const syncResult = await pushApprovedReportToMonday(entry);
        return { statusCode: 200, body: JSON.stringify({ ok: true, sync: syncResult }) };
      } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message ? err.message : err) }) };
      }
    }

    // Delete a report entirely — from the registry and its stored PDF.
    // Managers can delete any report, any status, since this is a cleanup
    // action, not a review decision.
    if (action === 'delete') {
      try {
        const { list, sha } = await getRegistry();
        const idx = list.findIndex(r => r.slug === slug);
        if (idx === -1) return { statusCode: 404, body: JSON.stringify({ error: 'Report not found in registry' }) };
        const entry = list[idx];
        const pdfPath = entry.pdfPath || `reports/${slug}/defect-report.pdf`;
        const pdfR = await ghGetRaw(pdfPath);
        if (pdfR.exists) {
          await ghDeleteFile(pdfPath, pdfR.sha, `Delete report file: ${slug}`);
        }
        list.splice(idx, 1);
        await putRegistry(list, sha);
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message ? err.message : err) }) };
      }
    }

    try {
      const { list, sha } = await getRegistry();
      const idx = list.findIndex(r => r.slug === slug);
      if (idx === -1) return { statusCode: 404, body: JSON.stringify({ error: 'Report not found in registry' }) };
      list[idx].status = action === 'approve' ? 'approved' : 'changes_requested';
      list[idx].reviewedAt = new Date().toISOString();
      list[idx].reviewNote = note || '';
      await putRegistry(list, sha);

      let syncResult = null;
      if (action === 'approve') {
        try {
          syncResult = await pushApprovedReportToMonday(list[idx]);
        } catch (mondayErr) {
          // Best-effort — the approval itself has already succeeded and saved.
          console.error('[review] Monday.com sync failed (non-fatal, approval still succeeded):', mondayErr.message);
          syncResult = { ok: false, reason: mondayErr.message };
        }
        await sendApprovalNotice(list[idx]);
      }

      return { statusCode: 200, body: JSON.stringify({ ok: true, sync: syncResult }) };
    } catch (err) {
      return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message ? err.message : err) }) };
    }
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};

