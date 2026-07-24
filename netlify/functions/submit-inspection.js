// Radius Defect Checklist — central record submitter
//
// Receives a report file (PDF or summary JSON) from the checklist tool and
// commits it into a GitHub repo, which acts as the permanent, central,
// browsable record of every inspection your team completes.
//
// Required Netlify environment variables (set in Site settings > Environment variables):
//   GITHUB_TOKEN    - a fine-grained GitHub Personal Access Token, scoped to the
//                      records repo only, with "Contents: Read and write" permission.
//   GITHUB_OWNER    - your GitHub username or organisation name.
//   GITHUB_REPO     - the name of the records repo (e.g. radius-defect-records).
//   GITHUB_BRANCH   - optional, defaults to "main".
//   SUBMIT_SECRET   - a shared passphrase. The tool must send this in the
//                      X-Submit-Key header or the request is rejected. This is
//                      what you give your team once, per device.

const GITHUB_API = 'https://api.github.com';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const SUBMIT_SECRET = process.env.SUBMIT_SECRET;
  const suppliedKey = event.headers['x-submit-key'] || event.headers['X-Submit-Key'];
  if (SUBMIT_SECRET && suppliedKey !== SUBMIT_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or missing central record key.' }) };
  }

  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';

  if (!token || !owner || !repo) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server is not configured yet. Missing GITHUB_TOKEN, GITHUB_OWNER or GITHUB_REPO environment variable in Netlify.' })
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { slug, filename, contentBase64, meta, kind } = payload;
  if (!slug || !filename || !contentBase64) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing slug, filename or contentBase64' }) };
  }
  // keep the path safe — slug is already sanitised client-side, but double check here
  const safeSlug = String(slug).replace(/[^a-zA-Z0-9_\-]/g, '-');
  const safeFilename = String(filename).replace(/[^a-zA-Z0-9_.\-]/g, '-');
  const path = `reports/${safeSlug}/${safeFilename}`;

  function ghHeaders() {
    return {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'radius-defect-checklist-tool'
    };
  }

  try {
    // Look up existing file sha (needed to update rather than create)
    let sha;
    const getRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, {
      headers: ghHeaders()
    });
    if (getRes.status === 200) {
      const j = await getRes.json();
      sha = j.sha;
    } else if (getRes.status !== 404) {
      const t = await getRes.text();
      return { statusCode: getRes.status, body: JSON.stringify({ error: 'GitHub lookup failed', detail: t }) };
    }

    const putRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: ghHeaders(),
      body: JSON.stringify({
        message: `Inspection record: ${safeSlug}/${safeFilename}`,
        content: contentBase64,
        branch,
        ...(sha ? { sha } : {})
      })
    });

    if (!putRes.ok) {
      const t = await putRes.text();
      return { statusCode: putRes.status, body: JSON.stringify({ error: 'GitHub write failed', detail: t }) };
    }
    const putJson = await putRes.json();

    // Maintain reports/registry.json — the structured list the review queue
    // reads from. Every fresh PDF submission goes back to "pending" so a
    // resubmitted/updated report gets looked at again.
    if (kind === 'pdf') {
      try {
        const regPath = 'reports/registry.json';
        const getReg = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${regPath}?ref=${branch}`, {
          headers: ghHeaders()
        });
        let list = [];
        let regSha;
        if (getReg.status === 200) {
          const j = await getReg.json();
          regSha = j.sha;
          list = JSON.parse(Buffer.from(j.content, 'base64').toString('utf-8'));
        } else if (getReg.status !== 404) {
          throw new Error('registry read failed: ' + getReg.status);
        }
        const now = new Date().toISOString();
        const idx = list.findIndex(r => r.slug === safeSlug);
        const entry = {
          slug: safeSlug,
          meta: meta || {},
          summary: payload.summary || {},
          pdfPath: path,
          submittedAt: now,
          status: 'pending',
          reviewedAt: null,
          reviewNote: ''
        };
        if (idx === -1) list.push(entry); else list[idx] = entry;
        await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${regPath}`, {
          method: 'PUT',
          headers: ghHeaders(),
          body: JSON.stringify({
            message: `Registry: ${safeSlug} pending review`,
            content: Buffer.from(JSON.stringify(list, null, 2), 'utf-8').toString('base64'),
            branch,
            ...(regSha ? { sha: regSha } : {})
          })
        });
      } catch (regErr) {
        // Non-fatal — the PDF itself already saved successfully; the
        // review queue just won't show this one until the next attempt.
      }
    }

    // Best-effort: append a row to a running ledger so the whole team's
    // submissions are visible at a glance in one file (reports/index.csv).
    if (kind === 'pdf' && meta) {
      try {
        const indexPath = 'reports/index.csv';
        const getIdx = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${indexPath}?ref=${branch}`, {
          headers: ghHeaders()
        });
        let existing = '';
        let idxSha;
        if (getIdx.status === 200) {
          const j = await getIdx.json();
          idxSha = j.sha;
          existing = Buffer.from(j.content, 'base64').toString('utf-8');
        } else {
          existing = 'submitted_at,project,client,builder,inspector,date,slug,pdf_path\n';
        }
        const esc = (s) => `"${String(s || '').replace(/"/g, '""')}"`;
        const row = [
          new Date().toISOString(),
          esc(meta.project), esc(meta.client), esc(meta.builder),
          esc(meta.inspector), esc(meta.date), esc(safeSlug), esc(path)
        ].join(',') + '\n';
        const updated = existing + row;
        await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${indexPath}`, {
          method: 'PUT',
          headers: ghHeaders(),
          body: JSON.stringify({
            message: `Log: ${safeSlug}`,
            content: Buffer.from(updated, 'utf-8').toString('base64'),
            branch,
            ...(idxSha ? { sha: idxSha } : {})
          })
        });
      } catch (ledgerErr) {
        // Non-fatal — the actual report file already saved successfully.
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, path, url: putJson.content && putJson.content.html_url })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message ? err.message : err) }) };
  }
};

