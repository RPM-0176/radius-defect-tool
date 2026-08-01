// Radius Defect Checklist — daily digest
//
// Runs automatically each morning (see the schedule in netlify.toml) and
// emails a summary of what needs attention, pulled from two places:
//   1. This checklist tool's own records (reports/registry.json) — anything
//      still Pending review, or sent back as Changes requested and not yet
//      resubmitted.
//   2. Your Monday.com "SDA Project Pipeline" board — current stage and the
//      latest notes for every property, grouped by whoever's assigned to it.
//
// This does NOT touch anyone's email inbox — that's a separate, deliberately
// unbuilt piece pending a conversation with Martin and Seb first.
//
// Required Netlify environment variables:
//   GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH (optional)
//     — same ones the rest of the tool already uses.
//   MONDAY_API_TOKEN       — a personal API token from Monday.com (Avatar → Admin → API)
//   MONDAY_BOARD_ID        — defaults to 5025662448 (the SDA Project Pipeline board) if not set
//   RESEND_API_KEY         — from resend.com, used to actually send the email
//   DIGEST_FROM_EMAIL      — the "from" address (must be a verified sender/domain in Resend)
//   DIGEST_TO_EMAIL        — who receives the digest (can be a comma-separated list)

const GITHUB_API = 'https://api.github.com';
const MONDAY_API = 'https://api.monday.com/v2';
const RESEND_API = 'https://api.resend.com/emails';

exports.handler = async () => {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  const mondayToken = process.env.MONDAY_API_TOKEN;
  const mondayBoardId = process.env.MONDAY_BOARD_ID || '5025662448';
  const resendKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.DIGEST_FROM_EMAIL;
  const toEmail = process.env.DIGEST_TO_EMAIL;

  const missing = [];
  if (!token || !owner || !repo) missing.push('GITHUB_TOKEN/GITHUB_OWNER/GITHUB_REPO');
  if (!resendKey) missing.push('RESEND_API_KEY');
  if (!fromEmail) missing.push('DIGEST_FROM_EMAIL');
  if (!toEmail) missing.push('DIGEST_TO_EMAIL');
  if (missing.length) {
    console.error('[daily-digest] Missing required env vars:', missing.join(', '));
    return { statusCode: 500, body: 'Missing env vars: ' + missing.join(', ') };
  }

  function ghHeaders() {
    return {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'radius-defect-checklist-tool'
    };
  }

  // Same large-file-safe fetch used throughout the rest of the tool.
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

  function daysAgo(isoString) {
    if (!isoString) return null;
    const diffMs = Date.now() - new Date(isoString).getTime();
    return Math.max(Math.floor(diffMs / (1000 * 60 * 60 * 24)), 0);
  }

  // ---- 1. Checklist tool: pending review + changes requested ----
  let pending = [];
  let changesRequested = [];
  try {
    const reg = await ghGetRaw('reports/registry.json');
    const list = reg.exists ? JSON.parse(Buffer.from(reg.content, 'base64').toString('utf-8')) : [];
    pending = list.filter(r => r.status === 'pending')
      .sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt));
    changesRequested = list.filter(r => r.status === 'changes_requested')
      .sort((a, b) => new Date(a.reviewedAt || a.submittedAt) - new Date(b.reviewedAt || b.submittedAt));
  } catch (err) {
    console.error('[daily-digest] Failed to read checklist registry (non-fatal):', err.message);
  }

  // ---- 2. Monday.com: current stage + notes per property, grouped by person ----
  let mondayByPerson = {};
  let mondayError = null;
  if (mondayToken) {
    try {
      const query = `query {
        boards(ids: ${mondayBoardId}) {
          items_page(limit: 100) {
            items {
              id
              name
              column_values(ids: ["multiple_person_mm5tfgfv", "color_mksch3zh", "long_text_mky5c0rm"]) {
                id
                text
              }
            }
          }
        }
      }`;
      const res = await fetch(MONDAY_API, {
        method: 'POST',
        headers: { 'Authorization': mondayToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });
      const json = await res.json();
      if (json.errors) throw new Error(JSON.stringify(json.errors));
      const items = json.data.boards[0].items_page.items;
      for (const item of items) {
        const cols = Object.fromEntries(item.column_values.map(c => [c.id, c.text]));
        const person = cols['multiple_person_mm5tfgfv'] || 'Unassigned';
        const stage = cols['color_mksch3zh'] || '\u2014';
        const notes = cols['long_text_mky5c0rm'] || '';
        if (!item.name || item.name === 'New Item') continue; // skip template/placeholder rows
        if (!mondayByPerson[person]) mondayByPerson[person] = [];
        mondayByPerson[person].push({ name: item.name, stage, notes });
      }
    } catch (err) {
      mondayError = err.message;
      console.error('[daily-digest] Monday.com fetch failed (non-fatal):', err.message);
    }
  }

  // ---- 3. Compose the email ----
  const today = new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  let html = `<div style="font-family:sans-serif;color:#222;max-width:640px;">`;
  html += `<h2 style="color:#1B2430;border-bottom:2px solid #1B2430;padding-bottom:8px;">Radius Daily Digest \u2014 ${today}</h2>`;

  html += `<h3 style="color:#1B2430;">Checklist tool</h3>`;
  if (pending.length === 0 && changesRequested.length === 0) {
    html += `<p style="color:#3C7A5C;">Review queue is clear \u2014 nothing pending, nothing sent back.</p>`;
  } else {
    if (pending.length) {
      html += `<p><b>Pending review (${pending.length}):</b></p><ul>`;
      for (const r of pending) {
        const d = daysAgo(r.submittedAt);
        html += `<li>${r.meta && r.meta.project || r.slug} \u2014 submitted by ${r.submittedBy}, ${d} day${d === 1 ? '' : 's'} ago</li>`;
      }
      html += `</ul>`;
    }
    if (changesRequested.length) {
      html += `<p><b>Changes requested, not yet resubmitted (${changesRequested.length}):</b></p><ul>`;
      for (const r of changesRequested) {
        const d = daysAgo(r.reviewedAt);
        html += `<li>${r.meta && r.meta.project || r.slug} \u2014 ${r.submittedBy}, ${d} day${d === 1 ? '' : 's'} since feedback${r.reviewNote ? ' \u2014 "' + r.reviewNote + '"' : ''}</li>`;
      }
      html += `</ul>`;
    }
  }

  html += `<h3 style="color:#1B2430;">Project pipeline (Monday.com)</h3>`;
  if (mondayError) {
    html += `<p style="color:#A8461F;">Couldn't load the Monday.com board today: ${mondayError}</p>`;
  } else if (Object.keys(mondayByPerson).length === 0) {
    html += `<p>No Monday.com token configured, or no items found.</p>`;
  } else {
    for (const person of Object.keys(mondayByPerson).sort()) {
      html += `<p><b>${person}</b></p><ul>`;
      for (const p of mondayByPerson[person]) {
        html += `<li>${p.name} \u2014 <i>${p.stage}</i>${p.notes ? '<br><span style="color:#666;font-size:0.9em;">' + p.notes.replace(/\n/g, '<br>') + '</span>' : ''}</li>`;
      }
      html += `</ul>`;
    }
  }

  html += `<p style="color:#999;font-size:0.85em;margin-top:24px;">Automated daily digest from the Radius defect checklist tool.</p>`;
  html += `</div>`;

  // ---- 4. Send it ----
  try {
    const sendRes = await fetch(RESEND_API, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromEmail,
        to: toEmail.split(',').map(s => s.trim()),
        subject: `Radius Daily Digest \u2014 ${today}`,
        html
      })
    });
    if (!sendRes.ok) {
      const errText = await sendRes.text();
      console.error('[daily-digest] Resend send failed:', sendRes.status, errText);
      return { statusCode: 500, body: 'Email send failed: ' + errText };
    }
  } catch (err) {
    console.error('[daily-digest] Failed to send email:', err.message);
    return { statusCode: 500, body: 'Failed to send: ' + err.message };
  }

  console.log('[daily-digest] Sent successfully to', toEmail);
  return { statusCode: 200, body: 'Digest sent' };
};
