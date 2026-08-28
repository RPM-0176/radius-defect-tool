// Radius Defect Checklist — address list
//
// Feeds the Project/Property autocomplete in the app so PMs pick an address
// from Monday.com instead of typing it (and mistyping it — which is what
// breaks the fuzzy address matching in review.js's Monday sync).
//
// To REMOVE a property from the dropdown once the house is done: just move
// its item on Monday into the "Fully Leased Properties" group. Nothing to
// configure here — this endpoint simply excludes that group.
//
// Required Netlify environment variables (same ones review.js already uses):
//   MONDAY_API_TOKEN
//   MONDAY_BOARD_ID (optional — defaults to the SDA Project Pipeline board)

const MONDAY_API = 'https://api.monday.com/v2';

// "Fully Leased Properties" group on the SDA Project Pipeline board.
const EXCLUDED_GROUP_ID = 'group_mm0qh6qh';

// Non-property rows that sometimes sit in the "All SDA" group (a fresh
// template row, a duplicate-and-forgot-to-rename row) — filtered out by
// name so they never show up as a selectable address.
const IGNORED_NAME_PATTERNS = [
  /^new item$/i,
  /^template to copy/i,
];

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const mondayToken = process.env.MONDAY_API_TOKEN;
  const mondayBoardId = process.env.MONDAY_BOARD_ID || '5025662448';
  if (!mondayToken) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server is not configured yet (missing MONDAY_API_TOKEN).' }) };
  }

  try {
    // The board currently has well under 500 items — a single page comfortably
    // covers it. If the board ever grows past that, this will need to follow
    // next_items_page/cursor like a normal paginated Monday query.
    const query = `query {
      boards(ids: ${mondayBoardId}) {
        items_page(limit: 500) {
          items { id name group { id title } }
        }
      }
    }`;
    const res = await fetch(MONDAY_API, {
      method: 'POST',
      headers: { 'Authorization': mondayToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query })
    });
    const json = await res.json();
    if (json.errors) throw new Error('Monday item lookup failed: ' + JSON.stringify(json.errors));

    const items = json.data.boards[0].items_page.items;
    const addresses = items
      .filter(it => !it.group || it.group.id !== EXCLUDED_GROUP_ID)
      .filter(it => !IGNORED_NAME_PATTERNS.some(re => re.test(it.name)))
      .map(it => it.name)
      .sort((a, b) => a.localeCompare(b));

    return {
      statusCode: 200,
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: true, addresses, fetchedAt: new Date().toISOString() })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err && err.message ? err.message : err) }) };
  }
};
