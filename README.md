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
| **Lineage** | Reactions, comments, reposts and ICP rate on the posts Millie writes |

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
  and ordered by how recent the work is. This is "what did I finish, and
  how did it land". Recency uses the post's publish time where there is
  one, because that is when the work actually reached an audience.
- **Post Performance** — its own tab: every measured post ranked by
  engagement, plus engagement by client. This is "what is working".

Completed work with no LinkedIn data still appears in both — it is work
Millie did, and hiding it would make the record read as though less was
delivered than actually was. It is marked *awaiting data*, never zero.

### What is not shown, and why

**Impressions.** Lineage does not expose impressions or views for LinkedIn
posts, so there is no denominator for an engagement *rate* either.
Reactions, comments and reposts are real numbers; anything claiming reach
would be invented.

**ICP rate may be blank.** The column and the roll-ups are built and
tested, but the per-post Lineage API surface reachable at build time did
not return an ICP rate — it appears on the Lineage Analytics tab in the
web app. The function reads it from any of the plausible field names and
leaves it `null` when absent, rendering as `—` rather than a made-up
percentage. Point `LINEAGE_POST_ANALYTICS_URL` at the endpoint behind that
Analytics tab and the column fills in. The response says plainly when ICP
rate is not coming through, so a column of dashes never reads as broken.

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
| `LINEAGE_POST_ANALYTICS_URL` | see below | Falls back to guessing the path |
| `SLACK_CONTENT_CHANNEL_ID` | no | Defaults to `C0BFY7Y3MK7` (`#content-support`) |
| `SLACK_CONTENT_OWNER_IDS` | no | Defaults to `U0A2VGT6NRL` (Millie) |
| `SLACK_CONTENT_DAYS` | no | Defaults to `120` |
| `SLACK_WORKSPACE` | no | Defaults to `virio-workspace` |
| `LINEAGE_DEBUG=1` | no | Adds the attempted URLs to the response |

`HUBSPOT_TOKEN` needs `crm.objects.companies.read`.

**`LINEAGE_POST_ANALYTICS_URL` needs confirming with whoever owns the
Lineage API.** The per-post analytics data shape is known and handled, but
the exact REST path was never confirmed, so the function tries a few
plausible shapes and reports failure rather than pretending. Set it to the
real path as a template and the guessing stops:

```
https://app.virio.ai/api/lineage/{company}/posts/{postId}/analytics
```

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
| `content-dashboard.test.js` | 210 tests, fixtures taken from real channel messages and real Lineage numbers |
| `netlify/functions/accounts.js` | The client book from HubSpot |
| `netlify/functions/content-requests.js` | Reads Slack history + stored state |
| `netlify/functions/content-request-write.js` | Writes per-request state |
| `netlify/functions/lineage-analytics.js` | Reactions, comments, reposts, ICP rate per post |

Run the tests with `npm test` (no dependencies).

---

## Known limits

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
