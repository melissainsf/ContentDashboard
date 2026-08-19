// Millie's Content Dashboard — Lineage post performance.
//
// The dashboard knows which Lineage posts came out of which request,
// because the request pasted into #content-support carries the post URL:
//
//   app.virio.ai/lineage/<company-slug>/<post-uuid>
//
// That uuid is the id Lineage keys its analytics on, so this function
// turns a list of {company, postId} into engagement counts.
//
// Netlify env vars:
//   LINEAGE_API_KEY        (required) the Lineage API key
//   LINEAGE_POST_ANALYTICS_URL (optional) exact per-post analytics endpoint,
//                          as a template containing {company} and/or {postId},
//                          e.g. https://app.virio.ai/api/lineage/{company}/posts/{postId}/analytics
//   LINEAGE_API_BASE       (optional) base for the built-in candidates,
//                          default https://app.virio.ai/api
//   LINEAGE_DEBUG=1        (optional) include which URLs were tried
//
// IMPRESSIONS: Lineage does not expose impressions or views for LinkedIn
// posts. This function never returns them and never derives an engagement
// *rate*, because a rate needs a denominator that does not exist. Reporting
// an invented reach number would be worse than reporting nothing.
//
// POST { posts: [{ company, postId }] }
//   -> { analytics: { [postId]: { likes, comments, shares, reactions, syncedAt } },
//        configured, note, matched, requested }
//
// Failure is reported as configured:false with a note, not a 500 — the
// queue is still fully usable without performance data, and a dead tile is
// better than a dead page.

const MAX_POSTS = 120;      // one dashboard load; beyond this, paginate

// Lineage's analytics endpoint scopes every lookup to a company_id (uuid),
// but a request pasted into #content-support only ever carries the company
// slug (the segment in app.virio.ai/lineage/<slug>/<post-uuid>). This maps
// slug -> uuid so that id can be sent on every request.
//
// Snapshot taken once via the Lineage MCP's list_companies tool — not a live
// call, so it goes stale as clients are added or renamed. Re-run
// list_companies and refresh lineage-company-ids.json when a Post
// Performance row is missing for a client that's actually in Lineage.
// Longer term this belongs behind a real slug->id lookup (a Lineage
// endpoint, or a small periodic sync into Netlify Blobs) rather than a
// hand-maintained list.
const LINEAGE_COMPANY_IDS = require('./lineage-company-ids.json');

function companyIdFor(slug) {
  if (!slug) return null;
  return LINEAGE_COMPANY_IDS[String(slug).trim().toLowerCase()] || null;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return reply(400, { error: 'Invalid JSON body' }); }

  const posts = Array.isArray(body.posts) ? body.posts.slice(0, MAX_POSTS) : [];
  const requested = posts.length;

  const key = process.env.LINEAGE_API_KEY;
  if (!key) {
    return reply(200, {
      analytics: {}, configured: false, requested, matched: 0,
      note: 'LINEAGE_API_KEY is not set, so post performance is unavailable.'
    });
  }
  if (!requested) {
    return reply(200, { analytics: {}, configured: true, requested: 0, matched: 0, note: null });
  }

  const headers = { Authorization: 'Bearer ' + key, Accept: 'application/json' };
  const base = (process.env.LINEAGE_API_BASE || 'https://app.virio.ai/api').replace(/\/+$/, '');
  const template = process.env.LINEAGE_POST_ANALYTICS_URL || null;
  const debug = process.env.LINEAGE_DEBUG === '1';

  // The real endpoint (confirmed against Lineage's own analytics-service.ts):
  //   GET {base}/analytics/{postId}?company_id={uuid}
  // company_id is attached separately in fill(), via LINEAGE_COMPANY_IDS, so
  // it isn't written into the shape strings below. An explicit
  // LINEAGE_POST_ANALYTICS_URL always wins; the older guesses stay as a
  // fallback in case the real path ever moves.
  const shapes = template ? [template] : [
    base + '/analytics/{postId}',
    base + '/lineage/{company}/posts/{postId}/analytics',
    base + '/posts/{postId}/analytics',
    base + '/lineage/posts/{postId}/analytics',
    base + '/analytics/posts/{postId}'
  ];

  const analytics = {};
  const attempts = [];
  let workingShape = null;

  // Resolve the working shape once on the first post, then reuse it —
  // otherwise every post pays the cost of every failed guess.
  for (const shape of shapes) {
    const first = posts[0];
    try {
      const res = await fetch(fill(shape, first), { headers });
      if (!res.ok) { attempts.push({ shape, status: res.status }); continue; }
      const data = await res.json();
      const norm = normalize(data, first.postId);
      if (!norm) { attempts.push({ shape, note: 'unrecognised payload' }); continue; }
      analytics[first.postId] = norm;
      workingShape = shape;
      break;
    } catch (e) {
      attempts.push({ shape, error: e.message });
    }
  }

  if (!workingShape) {
    return reply(200, {
      analytics: {}, configured: false, requested, matched: 0,
      note: 'Could not reach a working Lineage analytics endpoint. Set LINEAGE_POST_ANALYTICS_URL to the real path.',
      ...(debug ? { attempts } : {})
    });
  }

  // Fetch the rest against the known-good shape, in small batches so one
  // dashboard load cannot open a hundred sockets at once.
  const rest = posts.slice(1);
  for (let i = 0; i < rest.length; i += 8) {
    await Promise.all(rest.slice(i, i + 8).map(async ref => {
      try {
        const res = await fetch(fill(workingShape, ref), { headers });
        if (!res.ok) return;                       // unpublished posts 404 — expected
        const norm = normalize(await res.json(), ref.postId);
        if (norm) analytics[ref.postId] = norm;
      } catch { /* one missing post must not fail the batch */ }
    }));
  }

  const matched = Object.keys(analytics).length;
  const withIcp = Object.keys(analytics).filter(k => analytics[k].icpRate != null).length;
  const notes = [];
  if (matched < requested) {
    notes.push((requested - matched) + ' of ' + requested + ' posts have no analytics yet — usually not published, or not synced from LinkedIn.');
  }
  if (matched && !withIcp) {
    notes.push('This endpoint is not returning an ICP rate, so that column is blank. Point LINEAGE_POST_ANALYTICS_URL at the endpoint behind the Lineage Analytics tab to fill it in.');
  }
  return reply(200, {
    analytics,
    configured: true,
    requested,
    matched,
    icpAvailable: withIcp > 0,
    note: notes.length ? notes.join(' ') : null,
    ...(debug ? { workingShape, attempts } : {})
  });
};

function fill(shape, ref) {
  const url = shape
    .replace('{company}', encodeURIComponent(ref.company || ''))
    .replace('{postId}', encodeURIComponent(ref.postId || ''));
  const companyId = companyIdFor(ref.company);
  if (!companyId) return url;
  return url + (url.includes('?') ? '&' : '?') + 'company_id=' + encodeURIComponent(companyId);
}

// Accept the analytics object at the top level or wrapped, and tolerate
// the usual naming drift. Returns null when nothing numeric was found, so
// the caller can tell "no data" from "zero engagement".
function normalize(data, postId) {
  const a = (data && (data.analytics || data.data || data.post || data)) || null;
  if (!a || typeof a !== 'object') return null;

  const num = (...keys) => {
    for (const k of keys) {
      const v = a[k];
      if (v != null && v !== '') {
        const n = Number(v);
        if (!isNaN(n)) return n;
      }
    }
    return null;
  };

  const likes = num('likes', 'reactions_count', 'reaction_count', 'like_count', 'total_reactions');
  const comments = num('comments', 'comment_count', 'total_comments');
  const reposts = num('shares', 'share_count', 'reposts', 'repost_count');
  if (likes === null && comments === null && reposts === null) return null;

  // ICP rate — the share of engagement coming from the client's ideal
  // customer profile, as shown on the Lineage Analytics tab. It is not
  // returned by the per-post analytics surface this function currently
  // reaches, so it is read from any of the plausible key names and left
  // null when absent. Null renders as "—"; it is never estimated, because
  // a made-up ICP rate would be read as a real result.
  let icpRate = num('icp_rate', 'icpRate', 'icp_percentage', 'icpPercentage',
                    'icp_engagement_rate', 'icp_reach_rate', 'icp');
  // Accept either 0-1 or 0-100 and normalise to a percentage.
  if (icpRate != null && icpRate > 0 && icpRate <= 1) icpRate = Math.round(icpRate * 1000) / 10;

  return {
    postId,
    likes: likes || 0,
    comments: comments || 0,
    reposts: reposts || 0,
    icpRate: icpRate == null ? null : icpRate,
    // Per-reaction breakdown when Lineage sends one (like/love/celebrate/…).
    reactions: (a.reactions && typeof a.reactions === 'object' && !Array.isArray(a.reactions)) ? a.reactions : null,
    postedAt: a.posted_at || a.postedAt || a.published_at || null,
    postUrl: a.post_url || a.postUrl || a.permalink || null,
    syncedAt: a.synced_at || a.syncedAt || null
    // No impressions, and no engagement rate — see the header.
  };
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
