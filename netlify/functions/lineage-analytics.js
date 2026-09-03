// Millie's Content Dashboard — Lineage post performance.
//
// The dashboard knows which Lineage posts came out of which request,
// because the request pasted into #content-support carries the post URL:
//
//   app.virio.ai/lineage/<company-slug>/<post-uuid>
//
// That uuid is the id Lineage keys its analytics on, so this function
// turns a list of {company, postId} into engagement counts, the Virio
// teammates who worked the post, and an ICP rate.
//
// Three upstream surfaces, all authed with the same `jq_live_…` key:
//
//   1. GET {LINEAGE_API_BASE}/analytics/{postId}?company_id={uuid}
//      likes / comments / shares / reactions / synced_at.
//   2. GET {LINEAGE_API_BASE}/drafts/{postId}/events?limit=50
//      the post's lifecycle feed — who moved it through review, approval,
//      scheduling and publishing, and when it was scheduled for.
//   3. GET {VIRIO_API_BASE}/api/reports?companyId={uuid}&type=icp_internal
//      then /api/reports/{id} — the generated ICP engagement report the
//      Lineage Analytics tab reads. ICP rate lives here and nowhere else.
//
// Netlify env vars:
//   LINEAGE_API_KEY        (required) a `jq_live_…` key from Settings → API keys.
//                          Access follows the user who minted it: internal
//                          staff see every company, anyone else only their own.
//   LINEAGE_API_BASE       (optional) default https://app.virio.ai/api
//   VIRIO_API_BASE         (optional) default https://api.virio.ai
//   LINEAGE_POST_ANALYTICS_URL (optional) override for the per-post analytics
//                          path, kept for the case where that route moves.
//   LINEAGE_DEBUG=1        (optional) include which URLs were tried
//
// IMPRESSIONS: Lineage does not expose impressions or views for LinkedIn
// posts. This function never returns them and never derives an engagement
// *rate*, because a rate needs a denominator that does not exist. Reporting
// an invented reach number would be worse than reporting nothing.
//
// POST { posts: [{ company, postId }] }
//   -> { analytics: { [postId]: { likes, comments, shares, reactions,
//                                 workedBy, postedAt, icpRate, syncedAt } },
//        configured, note, matched, requested }
//
// Failure is reported as configured:false with a note, not a 500 — the
// queue is still fully usable without performance data, and a dead tile is
// better than a dead page.

const MAX_POSTS = 120;      // one dashboard load; beyond this, paginate
const BATCH = 8;            // concurrent upstream calls

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

// ICP reports change roughly weekly (they are generated on demand from the
// Analytics tab), so a warm instance can reuse them across dashboard loads.
// Keyed by company uuid; short enough that a freshly generated report shows
// up the same morning.
const ICP_CACHE_TTL_MS = 15 * 60 * 1000;
const icpCache = new Map();

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
  const virioBase = (process.env.VIRIO_API_BASE || 'https://api.virio.ai').replace(/\/+$/, '');
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

  // ICP reports are per company, not per post, and they are the slowest hop
  // (a list call plus one detail call per FOC). Kick them off first so they
  // overlap the per-post fan-out below instead of running after it.
  const companyIds = [];
  posts.forEach(p => {
    const id = companyIdFor(p.company);
    if (id && companyIds.indexOf(id) === -1) companyIds.push(id);
  });
  const icpByCompany = {};
  // Chunked like the per-post calls: a cold instance loading a queue that
  // spans thirty clients would otherwise fire thirty list calls and every
  // report detail behind them at once, and a report body carries the whole
  // ICP match list with its reasoning text.
  const icpWork = (async () => {
    for (let i = 0; i < companyIds.length; i += BATCH) {
      await Promise.all(companyIds.slice(i, i + BATCH).map(async id => {
        icpByCompany[id] = await icpRatesForCompany(virioBase, headers, id);
      }));
    }
  })().catch(() => { /* ICP is additive; never fail the load over it */ });

  // Resolve the working analytics shape once on the first post, then reuse
  // it — otherwise every post pays the cost of every failed guess.
  //
  // A 404 is ambiguous: it is what a wrong URL returns, and also what the
  // right URL returns for a post that isn't published yet. Lineage's route
  // says which by its body — `{"error":"Analytics not found"}` comes from
  // the route itself, so the shape is right and only the data is missing.
  // Without that distinction, a first post that happened to be unpublished
  // took down the whole tab.
  for (const shape of shapes) {
    const first = posts[0];
    try {
      const res = await fetch(fill(shape, first), { headers });
      if (!res.ok) {
        if (res.status === 404 && await isRouteLevelNotFound(res)) {
          workingShape = shape;                    // route reached; no data for this post
          attempts.push({ shape, status: 404, note: 'route reached, post has no analytics' });
          break;
        }
        attempts.push({ shape, status: res.status });
        continue;
      }
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

  // Walk the posts in small batches so one dashboard load cannot open a
  // hundred sockets at once. Each post's two calls — engagement counts and
  // the lifecycle feed — go out together rather than in two passes over the
  // whole list, which would double the number of sequential round trips and
  // put a full queue within reach of the function timeout.
  //
  // The feed is fetched for every post, not just the measured ones: knowing
  // who worked a post is most useful before it is published, which is
  // exactly when engagement counts don't exist yet. With no working
  // analytics shape the feed still runs — attribution does not depend on
  // the analytics route answering.
  const activity = {};
  let activityReachable = false;
  for (let i = 0; i < posts.length; i += BATCH) {
    await Promise.all(posts.slice(i, i + BATCH).map(async ref => {
      const [, act] = await Promise.all([
        (async () => {
          // The first post's counts were already fetched by the shape probe.
          if (!workingShape || ref === posts[0]) return;
          try {
            const res = await fetch(fill(workingShape, ref), { headers });
            if (!res.ok) return;                   // unpublished posts 404 — expected
            const norm = normalize(await res.json(), ref.postId);
            if (norm) analytics[ref.postId] = norm;
          } catch { /* one missing post must not fail the batch */ }
        })(),
        fetchActivity(base, headers, ref.postId)
      ]);
      if (!act) return;
      activityReachable = true;
      activity[ref.postId] = act;
    }));
  }

  await icpWork;

  // Merge the three surfaces onto one per-post record.
  posts.forEach(ref => {
    const act = activity[ref.postId];
    const row = analytics[ref.postId];
    if (!act && !row) return;
    const merged = row || emptyRow(ref.postId);
    if (act) {
      merged.workedBy = act.workedBy;
      merged.postedAt = act.scheduledFor || merged.postedAt;
    }
    const icp = icpByCompany[companyIdFor(ref.company)];
    if (icp && merged.postedAt) {
      const rate = icp.byDate[String(merged.postedAt).slice(0, 10)];
      // `null` in the map means "two posts share this date" — the report
      // gives no post id, so which rate belongs to which post is unknowable.
      // Blank beats a coin flip.
      if (rate != null) merged.icpRate = Math.round(rate * 1000) / 10;
    }
    analytics[ref.postId] = merged;
  });

  const measured = Object.keys(analytics).filter(k => analytics[k].measured);
  const matched = measured.length;
  const withIcp = Object.keys(analytics).filter(k => analytics[k].icpRate != null).length;
  const withWorkedBy = Object.keys(analytics).filter(k => (analytics[k].workedBy || []).length).length;
  const icpCompanies = companyIds.filter(id => icpByCompany[id] && icpByCompany[id].reportCount);

  const notes = [];
  if (!workingShape) {
    notes.push('Could not reach a working Lineage analytics endpoint, so engagement counts are missing. Set LINEAGE_POST_ANALYTICS_URL to the real path.');
  }
  if (workingShape && matched < requested) {
    notes.push((requested - matched) + ' of ' + requested + ' posts have no analytics yet — usually not published, or not synced from LinkedIn.');
  }
  if (!activityReachable) {
    notes.push('The Lineage activity feed did not answer, so the "worked by" column is blank.');
  }
  if (!icpCompanies.length) {
    notes.push('No ICP engagement report has been generated for these clients yet, so the ICP column is blank.');
  } else if (!withIcp) {
    notes.push('ICP reports exist but none of these posts matched one by publish date, so the ICP column is blank.');
  }
  return reply(200, {
    analytics,
    configured: !!workingShape,
    requested,
    matched,
    icpAvailable: withIcp > 0,
    attributed: withWorkedBy,
    note: notes.length ? notes.join(' ') : null,
    ...(debug ? { workingShape, attempts, icpCompanies } : {})
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

/**
 * Lineage's analytics route answers a missing post with its own body rather
 * than a bare 404, which is the only way to tell "right URL, no data" from
 * "wrong URL". Mirrors the same check in jacquard's lineage-mcp client.
 */
async function isRouteLevelNotFound(res) {
  try {
    const body = await res.json();
    return !!(body && typeof body.error === 'string' && /analytics not found/i.test(body.error));
  } catch {
    return false;
  }
}

function emptyRow(postId) {
  return {
    postId, likes: 0, comments: 0, reposts: 0, icpRate: null, reactions: null,
    postedAt: null, postUrl: null, syncedAt: null, workedBy: [], measured: false
  };
}

// ── attribution ─────────────────────────────────────────────────
//
// Lineage post records carry no author: `list_posts`/`get_post` return the
// profile that publishes, i.e. the client. The only per-post record of who
// on our side touched the work is the lifecycle feed, which stamps an actor
// on every state change.
//
// What it does NOT cover, and why the column is sometimes blank:
//   - Edits. `draft.updated` is deliberately excluded from the feed's
//     allowlist upstream, so typing does not show up — only moving a post
//     through review, approval, scheduling and publishing.
//   - Teammates whose Lineage account is not on an @virio.ai address. The
//     feed has no is_internal flag, so the domain is the only signal here.
//   - Self-managed clients who run the whole post themselves.
// Measured against production, roughly three quarters of published posts in
// the clients this dashboard covers get at least one Virio actor.

const INTERNAL_DOMAIN = '@virio.ai';

function isInternalEmail(email) {
  return typeof email === 'string' && email.toLowerCase().endsWith(INTERNAL_DOMAIN);
}

function actorName(actor) {
  const name = [actor.first_name, actor.last_name].filter(Boolean).join(' ').trim();
  return name || actor.email || 'Unknown';
}

/**
 * One teammate, one row. Nearly every Virio person has two Lineage accounts —
 * `name@virio.ai` for our own tenant and `name+service@virio.ai` for the seat
 * they hold inside a client's — and a post routinely carries events from both.
 * Plus-addressing is the convention, so the tag is dropped to group them.
 */
function personKey(email) {
  return String(email).toLowerCase().replace(/\+[^@]*(?=@)/, '');
}

/**
 * Rank the Virio people on a post's feed: most events first, ties broken by
 * who acted most recently. The whole list is returned, not just the winner —
 * a post often passes through two hands and the UI can say so.
 */
function rankWorkedBy(events) {
  const by = {};
  (events || []).forEach(e => {
    const actor = e && e.actor;
    if (!actor || !isInternalEmail(actor.email)) return;
    const k = personKey(actor.email);
    if (!by[k]) by[k] = { name: actorName(actor), email: k, events: 0, lastAt: null };
    by[k].events++;
    if (!by[k].lastAt || (e.at && e.at > by[k].lastAt)) by[k].lastAt = e.at || null;
  });
  return Object.keys(by).map(k => by[k]).sort((a, b) =>
    b.events - a.events || String(b.lastAt || '').localeCompare(String(a.lastAt || '')));
}

/**
 * The date the post went out, taken from the latest schedule event.
 *
 * The per-post analytics route does not return a publish date, and the ICP
 * report is keyed by date, so this is the join key between them. Checked
 * against production: for posts that were scheduled, the last
 * `to_scheduled_at` matches the actual published date on 679 of 685 posts.
 * Posts pushed out with "publish now" have no schedule event and get no
 * date here — hence no ICP rate.
 */
function scheduledDate(events) {
  let latest = null, when = null;
  (events || []).forEach(e => {
    if (!e || (e.type !== 'draft.scheduled' && e.type !== 'draft.rescheduled')) return;
    const to = e.payload && e.payload.to_scheduled_at;
    if (!to) return;
    if (!when || String(e.at) > when) { when = String(e.at); latest = to; }
  });
  return latest;
}

async function fetchActivity(base, headers, postId) {
  try {
    const res = await fetch(base + '/drafts/' + encodeURIComponent(postId) + '/events?limit=50', { headers });
    if (!res.ok) return null;
    const data = await res.json();
    const events = Array.isArray(data && data.events) ? data.events : [];
    return { workedBy: rankWorkedBy(events), scheduledFor: scheduledDate(events) };
  } catch {
    return null;
  }
}

// ── ICP rate ────────────────────────────────────────────────────
//
// ICP rate is not part of either analytics surface. The Lineage Analytics
// tab reads it out of a generated ICP engagement report on virio-api and
// builds a date -> rate map, exactly as this does. Consequences worth
// knowing before trusting the column:
//   - It exists only for clients somebody has generated a report for.
//   - It is keyed by publish DATE, not by post. Two posts published the
//     same day are indistinguishable in the report, so both are left blank
//     rather than both being given a number that belongs to one of them.
//   - Reports are per FOC, so a client with several posting users needs
//     several reports merged — which is where most same-day collisions
//     come from.

async function icpRatesForCompany(virioBase, headers, companyId) {
  const cached = icpCache.get(companyId);
  if (cached && Date.now() - cached.at < ICP_CACHE_TTL_MS) return cached.value;

  const empty = { byDate: {}, reportCount: 0, summaryRate: null, generatedAt: null };
  let value = empty;
  try {
    const listRes = await fetch(
      virioBase + '/api/reports?type=icp_internal&limit=100&companyId=' + encodeURIComponent(companyId),
      { headers });
    if (listRes.ok) {
      const list = await listRes.json();
      const rows = (list && list.reports ? list.reports : []).filter(r => r.status === 'completed');

      // Newest completed report per FOC. An older run for one FOC still
      // carries that FOC's posts, which a company-wide "latest" would drop.
      const latestPerUser = {};
      rows.forEach(r => {
        const k = r.user_id || 'unknown';
        if (!latestPerUser[k] || String(r.created_at) > String(latestPerUser[k].created_at)) latestPerUser[k] = r;
      });
      const picks = Object.keys(latestPerUser).map(k => latestPerUser[k]).slice(0, 6);

      const details = await Promise.all(picks.map(async r => {
        try {
          const res = await fetch(virioBase + '/api/reports/' + encodeURIComponent(r.id), { headers });
          if (!res.ok) return null;
          const body = await res.json();
          return body && body.report ? body.report : null;
        } catch { return null; }
      }));

      value = mergeIcpReports(details.filter(Boolean));
    }
  } catch { /* fall through to empty */ }

  icpCache.set(companyId, { at: Date.now(), value });
  return value;
}

/**
 * Fold report bodies into one date -> rate map. A date claimed by more than
 * one post maps to null: present, but not attributable.
 */
function mergeIcpReports(reports) {
  const seen = {};
  let summaryRate = null, generatedAt = null;
  reports.forEach(rep => {
    const json = rep && rep.result_json;
    if (!json) return;
    if (!generatedAt || String(rep.created_at) > generatedAt) {
      generatedAt = String(rep.created_at);
      const s = json.summary || {};
      if (typeof s.icp_engagement_rate === 'number') summaryRate = s.icp_engagement_rate;
    }
    (Array.isArray(json.post_analysis) ? json.post_analysis : []).forEach(entry => {
      if (!entry || !entry.posted_at || typeof entry.icp_rate !== 'number') return;
      const d = String(entry.posted_at).slice(0, 10);
      if (Object.prototype.hasOwnProperty.call(seen, d)) seen[d] = null;   // collision
      else seen[d] = entry.icp_rate;
    });
  });
  return { byDate: seen, reportCount: reports.length, summaryRate, generatedAt };
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

  // ICP rate is filled in from the report merge above. It is read here too,
  // in case the analytics route ever starts returning one directly.
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
    syncedAt: a.synced_at || a.syncedAt || null,
    workedBy: [],
    // Engagement counts came back for this post. Rows that exist only
    // because somebody worked the post still render, but must not count
    // toward "posts measured".
    measured: true
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

// Exported for the unit tests; the deploy only needs `handler`.
exports.rankWorkedBy = rankWorkedBy;
exports.scheduledDate = scheduledDate;
exports.mergeIcpReports = mergeIcpReports;
