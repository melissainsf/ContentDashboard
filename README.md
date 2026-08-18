# Millie's Content Dashboard

A content request queue, capacity tracker and coverage view for the content
role. Deploys to Netlify from this repo.

Google sign-in, `@virio.ai` accounts only.

It exists to answer three questions that came out of the 2026-08-13
Melissa ↔ Millie sync:

1. **What should I work on next?** — every request from `#content-support`,
   ranked automatically.
2. **What is a reasonable amount of content per week?** — measured from
   what actually gets delivered, rather than guessed.
3. **Is every client getting some love?** — who is starved, who is
   monopolising the shared resource.

---

## How the queue is built

Requests come from the `#content-support` Slack channel. Nothing about the
team's workflow has to change — the dashboard reads the template Millie
already asked everyone to use:

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

Each open request gets a score out of ~100. Hovering the score shows every
component, so the order is always explainable to whoever is asking why
their request is not at the top.

| Signal | Points | Why |
| --- | --- | --- |
| Deadline | 4–40 | Overdue > today > this week > later |
| Account MRR | 4–25 | Banded, from HubSpot |
| Account health | 2–20 | Red and yellow outrank green |
| Rev share / launch | +6 / +4 | Our revenue moves with theirs |
| Nothing delivered in 30 days | +8 | Keeps quiet accounts from vanishing |
| Requester marked it high | +6 | A nudge, not a queue-jump |

Bands: **Do now** ≥ 60, **This week** ≥ 35, **Queue** below that.

This encodes the rule Melissa gave on the call: a $20k account sitting in
yellow outranks a $6k account in green, but a deadline today still beats
account size.

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

## Setup

### Slack app

The channel is private, so a Slack app must be created and invited.

1. Create an app at <https://api.slack.com/apps> in the Virio workspace.
2. Bot token scopes: `groups:history` (private channels — the one that
   matters), `channels:history`, `users:read`.
3. Install to the workspace and copy the `xoxb-…` bot token.
4. In Slack: `/invite @<your-app>` inside `#content-support`.

### Netlify environment variables

| Variable | Required | What happens without it |
| --- | --- | --- |
| `HUBSPOT_TOKEN` | **yes** | No accounts load — the page fails loud |
| `SLACK_BOT_TOKEN` | **yes** | No live requests; manual entry still works |
| `CS_DASHBOARD_URL` | strongly recommended | Account health is not counted in ranking |
| `SLACK_CONTENT_CHANNEL_ID` | no | Defaults to `C0BFY7Y3MK7` (`#content-support`) |
| `SLACK_CONTENT_OWNER_IDS` | no | Defaults to `U0A2VGT6NRL` (Millie) |
| `SLACK_CONTENT_DAYS` | no | Defaults to `120` |
| `SLACK_WORKSPACE` | no | Defaults to `virio-workspace` |

`HUBSPOT_TOKEN` is the same token the CS dashboard uses. It needs company
read, plus deal + deal-schema read for the product tags.

`CS_DASHBOARD_URL` is the base URL of the CS dashboard site, e.g.
`https://viriodash.netlify.app` — no trailing slash.

Until `SLACK_BOT_TOKEN` is set the page loads and works, shows a banner
saying the feed is not connected, and requests can still be added by hand.
It never shows an empty queue as though there were no work.

### Why `CS_DASHBOARD_URL` matters

Account health (red / yellow / green / blue) is set by the AMs on the CS
dashboard and is one of the ranking signals — a wobbling account earns
content attention ahead of a comfortable one.

Netlify Blobs stores are **per-site**, so this site cannot see the CS
dashboard's health store. `CS_DASHBOARD_URL` makes this site proxy the CS
dashboard's read-only `/api/account-health` endpoint, keeping one source of
truth. Set it and health colours appear; leave it unset and the dashboard
says plainly, in a banner, that health is not being counted — it does not
silently rank every account as "unknown".

### Storage

This site's own state — ticks, client corrections, manually added
requests — lives in this site's Netlify Blobs store `content-requests`.
Nothing else is written anywhere.

---

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page |
| `content-dashboard.js` | Parsing, scoring and capacity maths — pure, no DOM |
| `content-dashboard.test.js` | 141 tests, fixtures taken from real channel messages |
| `netlify/functions/content-requests.js` | Reads Slack history + stored state |
| `netlify/functions/content-request-write.js` | Writes per-request state |
| `netlify/functions/hubspot.js` | Accounts, MRR, products (copied from the CS dashboard) |
| `netlify/functions/account-health.js` | Proxies health from the CS dashboard |
| `netlify/functions/pr-products.js` | Product tags from closed-won deals |

Run the tests with `npm test` (no dependencies).

---

## Known limits

- A prose request naming **two** clients with no links attaches to one of
  them; the other is visible in the text but not counted separately.
- Thread replies are treated as conversation, not as new requests.
- Post counts are conservative: an ask with no number counts as one piece.
- "Delivered" means marked done, so the volume charts are only as accurate
  as the ticking. Reactions cover the backfill.
- `hubspot.js` and `pr-products.js` are copies of the CS dashboard's
  versions. They are stateless HubSpot reads, so copying is safe, but a
  change to the HubSpot schema needs applying in both repos.
