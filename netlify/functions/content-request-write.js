// Millie's Content Dashboard — write per-request state.
//
// The dashboard's own state for a content request, keyed by request id
// (the Slack message ts, or "<ts>:<n>" when one message carried several
// requests, or "manual-<n>" for requests added in the UI).
//
// Slack reactions still drive the default status, so the queue works even
// if nobody ever touches the dashboard. Anything stored here overrides
// them — that is what the tick boxes write.
//
// POST { id, patch: { status, completedAt, clientId, dueAt, posts, note, ... } }
//   patch keys set to null are removed. An entry with nothing left in it
//   is deleted, so clearing a tick returns the request to whatever Slack
//   says rather than pinning it to a stale value.
//
// Note: read-modify-write on a single "map" blob, matching the other
// write functions here. Edits are one person ticking boxes, so the
// concurrent-write window is not worth a locking scheme.

const STATUSES = new Set(['new', 'accepted', 'in_progress', 'blocked', 'done']);

// Only these keys are storable. An allowlist keeps a typo in the UI from
// silently writing a field nothing reads back.
const FIELDS = {
  status:      v => (STATUSES.has(String(v)) ? String(v) : undefined),
  completedAt: v => isoOrUndefined(v),
  requestedAt: v => isoOrUndefined(v),
  clientId:    v => (v ? String(v).slice(0, 64) : undefined),
  client:      v => (v ? String(v).slice(0, 120) : undefined),
  dueAt:       v => isoOrUndefined(v),
  posts:       v => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 50 ? Math.round(n) : undefined; },
  type:        v => (v ? String(v).slice(0, 40) : undefined),
  note:        v => (v ? String(v).slice(0, 1000) : undefined),
  requestedBy: v => (v ? String(v).slice(0, 120) : undefined),
  text:        v => (v ? String(v).slice(0, 2000) : undefined),
  manual:      v => (v ? true : undefined)
};

function isoOrUndefined(v) {
  if (!v) return undefined;
  const d = new Date(v);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return reply(400, { error: 'Invalid JSON body' }); }

  const id = body.id;
  if (!id || typeof id !== 'string' || id.length > 80) return reply(400, { error: 'id required' });

  const patch = body.patch;
  if (!patch || typeof patch !== 'object') return reply(400, { error: 'patch object required' });

  // Split the patch into values to set and keys to clear before touching
  // the store, so an invalid field fails the request instead of writing
  // half of it.
  const set = {};
  const clear = [];
  for (const [key, raw] of Object.entries(patch)) {
    if (!(key in FIELDS)) return reply(400, { error: `Unknown field "${key}"` });
    if (raw === null || raw === '') { clear.push(key); continue; }
    const value = FIELDS[key](raw);
    if (value === undefined) return reply(400, { error: `Invalid value for "${key}"` });
    set[key] = value;
  }

  try {
    const { connectLambda, getStore } = require('@netlify/blobs');
    if (typeof connectLambda === 'function') connectLambda(event);
    const store = getStore('content-requests');
    const map = (await store.get('map', { type: 'json' })) || {};
    const entry = Object.assign({}, map[id], set);
    clear.forEach(k => { delete entry[k]; });

    // Marking something done without saying when leaves the volume charts
    // with nothing to bucket, so stamp it here.
    if (entry.status === 'done' && !entry.completedAt) entry.completedAt = new Date().toISOString();
    if (entry.status && entry.status !== 'done') delete entry.completedAt;

    if (Object.keys(entry).length === 0) delete map[id]; else map[id] = entry;
    await store.setJSON('map', map);
    return reply(200, { ok: true, id, entry: map[id] || null });
  } catch (e) {
    return reply(500, { error: e.message });
  }
};

function reply(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body)
  };
}
