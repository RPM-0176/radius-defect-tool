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

// Every stage that has a "when this is planned/expected" date column on the
// board, and — where the board tracks it — the matching "Actual X Date"
// column. If the actual date is already filled in, that stage is genuinely
// done, so a passed target date isn't worth flagging.
const STAGE_DATE_COLUMNS = [
  { label: 'Slab', dateCol: 'date_mkwp7vch', actualCol: 'date_mkxy5de6' },
  { label: 'Frame', dateCol: 'date_mkwpbnzw', actualCol: 'date_mkxywm1s' },
  { label: 'Lock Up', dateCol: 'date_mkwp73xe', actualCol: 'date_mkxyhkyb' },
  { label: 'Plaster', dateCol: 'date_mm3yczn3', actualCol: null },
  { label: 'Painting', dateCol: 'date_mm3ybzvv', actualCol: null },
  { label: 'Fixing', dateCol: 'date_mkwvtd9f', actualCol: 'date_mm2g2zwr' },
  { label: 'Kitchen', dateCol: 'date_mm3yb0p7', actualCol: null },
  { label: 'Kitchen Benchtops', dateCol: 'date_mm3yzb14', actualCol: null },
  { label: 'Tiling', dateCol: 'date_mm3yvsqd', actualCol: null },
  { label: 'Flooring', dateCol: 'date_mm3y5cbz', actualCol: null },
  { label: 'Landscaping', dateCol: 'date_mm3yy9sy', actualCol: null },
  { label: 'Practical Completion', dateCol: 'date_mm4eq9e9', actualCol: null },
];
const STAGE_DATE_WINDOW_DAYS = 2; // "reaching or just passed" window, in whole days
const STALE_NOTES_DAYS = 5; // no change in the notes for this long → flag it
const NOTES_SNAPSHOT_PATH = 'reports/monday-notes-snapshot.json';

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
      const allDateColIds = STAGE_DATE_COLUMNS.flatMap(sc => [sc.dateCol, sc.actualCol]).filter(Boolean);
      const colIds = ['multiple_person_mm5tfgfv', 'color_mksch3zh', 'long_text_mky5c0rm', ...allDateColIds];
      const query = `query {
        boards(ids: ${mondayBoardId}) {
          items_page(limit: 100) {
            items {
              id
              name
              column_values(ids: ${JSON.stringify(colIds)}) {
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

      // Load yesterday's notes snapshot, so we can tell what's actually new
      // versus what's just sitting there unchanged.
      let snapshot = {};
      try {
        const snapR = await ghGetRaw(NOTES_SNAPSHOT_PATH);
        if (snapR.exists) snapshot = JSON.parse(Buffer.from(snapR.content, 'base64').toString('utf-8'));
      } catch (snapErr) {
        console.error('[daily-digest] Failed to read notes snapshot (non-fatal, treating as first run):', snapErr.message);
      }
      const nowIso = new Date().toISOString();
      const updatedSnapshot = { ...snapshot };

      const items = json.data.boards[0].items_page.items;
      for (const item of items) {
        const cols = Object.fromEntries(item.column_values.map(c => [c.id, c.text]));
        const person = (cols['multiple_person_mm5tfgfv'] || '').trim();
        const stage = (cols['color_mksch3zh'] || '').trim();
        const notes = (cols['long_text_mky5c0rm'] || '').trim();

        if (!item.name || item.name === 'New Item') continue; // placeholder/template row
        if (/template|copy/i.test(item.name)) continue; // e.g. "Template to copy and RE-Name..."
        if (!stage && !notes) continue; // nothing informative to show
        // This digest is specifically for Martin and Seb — skip anything not
        // assigned to (at least) one of them, e.g. Jason's own properties or
        // anything still Unassigned.
        if (!/martin green|seb donald/i.test(person)) continue;

        // ---- Notes: only show what's actually new since yesterday ----
        const prior = snapshot[item.id];
        let notesDisplay, staleFlag = null;
        if (!notes) {
          notesDisplay = null;
        } else if (prior && prior.text === notes) {
          // Unchanged — keep the ORIGINAL first-seen date, don't reset the clock
          const daysSince = Math.floor((Date.now() - new Date(prior.since).getTime()) / (1000*60*60*24));
          notesDisplay = `No update since ${new Date(prior.since).toLocaleDateString('en-AU')} (${daysSince} day${daysSince===1?'':'s'} ago)`;
          if (daysSince >= STALE_NOTES_DAYS) staleFlag = `\u26a0\ufe0f No update in ${daysSince} days \u2014 may need follow-up`;
          updatedSnapshot[item.id] = prior; // unchanged, keep as-is
        } else {
          notesDisplay = notes; // genuinely new/changed text — show it in full
          updatedSnapshot[item.id] = { text: notes, since: nowIso };
        }

        // ---- Stage dates: flag anything reaching or just past its target ----
        const dateFlags = [];
        const now = new Date();
        const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        for (const sc of STAGE_DATE_COLUMNS) {
          const dateStr = cols[sc.dateCol];
          if (!dateStr) continue;
          if (sc.actualCol && cols[sc.actualCol]) continue; // already actually completed
          const target = new Date(dateStr + 'T00:00:00');
          if (isNaN(target.getTime())) continue;
          const dayDiff = Math.round((target.getTime() - todayMidnight.getTime()) / (1000 * 60 * 60 * 24));
          if (dayDiff >= -STAGE_DATE_WINDOW_DAYS && dayDiff <= STAGE_DATE_WINDOW_DAYS) {
            if (dayDiff === 0) dateFlags.push(`${sc.label} due today (${dateStr})`);
            else if (dayDiff > 0) dateFlags.push(`${sc.label} due ${dateStr} (in ${dayDiff} day${dayDiff===1?'':'s'})`);
            else dateFlags.push(`${sc.label} was due ${dateStr} \u2014 overdue by ${-dayDiff} day${dayDiff===-1?'':'s'}`);
          }
        }

        if (!mondayByPerson[person]) mondayByPerson[person] = [];
        mondayByPerson[person].push({ name: item.name, stage, notesDisplay, staleFlag, dateFlags });
      }

      // Save the updated snapshot for tomorrow's comparison.
      try {
        const snapExisting = await ghGetRaw(NOTES_SNAPSHOT_PATH);
        await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${NOTES_SNAPSHOT_PATH}`, {
          method: 'PUT',
          headers: ghHeaders(),
          body: JSON.stringify({
            message: 'Update Monday.com notes snapshot',
            content: Buffer.from(JSON.stringify(updatedSnapshot, null, 2), 'utf-8').toString('base64'),
            branch,
            ...(snapExisting.exists ? {} : {})
          })
        });
      } catch (saveErr) {
        console.error('[daily-digest] Failed to save notes snapshot (non-fatal):', saveErr.message);
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
        html += `<li>${p.name} \u2014 <i>${p.stage}</i>`;
        if (p.dateFlags && p.dateFlags.length) {
          html += `<br><span style="color:#A8461F;font-weight:bold;font-size:0.9em;">\ud83d\udcc5 ${p.dateFlags.join(' \u00b7 ')}</span>`;
        }
        if (p.staleFlag) {
          html += `<br><span style="color:#A8461F;font-size:0.9em;">${p.staleFlag}</span>`;
        }
        if (p.notesDisplay) {
          html += `<br><span style="color:#666;font-size:0.9em;">${p.notesDisplay.replace(/\n/g, '<br>')}</span>`;
        }
        html += `</li>`;
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

