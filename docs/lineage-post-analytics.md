# Post analytics via Lineage

How the Post Performance tab and the Completed widget get real
likes/comments/reposts numbers for each post, and how to keep that working
as clients are added.

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

Without `LINEAGE_API_KEY` set, the Post Performance tab says plainly that
it isn't connected — it never shows a silently empty table.

## Known limitations

- **ICP rate is always blank.** Lineage's per-post analytics endpoint
  doesn't return it — it only exists inside aggregate ICP reports, matched
  to a post by date rather than by post id, which isn't reliable enough to
  attribute to one specific post. This function reads a handful of
  plausible field names in case that ever changes, but renders `—` rather
  than a guessed number.
- **The company table goes stale.** It's a hand-maintained snapshot (see
  above), not a live sync.
- **Unconfirmed: which Lineage environment the snapshot came from.** The
  ids in `lineage-company-ids.json` were pulled via the Lineage MCP tool,
  which is assumed — not confirmed — to be pointed at production
  (`app.virio.ai`). If Post Performance data is wrong or missing across
  the board rather than for one client, confirm with whoever administers
  that MCP connection which environment it targets.

## Failure modes (all non-fatal to the page)

| Situation | What happens |
| --- | --- |
| `LINEAGE_API_KEY` not set | `configured: false`, tab shows "not connected" |
| Slug not in the company table | `company_id` omitted; falls back to guessed URLs, usually 404s |
| Post not yet published / not synced | 404 from Lineage; post shows "awaiting data" |
| Any other Lineage error | Reported in `note`; queue stays fully usable without it |

Set `LINEAGE_DEBUG=1` to include the exact URLs attempted in the response,
useful when diagnosing a specific missing post.

## Related

- `README.md` — full dashboard setup and data-source overview.
- `netlify/functions/lineage-analytics.js` — the implementation described
  above.
