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
//       { "name": "Seb",   "key": "radius-seb-4820",   "active": true }
//     ]
//   }
//
//   To revoke someone: set their "active" to false (or delete their entry).
//   Takes effect on their very next submission attempt.
//
//   Legacy fallback: if reports/team-keys.json doesn't exist yet and the
//   old SUBMIT_SECRET environment variable is still set, that shared key
//   still works (logged as submitter "Unassigned (shared key)").
//
// LARGE FILES — chunked upload:
//   Photo-heavy PDFs can be too big for a single request. The client splits
//   large files into pieces and sends them as a sequence of requests:
//     { action: 'chunk', slug, filename, chunkIndex, totalChunks, chunkData }
//   followed by:
//     { action: 'finalize', slug, filename, meta, kind, summary, totalChunks }
//   Chunks are stored temporarily under reports/<slug>/_tmp_<filename>/ and
//   reassembled into the real file on finalize, then the temp files are
//   cleaned up. Small files skip this entirely and just send one request
//   with contentBase64 directly, no action field needed.
//
// Required Netlify environment variables:
//   GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH (optional), SUBMIT_SECRET (optional legacy).

const GITHUB_API = 'https://api.github.com';

exports.handler = async (event) => {
  const startedAt = Date.now();
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';

  if (!token || !owner || !repo) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server is not configured yet. Missing GITHUB_TOKEN, GITHUB_OWNER or GITHUB_REPO environment variable in Netlify.' }) };
  }

  function ghHeaders() {
    return {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'radius-defect-checklist-tool'
    };
  }

  async function ghGetContent(path) {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, { headers: ghHeaders() });
    if (res.status === 200) {
      const j = await res.json();
      return { exists: true, sha: j.sha, content: j.content };
    }
    if (res.status === 404) return { exists: false };
    const t = await res.text();
    throw new Error(`GitHub GET ${path} failed (${res.status}): ${t}`);
  }

  async function ghPutContent(path, contentBase64, message, sha) {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: ghHeaders(),
      body: JSON.stringify({ message, content: contentBase64, branch, ...(sha ? { sha } : {}) })
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`GitHub PUT ${path} failed (${res.status}): ${t}`);
    }
    return res.json();
  }

  async function ghDeleteContent(path, sha, message) {
    try {
      await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`, {
        method: 'DELETE',
        headers: ghHeaders(),
        body: JSON.stringify({ message, sha, branch })
      });
    } catch (e) {
      // cleanup best-effort only
    }
  }

  const KEYS_PATH = 'reports/team-keys.json';

  async function resolveSubmitter(suppliedKey) {
    if (!suppliedKey) return { ok: false, reason: 'No key supplied.' };
    try {
      const existing = await ghGetContent(KEYS_PATH);
      if (existing.exists) {
        const parsed = JSON.parse(Buffer.from(existing.content, 'base64').toString('utf-8'));
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
  const submittedBy = auth.name;

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { slug, filename, action } = payload;
  if (!slug || !filename) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing slug or filename' }) };
  }
  const safeSlug = String(slug).replace(/[^a-zA-Z0-9_\-]/g, '-');
  const safeFilename = String(filename).replace(/[^a-zA-Z0-9_.\-]/g, '-');
  const finalPath = `reports/${safeSlug}/${safeFilename}`;

  // ---- Finish writing a fully-assembled file: PUT it, then update registry + ledger ----
  async function writeReport(contentBase64, meta, kind, summary) {
    const approxKB = Math.round((contentBase64.length * 0.75) / 1024);
    console.log(`[submit-inspection] writing ${safeFilename} for ${safeSlug} — approx ${approxKB}KB, kind=${kind}`);

    const existing = await ghGetContent(finalPath);
    const putJson = await ghPutContent(
      finalPath, contentBase64,
      `Inspection record: ${safeSlug}/${safeFilename} (submitted by ${submittedBy})`,
      existing.exists ? existing.sha : undefined
    );

    if (kind === 'wip') {
      try {
        const wipIndexPath = 'reports/wip-index.json';
        const wipExisting = await ghGetContent(wipIndexPath);
        let list = wipExisting.exists ? JSON.parse(Buffer.from(wipExisting.content, 'base64').toString('utf-8')) : [];
        const now = new Date().toISOString();
        const idx = list.findIndex(r => r.slug === safeSlug);
        const entry = { slug: safeSlug, meta: meta || {}, submittedBy, updatedAt: now, path: finalPath };
        if (idx === -1) list.push(entry); else list[idx] = entry;
        await ghPutContent(
          wipIndexPath,
          Buffer.from(JSON.stringify(list, null, 2), 'utf-8').toString('base64'),
          `WIP sync: ${safeSlug} (${submittedBy})`,
          wipExisting.exists ? wipExisting.sha : undefined
        );
      } catch (wipErr) {
        console.error('[submit-inspection] wip-index update failed (non-fatal):', wipErr && wipErr.message ? wipErr.message : wipErr);
      }
    }

    if (kind === 'pdf') {
      try {
        const regPath = 'reports/registry.json';
        const regExisting = await ghGetContent(regPath);
        let list = regExisting.exists ? JSON.parse(Buffer.from(regExisting.content, 'base64').toString('utf-8')) : [];
        const now = new Date().toISOString();
        const idx = list.findIndex(r => r.slug === safeSlug);
        const entry = {
          slug: safeSlug, meta: meta || {}, submittedBy, summary: summary || {},
          pdfPath: finalPath, submittedAt: now, status: 'pending', reviewedAt: null, reviewNote: ''
        };
        if (idx === -1) list.push(entry); else list[idx] = entry;
        await ghPutContent(
          regPath,
          Buffer.from(JSON.stringify(list, null, 2), 'utf-8').toString('base64'),
          `Registry: ${safeSlug} pending review (${submittedBy})`,
          regExisting.exists ? regExisting.sha : undefined
        );
      } catch (regErr) {
        console.error('[submit-inspection] registry update failed (non-fatal):', regErr && regErr.message ? regErr.message : regErr);
      }
    }

    if (kind === 'pdf' && meta) {
      try {
        const indexPath = 'reports/index.csv';
        const idxExisting = await ghGetContent(indexPath);
        const existingCsv = idxExisting.exists
          ? Buffer.from(idxExisting.content, 'base64').toString('utf-8')
          : 'submitted_at,submitted_by,project,client,builder,inspector,date,slug,pdf_path\n';
        const esc = (s) => `"${String(s || '').replace(/"/g, '""')}"`;
        const row = [
          new Date().toISOString(), esc(submittedBy),
          esc(meta.project), esc(meta.client), esc(meta.builder),
          esc(meta.inspector), esc(meta.date), esc(safeSlug), esc(finalPath)
        ].join(',') + '\n';
        await ghPutContent(
          indexPath, Buffer.from(existingCsv + row, 'utf-8').toString('base64'),
          `Log: ${safeSlug} (${submittedBy})`, idxExisting.exists ? idxExisting.sha : undefined
        );
      } catch (ledgerErr) {
        console.error('[submit-inspection] ledger update failed (non-fatal):', ledgerErr && ledgerErr.message ? ledgerErr.message : ledgerErr);
      }
    }

    return { ok: true, path: finalPath, submittedBy, url: putJson.content && putJson.content.html_url };
  }

  const tmpDir = `reports/${safeSlug}/_tmp_${safeFilename}`;

  try {
    // ---- Small file, single request (the common case) ----
    if (!action) {
      const { contentBase64, meta, kind } = payload;
      if (!contentBase64) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing contentBase64' }) };
      }
      const result = await writeReport(contentBase64, meta, kind, payload.summary);
      console.log(`[submit-inspection] success (direct) for ${safeSlug} in ${Date.now() - startedAt}ms`);
      return { statusCode: 200, body: JSON.stringify(result) };
    }

    // ---- Large file, part 1: store a chunk temporarily ----
    if (action === 'chunk') {
      const { chunkIndex, chunkData } = payload;
      if (chunkIndex === undefined || chunkData === undefined) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing chunkIndex or chunkData' }) };
      }
      const partPath = `${tmpDir}/part_${String(chunkIndex).padStart(5, '0')}.txt`;
      await ghPutContent(partPath, Buffer.from(chunkData, 'utf-8').toString('base64'), `Chunk ${chunkIndex} for ${safeSlug}/${safeFilename}`);
      console.log(`[submit-inspection] stored chunk ${chunkIndex} for ${safeSlug} in ${Date.now() - startedAt}ms`);
      return { statusCode: 200, body: JSON.stringify({ ok: true, chunkIndex }) };
    }

    // ---- Large file, part 2: reassemble all chunks and finish as normal ----
    if (action === 'finalize') {
      const { meta, kind, summary, totalChunks } = payload;
      if (!totalChunks) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing totalChunks' }) };
      }
      let assembled = '';
      const partShas = [];
      for (let i = 0; i < totalChunks; i++) {
        const partPath = `${tmpDir}/part_${String(i).padStart(5, '0')}.txt`;
        const part = await ghGetContent(partPath);
        if (!part.exists) {
          return { statusCode: 400, body: JSON.stringify({ error: `Missing chunk ${i} of ${totalChunks} — try sending the report again from the start.` }) };
        }
        assembled += Buffer.from(part.content, 'base64').toString('utf-8');
        partShas.push({ path: partPath, sha: part.sha });
      }
      console.log(`[submit-inspection] reassembled ${totalChunks} chunks for ${safeSlug} (${Math.round(assembled.length * 0.75 / 1024)}KB) in ${Date.now() - startedAt}ms`);
      const result = await writeReport(assembled, meta, kind, summary);
      // best-effort cleanup of temp chunk files — not critical if this fails
      for (const p of partShas) {
        await ghDeleteContent(p.path, p.sha, `Cleanup chunk for ${safeSlug}/${safeFilename}`);
      }
      console.log(`[submit-inspection] success (chunked) for ${safeSlug} in ${Date.now() - startedAt}ms`);
      return { statusCode: 200, body: JSON.stringify(result) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (err) {
    console.error(`[submit-inspection] UNHANDLED ERROR after ${Date.now() - startedAt}ms for ${safeSlug}:`, err && err.stack ? err.stack : err);
    return { statusCode: 500, body: JSON.stringify({ error: (err && err.message) ? err.message : String(err), where: 'unhandled' }) };
  }
};
