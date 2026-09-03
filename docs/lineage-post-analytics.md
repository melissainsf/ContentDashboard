# Post analytics via Lineage

How the Post Performance tab and the Completed widget get real
likes/comments/reposts numbers for each post, who on our team worked it,
and its ICP rate — and how to keep that working as clients are added.

## The problem this solves

Lineage's per-post analytics endpoint scopes every lookup to a company id
(a uuid). A request pasted into `#content-support` only ever carries the
company **slug** — the segment in `app.virio.ai/lineage/<slug>/<post-uuid>`
— never the uuid. `netlify/functions/lineage-analytics.js` closes that gap
with a hardcoded slug → uuid table, sent as `company_id` on every request.

## Request flow

1. The browser calls this site's `/api/lineage-analytics` with
   `{ posts: [{ company: "<slug>", postId: "<uuid>" }, ...] }` — one entry
   per completed request that has a Lineage link.
2. `lineage-analytics.js` looks up each `company` slug in
   `lineage-company-ids.json` to get the matching uuid.
3. It calls Lineage's real endpoint with both ids:
   ```
   GET {LINEAGE_API_BASE}/analytics/{postId}?company_id={uuid}
   Authorization: Bearer {LINEAGE_API_KEY}
   ```
   (`LINEAGE_API_BASE` defaults to `https://app.virio.ai/api`.)
4. Lineage returns `{ likes, comments, shares, synced_at, ... }` for a
   published post, or 404 if the post isn't published yet / hasn't synced
   from LinkedIn. Either way this function never errors the page — see
   "Failure modes" below.

If a slug isn't in the table, `company_id` is simply omitted from the
request and the call falls through to a handful of older guessed URL
shapes, kept only as a fallback in case the real path ever moves.

## Why setting `LINEAGE_POST_ANALYTICS_URL` alone doesn't work

The original design (see git history on this file's function) assumed
the only missing piece was the URL itself: point `LINEAGE_POST_ANALYTICS_URL`
at the real path and everything would work. That turned out to be wrong
in a way no URL template can fix.

Lineage's real endpoint (`GET /api/analytics/{postId}`) requires a
`company_id` **query parameter**, and its handler rejects the request
outright without one — see `requireCompanyAccess` and the `company_id`
check in Lineage's own `src/routes/api/analytics/$draftId.ts`. A caller
that doesn't supply `company_id` never even reaches the analytics lookup.

The dashboard has no uuid to put there. Every place this app learns about
a post — the Slack message, the pasted Lineage link — only ever carries
the company **slug**. There is no cheap "resolve slug to uuid" endpoint on
Lineage's side to call at request time. So no matter how correct the URL
template is, the request 400s without a second piece of information the
URL alone can't carry. That's what `lineage-company-ids.json` supplies.

(We also considered changing Lineage's route to make `company_id`
optional and resolve it server-side from the post — a small, reviewed
change — but reverted it once this mapping made it unnecessary. No fix on
Lineage's side is required for this to work.)

## The company table

`netlify/functions/lineage-company-ids.json` — a plain `{ slug: uuid }`
object, loaded with `require()`. It is a **snapshot**, not a live lookup:
taken once via the Lineage MCP's `list_companies` tool, not refreshed
automatically.

**When to refresh it:** a client's Post Performance data is missing even
though their post is published and synced in Lineage. That almost always
means the client's slug isn't in the table yet (new client) or has
changed (renamed in Lineage).

**How to refresh it:** ask whoever has the Lineage MCP connection to run
`list_companies` again, and update the JSON file with any new or changed
`slug`/`id` pairs. There's no build step — it's loaded straight from disk,
so a normal deploy is enough.

## Setup requirements

Two Netlify environment variables on this site, neither committed to the
repo:

| Variable | Value |
| --- | --- |
| `LINEAGE_API_KEY` | A `jq_live_...` key, minted by an **internal** Virio user under Settings → API keys in the Lineage app. Must be an internal user's key — `requireCompanyAccess` on Lineage's side only grants cross-company reads to internal users, and this dashboard needs to read every client's data with one key. |
| `LINEAGE_POST_ANALYTICS_URL` | Not required. Defaults to the real endpoint (`{LINEAGE_API_BASE}/analytics/{postId}`). Only set this to point at a different Lineage environment (e.g. staging). |
| `VIRIO_API_BASE` | Not required. Defaults to `https://api.virio.ai`, the virio-api deploy that serves the ICP reports. The same `LINEAGE_API_KEY` authenticates there — both backends resolve `jq_live_...` keys against the shared `user_api_keys` table. |

Without `LINEAGE_API_KEY` set, the Post Performance tab says plainly that
it isn't connected — it never shows a silently empty table.

## Known limitations

- **ICP rate is partial by construction.** See "ICP rate" below: it comes
  from a generated report keyed by publish date, so it is blank for posts
  published on a day another post also went out, for clients with no
  report, and for posts that were never scheduled.
- **"Worked by" only covers lifecycle actions.** See "Who worked the post"
  below — editing a draft is not recorded in the feed we can read.
- **The company table goes stale.** It's a hand-maintained snapshot (see
  above), not a live sync.
- **The snapshot is very likely production, not staging — checked, not
  assumed.** `lineage-mcp/.env.example` (the config template for the
  server backing the Lineage MCP tool used to take this snapshot) points
  `SUPABASE_URL` at `ylplirptcybuzxnecsgp.supabase.co`. Per
  `jacquard/infra/staging-clone/README.md`, that project is explicitly
  labeled `Jacquard - PROD`; the separate staging project
  (`kopxdsvcyhxzhirkqlxg.supabase.co`, `Jacquard - STAGING`) is what local
  dev in `lineage`/`virio-api` uses instead. This is a config template, not
  a live-inspected value, so it's strong evidence rather than a
  certainty — and even in the unlikely case the deployed MCP is pointed at
  staging instead, that project is refreshed weekly from a full prod clone
  (same doc), so company ids would still match prod for anything not
  created in the last week. If Post Performance data is wrong or missing
  across the board rather than for one client, that weekly-lag window is
  the first thing to rule out.

## Who worked the post

Lineage post records carry no author. `list_posts` and `get_post` return the
*profile* — the client who publishes — so nothing on the post itself says who
on our side did the work.

The only per-post record of that is the post's lifecycle feed:

```
GET {LINEAGE_API_BASE}/drafts/{postId}/events?limit=50
Authorization: Bearer {LINEAGE_API_KEY}
```

It returns `{ events: [{ id, type, at, actor: { id, first_name, last_name,
email }, payload }], actors, next_before, next_before_id }` — one entry per
state change, with the actor resolved to a real person. The function ranks
the `@virio.ai` actors by how many events they account for and shows the
busiest one, with a `+N` chip for the rest.

Three things it does not cover, each a legitimate blank:

- **Edits don't appear.** `draft.updated` is deliberately excluded from the
  feed's allowlist on Lineage's side, so "worked by" means moved to review,
  approved, scheduled, published — not typed. (In production `draft.updated`
  is by far the richest signal, but it adds real coverage for only about five
  more posts a quarter, so nothing much is lost.)
- **Teammates on a non-`@virio.ai` login are missed.** The feed carries no
  `is_internal` flag, so the email domain is the only signal available.
- **Self-managed clients run their own posts**, and correctly name nobody.

Measured against production: of published posts in the 44 clients this
dashboard covers, about 76% get at least one Virio actor this way.

The alternatives were checked and are worse. `drafts.requested_by` — the
obvious column — is populated on 16 of 1,225 published posts. The activity
JSONL the Lineage MCP's `vfs_read` returns for
`/conversations/trigger-log.jsonl` is not reachable with this key at all: it
is virio-api's `/api/internal/vfs/{companyId}/read`, gated by a shared
`x-vfs-secret` service credential that reads the whole workspace tree across
tenants, and the file is synthesised per read from `trigger_log` and
`company_events` rather than stored.

## ICP rate

ICP rate is not on either analytics surface. The Lineage Analytics tab reads
it out of a generated **ICP engagement report**, which lives on virio-api:

```
GET {VIRIO_API_BASE}/api/reports?companyId={uuid}&type=icp_internal&limit=100
GET {VIRIO_API_BASE}/api/reports/{reportId}
Authorization: Bearer {LINEAGE_API_KEY}
```

The detail call returns `report.result_json` with
`summary.icp_engagement_rate` (company-level, a 0–1 fraction) and
`post_analysis[]` of `{ posted_at, topic, total_engagement, icp_engagement,
icp_rate }`. The function takes the newest completed report **per FOC**,
merges their `post_analysis` into one `date → rate` map, and caches it for
15 minutes per company.

Two consequences worth understanding before trusting the column:

- **The report is keyed by date, not by post id.** The web app builds the
  same `date → rate` map. When two posts for one client went out the same
  day, which rate belongs to which post is unknowable, so both are left
  blank rather than both being given one post's number. That is about 19%
  of report entries once several FOCs are merged.
- **The date comes from the post's schedule.** Lineage's per-post analytics
  route returns no publish date, so the function takes the latest
  `to_scheduled_at` off the lifecycle feed. Checked against production, that
  matches the actual published date on 679 of 685 scheduled posts — but a
  post pushed out with "publish now" has no schedule event, so it gets no
  date and no ICP rate.

End to end that lands an ICP rate on about half of published posts (460 of the 956 published in the mapped clients over 90 days). The
follow-up that would fix most of it is one line in jacquard:
`AnalyticsService.getPostAnalytics` already selects
`lineage_posts(published_at)` and drops it before returning. Returning it
would remove the schedule-date proxy entirely and extend ICP coverage to
every measured post.

## Failure modes (all non-fatal to the page)

| Situation | What happens |
| --- | --- |
| `LINEAGE_API_KEY` not set | `configured: false`, tab shows "not connected" |
| Slug not in the company table | `company_id` omitted; falls back to guessed URLs, usually 404s |
| Post not yet published / not synced | 404 from Lineage; post shows "awaiting data" |
| Lifecycle feed unreachable | "Worked by" blank for every post, said so in `note` |
| No ICP report generated for a client | ICP column blank, said so in `note` |
| Any other Lineage error | Reported in `note`; queue stays fully usable without it |

Set `LINEAGE_DEBUG=1` to include the exact URLs attempted in the response,
useful when diagnosing a specific missing post.

## Related

- `README.md` — full dashboard setup and data-source overview.
- `netlify/functions/lineage-analytics.js` — the implementation described
  above.
