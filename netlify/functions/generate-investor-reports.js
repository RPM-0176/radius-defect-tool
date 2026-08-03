// Radius Defect Checklist — monthly investor report generator
//
// Run this once a month (manually, via Netlify's "Run now", or put it on its
// own schedule in netlify.toml the same way daily-digest.js is scheduled) to
// pull together everything an investor would want to see about their
// property/properties for the month just finished:
//   - Current build stage and progress, straight from Monday.com
//   - Financial snapshot (budget, costs to date, cashflow) from Monday.com
//   - Anything flagged as a delay, dispute, or decision needed
//   - Every site visit logged that month (via "Log site visit" in the tool)
//   - Every inspection submitted that month via the checklist tool
//
// This does NOT generate a PDF or send anything anywhere. It only builds a
// clean data summary and stores it as a DRAFT, pending your review — the
// actual PDF gets built in the browser (reusing the same branded PDF code
// already used for defect reports) when you open it in the Investor Reports
// screen, and nothing goes to an investor until you've reviewed, approved,
// and downloaded it yourself to send however you normally would.
//
// Required Netlify environment variables — all already set up for the rest
// of the tool, nothing new needed:
//   GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH (optional)
//   MONDAY_API_TOKEN, MONDAY_BOARD_ID (optional, defaults to the SDA Project Pipeline board)

const GITHUB_API = 'https://api.github.com';
const MONDAY_API = 'https://api.monday.com/v2';

const INVESTOR_COLUMNS = {
  investor: 'color_mkxdge4y',
  buildStage: 'color_mksch3zh',
  approvedBudget: 'numeric_mm1980t5',
  costsToDate: 'numeric_mm19dssz',
  remainingBudget: 'formula_mm199mek',
  cashflowThisMonth: 'numeric_mm191az0',
  cashflowNextMonth: 'numeric_mm19s1a5',
  delay: 'color_mkxypfc',
  disputeStatus: 'color_mm194nzt',
  disputeSummary: 'long_text_mm19qdcw',
  decisionRequired: 'color_mm19ty3x',
  decisionDueDate: 'date_mm19mfpw',
  decisionRecommendation: 'long_text_mm19a05r',
  eotRequest: 'color_mm19g87b',
  eotSummary: 'long_text_mm19eeqz',
  builder: 'text_mm2f6j58',
  architect: 'text_mm1d49x3',
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
function addressesMatch(a, b) {
  const na = normalizeAddress(a), nb = normalizeAddress(b);
  if (!na || !nb) return false;
  const tokensA = na.split(' ').filter(Boolean);
  const tokensB = nb.split(' ').filter(Boolean);
  if (!tokensA.length || !tokensB.length) return false;
  const [shorter, longer] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  return shorter.every(t => longer.includes(t));
}

exports.handler = async (event) => {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  const mondayToken = process.env.MONDAY_API_TOKEN;
  const mondayBoardId = process.env.MONDAY_BOARD_ID || '5025662448';

  if (!token || !owner || !repo || !mondayToken) {
    return { statusCode: 500, body: 'Missing required env vars (GITHUB_TOKEN/OWNER/REPO, MONDAY_API_TOKEN)' };
  }

  function ghHeaders() {
    return {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'radius-defect-checklist-tool'
    };
  }
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
  async function ghPutContent(path, contentBase64, message, sha) {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`, {
      method: 'PUT', headers: ghHeaders(),
      body: JSON.stringify({ message, content: contentBase64, branch, ...(sha ? { sha } : {}) })
    });
    if (!res.ok) throw new Error('GitHub PUT ' + path + ' failed (' + res.status + '): ' + (await res.text()));
    return res.json();
  }
  async function ghListDir(path) {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, { headers: ghHeaders() });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error('GitHub list ' + path + ' failed (' + res.status + ')');
    const j = await res.json();
    return Array.isArray(j) ? j : [];
  }

  // Which month to report on — defaults to the month just finished, but can
  // be overridden (e.g. for a manual re-run) via ?month=2026-07
  const qp = (event && event.queryStringParameters) || {};
  const now = new Date();
  const defaultMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const targetMonth = qp.month || `${defaultMonth.getFullYear()}-${String(defaultMonth.getMonth() + 1).padStart(2, '0')}`;
  const [targetYear, targetMonthNum] = targetMonth.split('-').map(Number);

  function inTargetMonth(dateStr) {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    return d.getFullYear() === targetYear && (d.getMonth() + 1) === targetMonthNum;
  }

  try {
    // ---- 1. Pull every property from Monday.com with its investor + financials + risk flags ----
    const colIds = Object.values(INVESTOR_COLUMNS);
    const query = `query {
      boards(ids: ${mondayBoardId}) {
        items_page(limit: 100) {
          items {
            id
            name
            column_values(ids: ${JSON.stringify(colIds)}) { id text }
          }
        }
      }
    }`;
    const mondayRes = await fetch(MONDAY_API, {
      method: 'POST',
      headers: { 'Authorization': mondayToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });
    const mondayJson = await mondayRes.json();
    if (mondayJson.errors) throw new Error(JSON.stringify(mondayJson.errors));
    const items = mondayJson.data.boards[0].items_page.items;

    const byInvestor = {};
    for (const item of items) {
      const cols = Object.fromEntries(item.column_values.map(c => [c.id, c.text]));
      const investor = (cols[INVESTOR_COLUMNS.investor] || '').trim();
      if (!investor || /template|copy/i.test(item.name) || item.name === 'New Item') continue;
      if (!byInvestor[investor]) byInvestor[investor] = [];
      byInvestor[investor].push({
        name: item.name,
        buildStage: cols[INVESTOR_COLUMNS.buildStage] || '',
        approvedBudget: cols[INVESTOR_COLUMNS.approvedBudget] || '',
        costsToDate: cols[INVESTOR_COLUMNS.costsToDate] || '',
        remainingBudget: cols[INVESTOR_COLUMNS.remainingBudget] || '',
        cashflowThisMonth: cols[INVESTOR_COLUMNS.cashflowThisMonth] || '',
        cashflowNextMonth: cols[INVESTOR_COLUMNS.cashflowNextMonth] || '',
        delay: cols[INVESTOR_COLUMNS.delay] || '',
        disputeStatus: cols[INVESTOR_COLUMNS.disputeStatus] || '',
        disputeSummary: cols[INVESTOR_COLUMNS.disputeSummary] || '',
        decisionRequired: cols[INVESTOR_COLUMNS.decisionRequired] || '',
        decisionDueDate: cols[INVESTOR_COLUMNS.decisionDueDate] || '',
        decisionRecommendation: cols[INVESTOR_COLUMNS.decisionRecommendation] || '',
        eotRequest: cols[INVESTOR_COLUMNS.eotRequest] || '',
        eotSummary: cols[INVESTOR_COLUMNS.eotSummary] || '',
        builder: cols[INVESTOR_COLUMNS.builder] || '',
        architect: cols[INVESTOR_COLUMNS.architect] || '',
        siteVisits: [],
        inspections: [],
      });
    }

    // ---- 2. Site visits logged this month, matched to the right property ----
    const visitFolders = await ghListDir('site-visits');
    for (const folder of visitFolders) {
      if (folder.type !== 'dir') continue;
      const visitR = await ghGetRaw(`site-visits/${folder.name}/visit.json`);
      if (!visitR.exists) continue;
      let visit;
      try { visit = JSON.parse(Buffer.from(visitR.content, 'base64').toString('utf-8')); } catch (e) { continue; }
      if (!inTargetMonth(visit.date)) continue;
      for (const investor of Object.keys(byInvestor)) {
        for (const prop of byInvestor[investor]) {
          if (addressesMatch(prop.name, visit.project)) {
            prop.siteVisits.push({ date: visit.date, attendees: visit.attendees, notes: visit.notes, loggedBy: visit.loggedBy, photoCount: (visit.photos || []).length });
          }
        }
      }
    }

    // ---- 3. Checklist tool inspections submitted this month ----
    let registry = [];
    try {
      const regR = await ghGetRaw('reports/registry.json');
      if (regR.exists) registry = JSON.parse(Buffer.from(regR.content, 'base64').toString('utf-8'));
    } catch (e) { /* non-fatal */ }
    for (const entry of registry) {
      if (!entry.meta || !inTargetMonth(entry.submittedAt)) continue;
      for (const investor of Object.keys(byInvestor)) {
        for (const prop of byInvestor[investor]) {
          if (addressesMatch(prop.name, entry.meta.project || '')) {
            prop.inspections.push({
              stage: entry.meta.stage, date: entry.submittedAt, submittedBy: entry.submittedBy,
              status: entry.status, defects: entry.summary ? entry.summary.defects : undefined
            });
          }
        }
      }
    }

    // ---- 4. Store one draft report per investor, plus a lightweight registry entry ----
    const monthLabel = new Date(targetYear, targetMonthNum - 1, 1).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
    const regPath = 'investor-reports/registry.json';
    const regExisting = await ghGetRaw(regPath);
    let reportList = regExisting.exists ? JSON.parse(Buffer.from(regExisting.content, 'base64').toString('utf-8')) : [];

    const created = [];
    for (const investor of Object.keys(byInvestor)) {
      const investorSlug = investor.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const reportSlug = `${investorSlug}__${targetMonth}`;
      const data = { investor, month: targetMonth, monthLabel, generatedAt: new Date().toISOString(), properties: byInvestor[investor] };
      const dataPath = `investor-reports/${reportSlug}/data.json`;
      const dataExisting = await ghGetRaw(dataPath);
      await ghPutContent(
        dataPath, Buffer.from(JSON.stringify(data, null, 2), 'utf-8').toString('base64'),
        `Investor report draft: ${investor} \u2014 ${monthLabel}`,
        dataExisting.exists ? dataExisting.sha : undefined
      );

      const idx = reportList.findIndex(r => r.slug === reportSlug);
      const entry = { slug: reportSlug, investor, month: targetMonth, monthLabel, propertyCount: byInvestor[investor].length, generatedAt: data.generatedAt, status: 'pending', reviewedAt: null, dataPath };
      if (idx === -1) reportList.push(entry); else reportList[idx] = entry;
      created.push(reportSlug);
    }

    await ghPutContent(
      regPath, Buffer.from(JSON.stringify(reportList, null, 2), 'utf-8').toString('base64'),
      `Investor report registry update \u2014 ${monthLabel}`,
      regExisting.exists ? regExisting.sha : undefined
    );

    console.log(`[generate-investor-reports] Created/updated ${created.length} draft reports for ${monthLabel}:`, created.join(', '));
    return { statusCode: 200, body: JSON.stringify({ ok: true, month: monthLabel, reports: created }) };
  } catch (err) {
    console.error('[generate-investor-reports] Failed:', err.message);
    return { statusCode: 500, body: 'Failed: ' + err.message };
  }
};
