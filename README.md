# Millie's Content Dashboard

A content request queue, capacity tracker, coverage view and performance
report for the content role. Deploys to Netlify from this repo.

Access is gated by **Netlify project visibility** (Project configuration →
Visitor access), enforced at the edge. There is no app-level login: if the
page loads, the visitor is already authenticated, and the `/api/*`
functions are behind the same gate.

It exists to answer four questions that came out of the 2026-08-13
Melissa ↔ Millie sync:

1. **What should I work on next?** — every request from `#content-support`,
   ranked automatically.
2. **What is a reasonable amount of content per week?** — measured from
   what actually gets delivered, rather than guessed.
3. **Is every client getting some love?** — who is starved, who is
   monopolising the shared resource.
4. **Is the content any good?** — LinkedIn engagement on the posts that
   came out of this queue.

---

## Data sources

Three, and only three. This dashboard does not depend on any other Virio
dashboard.

| Source | What it provides |
| --- | --- |
| **HubSpot** | The client book — MRR, Account Manager, Content Engineer, Content Health Score, CSM Sentiment, contracted posts/month, products |
| **Slack `#content-support`** | The requests themselves — "Millie will you write an ABM post for my customer X" |
| **Lineage** | The drafts Millie writes herself, plus reactions, comments, reposts and ICP rate on the posts that come out of this queue |

---

## How the queue is built

Requests come from `#content-support`. Nothing about the team's workflow
has to change — the dashboard reads the template Millie already asked
everyone to use:

```
:bust_in_silhouette: Client:
:link: Link:
:date: Due Date:
:red_circle: Priority:
:memo: Additional Notes:
```

Free-form asks work too. The client is recovered from, in order:

1. an explicit `Client:` field,
2. the slug in a Lineage link (`app.virio.ai/lineage/**netlify**/…`),
3. a client name mentioned in the prose, but only when the message also
   reads as an ask.

One message can produce several requests — a weekly "here's what I need"
message naming two clients becomes two rows, each with only its own brief,
link and deadline.

Ignored: channel joins, `@here` announcements, and Millie's own messages
(she does the work, she is not the requester).

### Status comes from the reactions already in use

| Reaction | Status |
| --- | --- |
| 🟢 `large_green_circle` | Done |
| 🟠 `large_orange_circle` | In progress |
| ✅ `white_check_mark` | Accepted |
| ❌ `x` | Needs a brief |
| _(none)_ | New |

Ticking the box in the dashboard overrides whatever Slack says, and that
override is what the volume charts count. Clearing it hands control back
to the reactions.

---

## How ranking works

Each open request gets a score. Hovering it shows every component, so the
order is always explainable to whoever is asking why their request is not
at the top.

| Signal | Points | Source |
| --- | --- | --- |
| Deadline | 4–55 | Parsed from the request |
| Account MRR | 4–25 | HubSpot `mrr` + `expansion_mrr` |
| Content health | 2–20 | HubSpot `content_health_score` |
| Churn risk | 0–12 | HubSpot `csm_sentiment` |
| Rev share / launch | +6 / +4 | HubSpot `product` |
| Nothing delivered in 30 days | +8 | This queue's own history |
| Requester marked it high | +6 | The Slack message |

Bands: **Do now** ≥ 75, **This week** ≥ 45, **Queue** below that.

**Deadlines outweigh everything else on purpose.** A missed date is a hard
failure the requester sees; a big account drifting is a soft concern. The
deadline weights sit above the combined account signals so an item due
today can never be buried by account attributes alone.

Content Health Score is HubSpot's own *"Are we on track with their content?
The goal is to be 30 days ahead"* — the most direct signal there is that an
account needs Millie. CSM Sentiment is stored inconsistently in HubSpot
(phrases for 1–5, bare numerals for 6–10); both are handled.

All weights live in `DEFAULT_CONFIG` at the top of `content-dashboard.js`.
Change them there; nothing downstream hard-codes a number.

---

## The 3-day rule

Millie's one ask was *"at least give me three days"*. Lead time is measured
in **working days**, so a Friday ask due Monday counts as one day of
notice, not three. Anything under three days is flagged `Rush`, and the
Capacity tab shows the rush rate broken down by requester — that is the
evidence for the conversation, rather than a feeling.

Requests with **no** due date are counted separately: an undated request
can't be scheduled, only interrupted.

---

## Post performance

A request pasted into Slack carries its Lineage post URL, and the uuid in
that URL is the id Lineage keys analytics on. So the dashboard can report
how the post Millie wrote actually did, without anyone linking anything by
hand — and only for *her* posts, not the client's whole feed.

Four metrics, matching the Lineage Analytics tab: **reactions, comments,
reposts, ICP rate.**

It shows up in two places:

- **Completed** — a widget at the bottom of the Queue, grouped by customer
  and ordered by how recent the work is. It leads with volume: everything
  finished, this calendar month, this week, and an average per week.

  Weeks are **Monday-start** and the average **excludes the partial current
  week**, both matching `weekKey` and the Capacity tab, so the two views
  cannot drift apart. With no closed week yet the average reads `—`, never
  `0`, which would say she delivers nothing. The tiles count **items** —
  the same unit as the rows underneath — rather than summing multi-post
  asks; pieces-of-content volume lives on the Capacity tab, and a tile
  that disagreed with the list below it would send a reader hunting for
  work that was never missing. This is "what did I finish, and
  how did it land". Recency uses the post's publish time where there is
  one, because that is when the work actually reached an audience.
- **Post Performance** — its own tab: every measured post ranked by
  engagement, plus engagement by client. This is "what is working".

Completed work with no LinkedIn data still appears in both — it is work
Millie did, and hiding it would make the record read as though less was
delivered than actually was. It is marked *awaiting data*, never zero.

### Work Millie starts herself

The queue only ever knew about work somebody asked for. Millie in
`#content-support` on 2026-07-15: *"please drop some requests in!
Otherwise I will be spending time looking at everyones accounts."*
Everything in that second category was invisible here, so the Completed
bucket read as though she had delivered less than she had.

Lineage post records carry **no author** — the only person on a post is
the client who publishes it. But Lineage's per-company **activity log**
stamps an actor id on every draft event, which is real per-post
attribution. `netlify/functions/lineage-drafts.js` reads that log and
returns the drafts created by one author; each becomes a completed row
tagged `Lineage`, because for Millie the draft *is* the deliverable —
the AM and the client take it from there.

A post that was both asked for in Slack **and** written in Lineage is
one piece of work: the Slack request wins and the Lineage event is
dropped, so the week's volume is not inflated by counting it twice.

The row ids are stable (`lineage:<post-uuid>`), so ticking one back to
another status in the dashboard sticks across refreshes exactly as it
does for a Slack request.

**Every `draft.*` event counts by default, deduped to one row per
draft.** Counting only `draft.created` would be badly wrong. Measured
across all 46 accounts over 2026-07-08 → 09-02, Millie **created 1
draft and worked 45**: she rarely starts a post from scratch any more,
she takes one the ghostwriter or an AM made and moves it through review
and scheduling. Her recent events break down as 50
`draft.status_changed`, 30 `draft.scheduled`, 12
`rescheduled`/`unscheduled`, 3 `draft.updated`, 1 `draft.created`.
Set `LINEAGE_ACTIVITY_EVENTS` to narrow it only if you specifically
want authorship rather than work done.

Her footprint is concentrated on accounts that rarely appear in
`#content-support` — Percents, Watt Data, Sybill, Fergana Labs,
InnovoCommerce, Concord Visa — which is exactly the work the Slack
queue could never see.

**The window starts 1 August 2026** — a fixed floor, set by
`LINEAGE_ACTIVITY_SINCE`, not a rolling window, so the early weeks do not
quietly drop out of the total as time passes. It is stated on the
Completed card itself. `LINEAGE_ACTIVITY_DAYS` is used only if
`LINEAGE_ACTIVITY_SINCE` is set to empty. This floor applies to the
Lineage feed only; Slack-sourced requests keep their full history.

**A scheduled job refreshes the snapshot every morning.** It reads each
company's activity log through the Lineage MCP workspace, writes them to
a directory as `<company-slug>.jsonl`, and runs

```
node tools/build-lineage-snapshot.js <logsDir> 2026-08-01
```

which applies exactly the rule `lineage-drafts.js` applies to live data —
the author's `draft.*` events, one entry per draft, dated by her most
recent touch — so the snapshot and the live feed can never disagree about
what a draft is. The script is a no-op when the result is unchanged, so a
quiet day produces no commit and no deploy. A push to `main` redeploys
the site automatically.

The job does **not** refresh Slack or HubSpot: both are already read live
on every page load and need nothing scheduled.

**Until the endpoint is live, a snapshot ships with the page.**
`netlify/functions/_lineage-snapshot.js` holds the 20 drafts Millie
worked from 1 August, read from Lineage's activity logs on 2026-09-02.
The function serves it **only** when the live endpoint cannot be reached,
always marks the response `source: "snapshot"` with the capture date, and
the dashboard says so on screen. It exists because an empty list here
silently reports the Slack queue alone and reads as though she had done a
fraction of her actual work. Point `LINEAGE_ACTIVITY_URL` at the real
path and live data wins; delete the file then.

**The count is a floor, not a total.** A busy account's activity log is
capped at roughly 2,000 events and keeps the *oldest*, so recent work on
the busiest accounts falls outside it. Netlify's log stops at
2026-07-01, Axya's at 07-03, Trimble's at 07-12 — a forced VFS refresh
does not extend them. Any account whose window ends before today is
under-reported here, and there is no way around it from this API.

The August floor makes this bite harder, not softer: **ten of the
twenty-one readable accounts have logs that stop before 1 August**,
including Sybill and Watt Data, her two busiest accounts in July. They
contribute nothing to the August count even though the work is real. A
paginated or date-filtered activity endpoint is the only fix, and it is
worth asking Lineage engineering for alongside the two URLs.

### What is not shown, and why

**Impressions.** Lineage does not expose impressions or views for LinkedIn
posts, so there is no denominator for an engagement *rate* either.
Reactions, comments and reposts are real numbers; anything claiming reach
would be invented.

**ICP rate is always blank, on purpose.** Lineage's per-post analytics
endpoint (`/api/analytics/{postId}`) does not return an ICP rate — that
number only exists inside aggregate ICP reports, matched to a post by date
rather than by post id, which is not reliable enough to show per post. The
function reads it from any of the plausible field names anyway, in case
Lineage ever adds it to that endpoint, and leaves it `null` when absent,
rendering as `—` rather than a made-up percentage.

Engagement counts sync periodically from LinkedIn and are typically hours
stale — both views show the sync time.

---

## Setup

### Slack app

The channel is private, so a Slack app must be created and invited.

1. Create an app at <https://api.slack.com/apps> in the Virio workspace.
2. Bot token scopes: `groups:history` (private channels — the one that
   matters), `channels:history`, `users:read`.
3. Install to the workspace and copy the `xoxb-…` bot token.
4. In Slack: `/invite @<your-app>` inside `#content-support`.

### Netlify environment variables

| Variable | Required | Without it |
| --- | --- | --- |
| `HUBSPOT_TOKEN` | **yes** | No accounts load — the page fails loud |
| `SLACK_BOT_TOKEN` | **yes** | No live requests; manual entry still works |
| `LINEAGE_API_KEY` | for performance | Post Performance tab says it is not connected |
| `LINEAGE_POST_ANALYTICS_URL` | no | Defaults to the real endpoint, see below |
| `LINEAGE_ACTIVITY_URL` | for self-started drafts | Falls back to guessing the path; Completed shows a banner |
| `LINEAGE_AUTHOR_ID` | no | Defaults to Millie Hanson's Lineage user id |
| `LINEAGE_ACTIVITY_EVENTS` | no | Defaults to `draft.created` |
| `LINEAGE_ACTIVITY_DAYS` | no | Defaults to `120` |
| `SLACK_CONTENT_CHANNEL_ID` | no | Defaults to `C0BFY7Y3MK7` (`#content-support`) |
| `SLACK_CONTENT_OWNER_IDS` | no | Defaults to `U0A2VGT6NRL` (Millie) |
| `SLACK_CONTENT_DAYS` | no | Defaults to `120` |
| `SLACK_WORKSPACE` | no | Defaults to `virio-workspace` |
| `LINEAGE_DEBUG=1` | no | Adds the attempted URLs to the response |

`HUBSPOT_TOKEN` needs `crm.objects.companies.read`.

**`LINEAGE_POST_ANALYTICS_URL`** defaults to Lineage's real per-post
analytics endpoint, `{LINEAGE_API_BASE}/analytics/{postId}` — confirmed
against Lineage's own `analytics-service.ts`. Set this env var only to
override that default (for example against a staging Lineage instance);
older guessed shapes stay as a fallback if the real path ever moves.

That endpoint scopes every lookup to a company id (uuid), but a request
here only carries the company slug parsed from the pasted Lineage link.
`lineage-analytics.js` maps slug → uuid via `lineage-company-ids.json` (a
snapshot taken through the Lineage MCP's `list_companies` tool), and sends
the resolved id as `?company_id=`. **This table goes stale** as clients
are added or renamed in Lineage — if a client's Post Performance data is
missing despite the post being published, re-run `list_companies` and
refresh the table.

See `docs/lineage-post-analytics.md` for the full request flow, why the
URL alone isn't enough, and the evidence behind treating this snapshot as
production data.

`{company}` and `{postId}` are substituted per post.

Until `SLACK_BOT_TOKEN` is set the page loads and works, shows a banner
saying the feed is not connected, and requests can still be added by hand.
It never shows an empty queue as though there were no work.

### Access

Set **Project configuration → Visitor access** to `Private` (team members
sign in with their Netlify login) or `Password`. Apply it to **production
and previews** — leaving previews open defeats the point.

This matters more than it looks: the `/api/*` functions return client
names, MRR and churn risk, and they do **not** authenticate callers
themselves. Netlify's gate is the only thing in front of them. If the
project is ever set to `Public`, that data is public with it.

Anyone who needs the dashboard — Millie, AMs — must be a member of the
Netlify team under `Private`. If per-seat cost is a problem, either switch
to `Password` or install an OAuth provider under Access & security → OAuth.

### Storage

Dashboard state — ticks, client corrections, manually added requests —
lives in this site's Netlify Blobs store `content-requests`. Nothing is
written anywhere else; HubSpot, Slack and Lineage are read-only.

---

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page |
| `content-dashboard.js` | Parsing, scoring, capacity and performance maths — pure, no DOM |
| `content-dashboard.test.js` | 242 tests, fixtures taken from real channel messages, real Lineage activity-log lines and real Lineage numbers |
| `netlify/functions/accounts.js` | The client book from HubSpot |
| `netlify/functions/content-requests.js` | Reads Slack history + stored state |
| `netlify/functions/content-request-write.js` | Writes per-request state |
| `netlify/functions/lineage-analytics.js` | Reactions, comments, reposts, ICP rate per post |
| `netlify/functions/lineage-drafts.js` | The drafts Millie wrote in Lineage, from its activity log |

Run the tests with `npm test` (no dependencies).

---

## Known limits

- **The Lineage activity REST path is unconfirmed**, the same way the
  analytics one is. The log's format is known and parsed against real
  lines from it, and a payload that is not an activity log is rejected
  rather than reported as "no drafts" — but the function has to guess
  the path until `LINEAGE_ACTIVITY_URL` is set.
- The Lineage analytics REST path is unconfirmed, and the surface used
  at build time did not return ICP rate — see `LINEAGE_POST_ANALYTICS_URL`
  above. Everything for ICP rate is wired and tested; it needs the right
  endpoint.
- A prose request naming **two** clients with no links attaches to one of
  them; the other is visible in the text but not counted separately.
- Thread replies are treated as conversation, not as new requests.
- Post counts are conservative: an ask with no number counts as one piece.
- "Delivered" means marked done, so the volume charts are only as accurate
  as the ticking. Reactions cover the backfill.
- **Millie 30d** on the coverage tab counts only requests through this
  queue. It is not the account's full content cadence — most of that is
  delivered by their own Content Engineer. `Contracted /mo` is shown
  beside it as context, not as a target for this queue.
