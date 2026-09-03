// Millie's Content Dashboard — drafts Millie wrote in Lineage.
//
// WHY THIS EXISTS
// The queue only ever knew about work somebody asked for in
// #content-support. Millie said so herself in that channel on
// 2026-07-15: "please drop some requests in! Otherwise I will be
// spending time looking at everyones accounts." Everything in that
// second category — the housekeeping, the accounts she picks up
// unprompted — never reached the Completed bucket, so the dashboard
// under-reported her.
//
// Lineage post records carry no author: the only person on a post is
// the client who publishes it. But Lineage's per-company ACTIVITY LOG
// stamps an actor id on every draft event, which is real per-post
// attribution. This function reads that log and returns the drafts
// created by one author.
//
// Netlify environment variables:
//   LINEAGE_API_KEY          (required) the Lineage API key
//   LINEAGE_ACTIVITY_URL     (see below) exact per-company activity endpoint,
//                            as a template containing {company}
//   LINEAGE_AUTHOR_ID        (optional) the Lineage user id to attribute to;
//                            defaults to Millie Hanson's
//   LINEAGE_ACTIVITY_EVENTS  (optional) comma-separated event types to count.
//                            Default: EVERY draft.* event, deduped to one row
//                            per draft. Counting only draft.created would be
//                            wrong — measured over the eight weeks from
//                            2026-07-08, Millie created 1 draft and worked 45.
//                            She rarely starts a post from scratch any more;
//                            she takes one the ghostwriter or an AM made and
//                            moves it through review and scheduling. Narrow
//                            this only if you specifically want authorship
//                            rather than work done.
//   LINEAGE_ACTIVITY_SINCE   (optional) ISO date floor, default 2026-08-01 —
//                            the point from which this team is tracking
//                            Millie's work. Takes precedence over _DAYS.
//   LINEAGE_ACTIVITY_DAYS    (optional) rolling window used only when
//                            LINEAGE_ACTIVITY_SINCE is blank; default 120
//   LINEAGE_API_BASE         (optional) base for the built-in candidates
//   LINEAGE_DEBUG=1          (optional) include which URLs were tried
//
// THE ENDPOINT IS NOT CONFIRMED. The activity log's shape is known and
// handled — it is JSON Lines, one event per line, with `actor`,
// `event_type`, `entity_id` and `ts` — because that is what the log
// actually contains. The REST path that serves it was never confirmed,
// so a few plausible shapes are tried and failure is reported plainly
// rather than dressed up as "no drafts". Set LINEAGE_ACTIVITY_URL to
// the real path and the guessing stops.
//
// POST { companies: ['netlify', 'minimal', ...] }
//   -> { drafts: [{ company, postId, ts, title }], configured, note,
//        authorId, events, companiesScanned }

const MAX_COMPANIES = 60;   // one dashboard load
const BATCH = 6;            // never open sixty sockets at once
const DEFAULT_AUTHOR = '82d663fe-f00e-4892-ad16-37ac9837d7f7';  // Millie Hanson
const DEFAULT_SINCE = '2026-08-01';   // the team tracks Millie's work from here
const snapshot = require('./_lineage-snapshot.js');

const { requireVirioUser } = require('./_auth.js');

exports.handler = async function (event) {
  const gate = await requireVirioUser(event);
  if (!gate.ok) return gate.response;

  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return reply(400, { error: 'Invalid JSON body' }); }

  const companies = (Array.isArray(body.companies) ? body.companies : [])
    .map(c => String(c || '').trim().toLowerCase())
    .filter(Boolean)
    .filter((c, i, a) => a.indexOf(c) === i)
    .slice(0, MAX_COMPANIES);

  const authorId = process.env.LINEAGE_AUTHOR_ID || DEFAULT_AUTHOR;
  // Empty means "any draft.* event" — see the header. An explicit list
  // narrows it.
  const events = (process.env.LINEAGE_ACTIVITY_EVENTS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  // A fixed floor rather than a rolling window: the team tracks Millie's
  // work from a specific date, and a rolling window would quietly drop the
  // early weeks out of the total as time passed.
  const sinceRaw = process.env.LINEAGE_ACTIVITY_SINCE === undefined
    ? DEFAULT_SINCE
    : process.env.LINEAGE_ACTIVITY_SINCE;
  const days = Number(process.env.LINEAGE_ACTIVITY_DAYS || 120);
  const since = sinceRaw
    ? new Date(sinceRaw + (sinceRaw.length === 10 ? 'T00:00:00Z' : ''))
    : new Date(Date.now() - days * 86400000);
  const sinceISO = since.toISOString().slice(0, 10);
  const debug = process.env.LINEAGE_DEBUG === '1';

  const key = process.env.LINEAGE_API_KEY;
  if (!key) {
    return reply(200, {
      drafts: [], configured: false, authorId, events, companiesScanned: 0,
      since: sinceISO, source: 'none',
      note: 'LINEAGE_API_KEY is not set, so work done in Lineage cannot be counted.'
    });
  }
  if (!companies.length) {
    return reply(200, { drafts: [], configured: true, authorId, events, companiesScanned: 0,
      since: sinceISO, source: 'live', note: null });
  }

  const headers = { Authorization: 'Bearer ' + key, Accept: 'application/json' };
  const base = (process.env.LINEAGE_API_BASE || 'https://app.virio.ai/api').replace(/\/+$/, '');
  const template = process.env.LINEAGE_ACTIVITY_URL || null;
  const shapes = template ? [template] : [
    base + '/lineage/{company}/activity',
    base + '/companies/{company}/activity',
    base + '/lineage/{company}/conversations/trigger-log.jsonl',
    base + '/workspace/{company}/conversations/trigger-log.jsonl'
  ];

  const attempts = [];
  let workingShape = null;
  let drafts = [];

  // Resolve the working shape once, then reuse it — otherwise every
  // company pays the cost of every failed guess.
  for (const shape of shapes) {
    try {
      const res = await fetch(fill(shape, companies[0]), { headers });
      if (!res.ok) { attempts.push({ shape, status: res.status }); continue; }
      const parsed = parseLog(await res.text(), companies[0], authorId, events, since);
      if (parsed === null) { attempts.push({ shape, note: 'unrecognised payload' }); continue; }
      drafts = parsed;
      workingShape = shape;
      break;
    } catch (e) {
      attempts.push({ shape, error: e.message });
    }
  }

  // No live endpoint. Serve the committed snapshot rather than nothing:
  // an empty list here would silently report only the Slack queue and read
  // as though Millie had done a fraction of her actual work. It is always
  // labelled as a snapshot, with its capture date, so it is never mistaken
  // for live data.
  if (!workingShape) {
    const rows = snapshot.drafts.filter(d => !d.ts || new Date(d.ts) >= since);
    return reply(200, {
      drafts: rows,
      configured: true,
      source: 'snapshot',
      capturedAt: snapshot.capturedAt,
      since: sinceISO,
      authorId, events,
      companiesScanned: new Set(rows.map(d => d.company)).size,
      // The blind-spot count comes from the snapshot itself rather than a
      // number written here, so it stays true as accounts come and go.
      note: 'Lineage is not connected, so these ' + rows.length + ' are a snapshot read from its activity ' +
            'log on ' + snapshot.capturedAt + ', not live. It is also a floor: ' +
            (snapshot.stopsBeforeWindow || []).length + ' of ' + (snapshot.accountsScanned || 0) +
            ' accounts have logs that stop before ' + sinceISO +
            ', so work there is real but uncounted. Set LINEAGE_ACTIVITY_URL to go live.',
      ...(debug ? { attempts } : {})
    });
  }

  const rest = companies.slice(1);
  let failures = 0;
  for (let i = 0; i < rest.length; i += BATCH) {
    await Promise.all(rest.slice(i, i + BATCH).map(async co => {
      try {
        const res = await fetch(fill(workingShape, co), { headers });
        if (!res.ok) { failures++; return; }        // an account with no log yet
        const parsed = parseLog(await res.text(), co, authorId, events, since);
        if (parsed) drafts = drafts.concat(parsed);
        else failures++;
      } catch { failures++; }                       // one bad account must not fail the rest
    }));
  }

  drafts.sort((a, b) => new Date(b.ts) - new Date(a.ts));

  const notes = [];
  if (failures) {
    notes.push(failures + ' of ' + companies.length + ' accounts had no readable activity log, so drafts there are not counted.');
  }
  if (!drafts.length) {
    notes.push('No draft activity by this author in the last ' + days + ' days across the accounts scanned. ' +
               'Note that a busy account\'s activity log is capped at about 2,000 events and keeps the OLDEST, ' +
               'so recent work on the busiest accounts can fall outside it.');
  }
  return reply(200, {
    drafts,
    configured: true,
    source: 'live',
    since: sinceISO,
    authorId,
    events: events.length ? events : ['draft.*'],
    companiesScanned: companies.length - failures,
    note: notes.length ? notes.join(' ') : null,
    ...(debug ? { workingShape, attempts } : {})
  });
};

function fill(shape, company) {
  return shape.replace('{company}', encodeURIComponent(company));
}

// The activity log is JSON Lines. Accept a JSON array or a wrapped
// { content } / { events } object too, because the surface that serves
// it is internal and may wrap. Returns null when the payload is not an
// activity log at all, so the caller can tell "wrong endpoint" from
// "this author did nothing here".
function parseLog(text, company, authorId, events, since) {
  let rows = null;

  const trimmed = String(text || '').trim();
  if (!trimmed) return null;

  if (trimmed[0] === '{' || trimmed[0] === '[') {
    try {
      const data = JSON.parse(trimmed);
      if (Array.isArray(data)) rows = data;
      else if (data && typeof data === 'object') {
        if (Array.isArray(data.events)) rows = data.events;
        else if (typeof data.content === 'string') rows = jsonLines(data.content);
      }
    } catch { /* fall through to JSON Lines */ }
  }
  if (rows === null) rows = jsonLines(trimmed);
  if (rows === null || !rows.length) return null;

  // An activity log has actors and event types. Anything without them
  // is a different endpoint, and reporting zero drafts off it would be
  // a lie dressed as a result.
  if (!rows.some(r => r && r.actor && (r.event_type || r.content))) return null;

  const out = [];
  rows.forEach(r => {
    if (!r || r.actor !== authorId) return;
    const type = String(r.event_type || r.content || '');
    if (events.length ? events.indexOf(type) === -1 : type.indexOf('draft.') !== 0) return;
    if (r.entity_type && r.entity_type !== 'draft') return;
    const postId = r.entity_id || r.draft_id;
    if (!postId) return;
    if (r.ts && since && new Date(r.ts) < since) return;
    out.push({ company, postId: String(postId).toLowerCase(), ts: r.ts || null, title: r.title || null });
  });
  return out;
}

function jsonLines(text) {
  const out = [];
  let any = false;
  String(text).split('\n').forEach(line => {
    const t = line.trim();
    if (!t || t[0] !== '{') return;
    any = true;
    try { out.push(JSON.parse(t)); } catch { /* a truncated tail line is not fatal */ }
  });
  return any ? out : null;
}

function reply(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(body)
  };
}

// Exported so the test suite can exercise the log parser against real
// trigger-log lines without a network call. Netlify only ever calls
// `handler`; the extra export is inert there.
exports.parseLog = parseLog;
