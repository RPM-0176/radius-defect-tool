// Radius Defect Checklist — central record submitter
//
// Receives a report file (PDF or summary JSON) from the checklist tool and
// commits it into a GitHub repo, which acts as the permanent, central,
// browsable record of every inspection your team completes.
//
// AUTHENTICATION — per-person keys, not one shared passphrase:
//   Each team member is issued their own individual key. Keys and the name
//   they belong to live in reports/team-keys.json inside the RECORDS repo
//   (GITHUB_REPO) — not in Netlify's environment variables — so you can add
//   or revoke someone's access just by editing that one file on GitHub,
//   with no redeploy needed. Format:
//
//   {
//     "keys": [
//       { "name": "MG",    "key": "radius-mg-7391",    "active": true },
//       { "name": "Seb",   "key": "radius-seb-4820",   "active": true },
//       { "name": "Julie", "key": "radius-julie-1156", "active": true }
//     ]
//   }
//
//   To revoke someone: set their "active" to false (or delete their entry).
//   Takes effect on their very next submission attempt.
//
//   Legacy fallback: if reports/team-keys.json doesn't exist yet and the
//   old SUBMIT_SECRET environment variable is still set, that shared key
//   still works (logged as submitter "Unassigned (shared key)") so nothing
//   breaks mid-transition while you're issuing individual keys.
//
// Required Netlify environment variables:
//   GITHUB_TOKEN    - a fine-grained GitHub Personal Access Token, scoped to the
//                      records repo only, with "Contents: Read and write" permission.
//   GITHUB_OWNER    - your GitHub username or organisation name.
//   GITHUB_REPO     - the name of the records repo (e.g. radius-defect-records).
//   GITHUB_BRANCH   - optional, defaults to "main".
//   SUBMIT_SECRET   - optional legacy shared key, see above.

const GITHUB_API = 'https://api.github.com';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
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
      if (res.status !== 404) {
        return { ok: false, reason: 'Could not check team-keys.json (status ' + res.status + ').' };
      }
      // team-keys.json doesn't exist yet — fall back to legacy shared secret
      const legacy = process.env.SUBMIT_SECRET;
      if (legacy && suppliedKey === legacy) {
        return { ok: true, name: 'Unassigned (shared key)' };
      }
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
  const submittedBy = auth.name;

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
        message: `Inspection record: ${safeSlug}/${safeFilename} (submitted by ${submittedBy})`,
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
          submittedBy,
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
            message: `Registry: ${safeSlug} pending review (${submittedBy})`,
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
          existing = 'submitted_at,submitted_by,project,client,builder,inspector,date,slug,pdf_path\n';
        }
        const esc = (s) => `"${String(s || '').replace(/"/g, '""')}"`;
        const row = [
          new Date().toISOString(), esc(submittedBy),
          esc(meta.project), esc(meta.client), esc(meta.builder),
          esc(meta.inspector), esc(meta.date), esc(safeSlug), esc(path)
        ].join(',') + '\n';
        const updated = existing + row;
        await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${indexPath}`, {
          method: 'PUT',
          headers: ghHeaders(),
          body: JSON.stringify({
            message: `Log: ${safeSlug} (${submittedBy})`,
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
      body: JSON.stringify({ ok: true, path, submittedBy, url: putJson.content && putJson.content.html_url })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message ? err.message : err) }) };
  }
};
