// Radius Defect Checklist — OneDrive / SharePoint upload helper
//
// Used by review.js when a report is approved. Finds the property's folder
// under:
//   SDA Housing / Clients / <client name> / Projects / <property address>
// then drops the PDF into that property's "Radius ... Reports" folder
// (creating a "Radius PM Reports" folder if the property doesn't have one).
//
// The client folder is found automatically by searching every client's
// Projects folder for a matching address, so nothing needs mapping by hand.
//
// Required Netlify environment variables (Microsoft Entra app registration):
//   MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET
// Optional:
//   MS_DRIVE_ID  - defaults to the Radius Property Group "Shared Documents" library

const GRAPH = 'https://graph.microsoft.com/v1.0';
const DEFAULT_DRIVE_ID = 'b!l_Hk-y_UcEenP7tn1ER8fJ9nu9PZKxpFmmftsRjRug9tZO5UbA6URq2wgoqZk7dV';
const CLIENTS_PATH = 'SDA Housing/Clients';
const REPORTS_FOLDER_PATTERN = /radius.*report/i;
const NEW_REPORTS_FOLDER_NAME = 'Radius PM Reports';
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;       // Graph's simple upload cap is 4MB
const CHUNK_SIZE = 320 * 1024 * 10;                // must be a multiple of 320 KiB

async function getToken() {
  const tenant = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  const secret = process.env.MS_CLIENT_SECRET;
  if (!tenant || !clientId || !secret) return null;
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: secret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error('Microsoft sign-in failed: ' + (json.error_description || json.error || res.status));
  }
  return json.access_token;
}

function encPath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function graph(token, method, url, body) {
  const res = await fetch(url.startsWith('http') ? url : GRAPH + url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return { notFound: true };
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON */ }
  if (!res.ok) {
    const msg = json && json.error && json.error.message ? json.error.message : text.slice(0, 200);
    throw new Error(`Graph ${method} failed (${res.status}): ${msg}`);
  }
  return json || {};
}

// All child folders of a path (follows paging).
async function listChildFolders(token, driveId, path) {
  let url = `/drives/${driveId}/root:/${encPath(path)}:/children?$select=id,name,folder&$top=200`;
  const folders = [];
  while (url) {
    const j = await graph(token, 'GET', url);
    if (j.notFound) return folders;
    (j.value || []).forEach(it => { if (it.folder) folders.push(it); });
    url = j['@odata.nextLink'] || null;
  }
  return folders;
}

async function listChildFoldersById(token, driveId, itemId) {
  let url = `/drives/${driveId}/items/${itemId}/children?$select=id,name,folder&$top=200`;
  const folders = [];
  while (url) {
    const j = await graph(token, 'GET', url);
    if (j.notFound) return folders;
    (j.value || []).forEach(it => { if (it.folder) folders.push(it); });
    url = j['@odata.nextLink'] || null;
  }
  return folders;
}

async function findPropertyFolder(token, driveId, address, addressesMatch, looseMatch, normalizeAddress) {
  const clients = await listChildFolders(token, driveId, CLIENTS_PATH);
  const target = normalizeAddress(address);
  const perClient = await Promise.all(clients.map(async client => ({
    client,
    props: await listChildFolders(token, driveId, `${CLIENTS_PATH}/${client.name}/Projects`),
  })));
  const strict = [], loose = [];
  for (const { client, props } of perClient) {
    for (const p of props) {
      const entry = { client: client.name, folder: p, exact: normalizeAddress(p.name) === target };
      if (addressesMatch(p.name, address)) strict.push(entry);
      else if (looseMatch && looseMatch(p.name, address)) loose.push(entry);
    }
  }
  const pool = strict.length ? strict : loose;
  if (!pool.length) return null;
  pool.sort((a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0));
  // More than one equally-good folder: don't guess — a client report in the
  // wrong property's folder is worse than none.
  if (pool.length > 1 && !pool[0].exact) {
    return { ambiguous: pool.map(m => `${m.client}/${m.folder.name}`) };
  }
  return pool[0];
}

async function uploadFile(token, driveId, parentId, filename, buffer) {
  const name = encodeURIComponent(filename);
  if (buffer.length <= SIMPLE_UPLOAD_LIMIT) {
    const res = await fetch(
      `${GRAPH}/drives/${driveId}/items/${parentId}:/${name}:/content?@microsoft.graph.conflictBehavior=replace`,
      { method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/pdf' }, body: buffer }
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Upload failed (${res.status}): ${json.error && json.error.message}`);
    return json;
  }
  // Larger than 4MB: use an upload session and send it in chunks.
  const session = await graph(token, 'POST',
    `/drives/${driveId}/items/${parentId}:/${name}:/createUploadSession`,
    { item: { '@microsoft.graph.conflictBehavior': 'replace' } });
  let last = null;
  for (let start = 0; start < buffer.length; start += CHUNK_SIZE) {
    const end = Math.min(start + CHUNK_SIZE, buffer.length);
    const res = await fetch(session.uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(end - start),
        'Content-Range': `bytes ${start}-${end - 1}/${buffer.length}`,
      },
      body: buffer.subarray(start, end),
    });
    if (!res.ok && res.status !== 202) {
      throw new Error(`Chunk upload failed (${res.status})`);
    }
    last = await res.json().catch(() => ({}));
  }
  return last;
}

// Returns { ok, ... } and never throws — a OneDrive problem must not undo an approval.
async function uploadReportToOneDrive({ address, filename, pdfBuffer, addressesMatch, looseMatch, normalizeAddress }) {
  try {
    const token = await getToken();
    if (!token) return { ok: false, reason: 'OneDrive not set up yet (MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET missing)' };
    const driveId = process.env.MS_DRIVE_ID || DEFAULT_DRIVE_ID;

    const found = await findPropertyFolder(token, driveId, address, addressesMatch, looseMatch, normalizeAddress);
    if (!found) return { ok: false, reason: `No OneDrive folder found for "${address}" under ${CLIENTS_PATH}/…/Projects` };
    if (found.ambiguous) return { ok: false, reason: `Several folders match "${address}" (${found.ambiguous.join('; ')}) — not guessing` };

    const subfolders = await listChildFoldersById(token, driveId, found.folder.id);
    let reportsFolder = subfolders.find(f => REPORTS_FOLDER_PATTERN.test(f.name));
    let created = false;
    if (!reportsFolder) {
      reportsFolder = await graph(token, 'POST', `/drives/${driveId}/items/${found.folder.id}/children`, {
        name: NEW_REPORTS_FOLDER_NAME,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'rename',
      });
      created = true;
    }

    const item = await uploadFile(token, driveId, reportsFolder.id, filename, pdfBuffer);
    return {
      ok: true,
      client: found.client,
      property: found.folder.name,
      folder: reportsFolder.name,
      createdFolder: created,
      fileUrl: item && item.webUrl,
    };
  } catch (err) {
    return { ok: false, reason: String(err && err.message ? err.message : err) };
  }
}

module.exports = { uploadReportToOneDrive };

