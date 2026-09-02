/* ────────────────────────────────────────────────────────────────
   Millie's Content Dashboard — parsing + prioritisation engine
   ----------------------------------------------------------------
   Single source of truth for turning #content-support Slack messages
   into a prioritised content queue, and for the capacity maths that
   answers "how much is a reasonable amount of content per week?".

   Pure and config-driven, so it is testable without a browser or a
   Slack token. Used by content.html (window.ContentDash) and by the
   node test suite (module.exports).

   The parser is written against the template Millie posted in
   #content-support on 2026-07-08:

       :bust_in_silhouette: Client:
       :link: Link:
       :date: Due Date:
       :red_circle: Priority:
       :memo: Additional Notes:

   ...and degrades to free-form parsing, because roughly half of the
   real requests in that channel are prose ("Do you mind doing a
   reintroduction post for Timur? <lineage link>").
   ──────────────────────────────────────────────────────────────── */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // node
  root.ContentDash = api;                                                    // browser
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY = 86400000;

  // ── Configuration ─────────────────────────────────────────────
  // Every tunable lives here. Nothing below hard-codes a weight, so
  // Melissa and Millie can retune the queue without touching logic.
  const DEFAULT_CONFIG = {
    // Millie's stated floor, from the 2026-08-13 sync: "the one request
    // I do have from everyone is at least give me three days."
    leadTimeDays: 3,

    // Priority points. Deliberately additive and small so every number
    // on screen can be explained in one line to whoever is asking why
    // their request is not at the top.
    // Deadlines outweigh everything else on purpose. A missed date is a
    // hard failure the requester sees; a big account drifting is a soft
    // concern. These sit above the combined account signals so an item
    // due today can never be buried by account attributes alone.
    duePoints: [
      { maxDays: -1,       points: 55, label: 'Overdue' },
      { maxDays: 0,        points: 48, label: 'Due today' },
      { maxDays: 2,        points: 38, label: 'Due in 2 days' },
      { maxDays: 5,        points: 24, label: 'Due this week' },
      { maxDays: 10,       points: 12, label: 'Due next week' },
      { maxDays: Infinity, points: 4,  label: 'Not due yet' }
    ],
    noDuePoints: 8,          // undated asks should not sink out of sight forever

    // MRR bands. From the sync: "this one has much higher MRR and also
    // in yellow — prioritise theirs over one that is 6k MRR and green."
    mrrBands: [
      { minMrr: 15000, points: 25 },
      { minMrr: 10000, points: 20 },
      { minMrr: 6000,  points: 14 },
      { minMrr: 3000,  points: 8 }
    ],
    mrrFloorPoints: 4,

    // Content Health Score (HubSpot, 1-10): "Are we on track with their
    // content? The goal is to be 30 days ahead." Low means behind, which
    // is the most direct signal there is that an account needs Millie.
    contentHealthPoints: [
      { max: 3,  points: 20, label: 'Badly behind on content' },
      { max: 5,  points: 14, label: 'Behind on content' },
      { max: 7,  points: 6,  label: 'Content roughly on track' },
      { max: 10, points: 2,  label: 'Content well ahead' }
    ],
    contentHealthUnknownPoints: 6,

    // CSM Sentiment (HubSpot, 1-10), where 1 is "very high likelihood of
    // churn". A wobbling account earns content attention ahead of a
    // comfortable one.
    churnRiskPoints: [
      { max: 2,  points: 12, label: 'High churn risk' },
      { max: 3,  points: 8,  label: 'Churn risk 50/50' },
      { max: 5,  points: 2,  label: 'Low churn risk' },
      { max: 10, points: 0,  label: 'Churn risk minimal' }
    ],
    churnRiskUnknownPoints: 5,

    // Revenue upside — rev share means our money moves with their results.
    revSharePoints: 6,
    launchPoints: 4,

    // "I want to make sure that every client is getting some of this
    // love" — an account with nothing delivered recently gets a nudge.
    starvedDays: 30,
    starvedPoints: 8,

    // What the requester marked. Trusted, but capped: it is a nudge,
    // not a queue-jump, otherwise everything becomes HIGH HIGH HIGH.
    requesterPriorityPoints: { high: 6, medium: 2, low: 0 },

    // Band cutoffs for the queue grouping.
    nowMin: 75,
    weekMin: 45,

    // Accounts above this share of delivered content are flagged as
    // monopolising Millie (she is a shared resource across the book).
    // The minimum guards against a quiet fortnight flagging whoever
    // happened to get the only two posts.
    monopolyShare: 0.30,
    monopolyMinTotal: 8
  };

  // Slack reaction → status. This mirrors the convention Millie set up
  // in the channel rather than inventing a new one: "anything that
  // hasn't been given a thorough brief I will reply with a ❌ and ones
  // that I am working on will get a ✅". The green/orange circles are
  // the team's own done / in-flight markers.
  const REACTION_STATUS = [
    ['large_green_circle',  'done'],
    ['heavy_check_mark',    'done'],
    ['large_orange_circle', 'in_progress'],
    ['x',                   'blocked'],
    ['white_check_mark',    'accepted']
  ];

  const STATUS_LABEL = {
    done:        'Done',
    in_progress: 'In progress',
    accepted:    'Accepted',
    blocked:     'Needs a brief',
    new:         'New'
  };

  const OPEN_STATUSES = ['new', 'accepted', 'in_progress', 'blocked'];

  // ── Slack text helpers ────────────────────────────────────────

  // Slack wraps links as <url|display> or <url>. Keep the url, drop the
  // display half — the display half is truncated and useless for parsing.
  function unwrapLinks(text) {
    return String(text || '').replace(/<(https?:\/\/[^>|]+)(?:\|[^>]*)?>/g, '$1');
  }

  // <@U0A2VGT6NRL|Millie> → @Millie ; <!here> → @here
  function unwrapMentions(text) {
    return String(text || '')
      .replace(/<@[A-Z0-9]+\|([^>]+)>/g, '@$1')
      .replace(/<@([A-Z0-9]+)>/g, '@$1')
      .replace(/<!(here|channel|everyone)>/g, '@$1');
  }

  function stripEmoji(text) {
    return String(text || '').replace(/:[a-z0-9_+-]+:/g, ' ');
  }

  function cleanText(text) {
    return unwrapMentions(unwrapLinks(text)).replace(/[ \t]+/g, ' ').trim();
  }

  function extractUrls(text) {
    const out = [];
    const re = /<(https?:\/\/[^>|]+)(?:\|[^>]*)?>|(https?:\/\/[^\s<>|]+)/g;
    let m;
    while ((m = re.exec(String(text || '')))) out.push((m[1] || m[2]).replace(/[.,)]+$/, ''));
    return out;
  }

  // Lineage post URLs carry the client slug: app.virio.ai/lineage/<slug>/<postId>.
  // This is the single most reliable client signal in free-form requests.
  function lineageSlugs(text) {
    const out = [];
    extractUrls(text).forEach(u => {
      const m = u.match(/\/lineage\/([a-z0-9][a-z0-9-]*)/i);
      if (m && out.indexOf(m[1].toLowerCase()) === -1) out.push(m[1].toLowerCase());
    });
    return out;
  }

  // A Lineage post URL is /lineage/<company-slug>/<post-uuid>. The uuid is
  // the same id Lineage's analytics are keyed on, so a request pasted into
  // Slack carries everything needed to look up how the post performed.
  const UUID_RE = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
  function lineagePostRefs(text) {
    const out = [];
    const seen = {};
    extractUrls(text).forEach(u => {
      const m = u.match(new RegExp('/lineage/([a-z0-9][a-z0-9-]*)/(' + UUID_RE + ')', 'i'));
      if (!m) return;
      const postId = m[2].toLowerCase();
      if (seen[postId]) return;
      seen[postId] = true;
      out.push({ company: m[1].toLowerCase(), postId: postId });
    });
    return out;
  }

  function slugToName(slug) {
    return String(slug || '')
      .split('-')
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  // ── Template field parsing ────────────────────────────────────

  // Matches "Client: X", ":bust_in_silhouette: Client: X", "client: X",
  // and the bulleted "• Notes: x" variants seen in the channel.
  const FIELD_ALIASES = {
    client: 'client',
    account: 'client',
    link: 'link',
    links: 'link',
    'due date': 'due',
    due: 'due',
    deadline: 'due',
    'needed by': 'due',
    priority: 'priority',
    'additional notes': 'notes',
    notes: 'notes',
    note: 'notes',
    context: 'notes'
  };

  function fieldOf(line) {
    const bare = stripEmoji(line).replace(/^[\s•\-*]+/, '');
    const m = bare.match(/^([A-Za-z][A-Za-z ]{1,18}?)\s*:\s*([\s\S]*)$/);
    if (!m) return null;
    const key = FIELD_ALIASES[m[1].trim().toLowerCase()];
    return key ? { key, value: m[2].trim() } : null;
  }

  // Pull the template fields out of a block. Values continue onto
  // following lines until the next recognised field (the Notes field in
  // real messages is regularly a multi-line bullet list).
  function parseFields(text) {
    const fields = {};
    let current = null;
    String(text || '').split('\n').forEach(line => {
      const f = fieldOf(line);
      if (f) {
        current = f.key;
        fields[current] = fields[current] ? fields[current] + '\n' + f.value : f.value;
      } else if (current && line.trim()) {
        fields[current] += '\n' + line.trim();
      }
    });
    Object.keys(fields).forEach(k => { fields[k] = fields[k].trim(); });
    return fields;
  }

  // ── Due date parsing ──────────────────────────────────────────

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function daysBetween(from, to) {
    return Math.round((startOfDay(to) - startOfDay(from)) / DAY);
  }

  // Choose the year that puts `date` on or after the request, so a
  // request made on Dec 28 asking for "Jan 3" lands next year rather
  // than ten months in the past. A few days of slack absorbs the case
  // where someone dates a request for "yesterday".
  function inferYear(month, day, from) {
    const base = startOfDay(from);
    let d = new Date(base.getFullYear(), month, day);
    if (daysBetween(base, d) < -5) d = new Date(base.getFullYear() + 1, month, day);
    return d;
  }

  // Returns { at: Date|null, asap: boolean, raw: string }.
  // `requestedAt` anchors every relative expression ("Tuesday", "EOD").
  function parseDueDate(text, requestedAt) {
    const raw = String(text || '');
    const s = stripEmoji(unwrapLinks(raw)).toLowerCase();
    const from = requestedAt ? new Date(requestedAt) : new Date();
    if (!s.trim()) return { at: null, asap: false, raw: raw.trim() };

    // Explicit urgency words all mean "the day it was asked for".
    if (/\b(asap|eod|today|end of day|right away|urgent)\b/.test(s)) {
      return { at: startOfDay(from), asap: true, raw: raw.trim() };
    }
    if (/\btomorrow\b/.test(s)) {
      return { at: new Date(startOfDay(from).getTime() + DAY), asap: false, raw: raw.trim() };
    }

    // ISO: 2026-08-22
    let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return { at: startOfDay(new Date(+m[1], +m[2] - 1, +m[3])), asap: false, raw: raw.trim() };

    // "July 15th", "Jul 14", "aug 3"
    m = s.match(new RegExp('\\b(' + MONTHS.join('|') + ')[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b'));
    if (m) return { at: inferYear(MONTHS.indexOf(m[1]), +m[2], from), asap: false, raw: raw.trim() };

    // "15th July", "3 Aug"
    m = s.match(new RegExp('\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(' + MONTHS.join('|') + ')[a-z]*\\b'));
    if (m) return { at: inferYear(MONTHS.indexOf(m[2]), +m[1], from), asap: false, raw: raw.trim() };

    // "8/22" — US order, matching how the team writes dates elsewhere.
    m = s.match(/\b(\d{1,2})\/(\d{1,2})\b/);
    if (m) return { at: inferYear(+m[1] - 1, +m[2], from), asap: false, raw: raw.trim() };

    // Bare "(18th)" — the parenthesised day in "this Tuesday (18th) morning".
    // Checked before weekday names because it is the more specific signal.
    m = s.match(/\((\d{1,2})(?:st|nd|rd|th)\)/);
    if (m) {
      const base = startOfDay(from);
      return { at: inferYear(base.getMonth(), +m[1], from), asap: false, raw: raw.trim() };
    }

    // "by Tuesday", "this Tuesday", "next Monday" → the next such weekday.
    m = s.match(new RegExp('\\b(next\\s+)?(' + WEEKDAYS.join('|') + ')\\b'));
    if (m) {
      const base = startOfDay(from);
      const target = WEEKDAYS.indexOf(m[2]);
      let delta = (target - base.getDay() + 7) % 7;
      if (delta === 0) delta = 7;              // "Tuesday" said on a Tuesday means the next one
      if (m[1]) delta += (delta <= 6 && base.getDay() < target) ? 7 : 0;  // explicit "next"
      return { at: new Date(base.getTime() + delta * DAY), asap: false, raw: raw.trim() };
    }

    if (/\bnext week\b/.test(s)) {
      return { at: new Date(startOfDay(from).getTime() + 7 * DAY), asap: false, raw: raw.trim() };
    }
    if (/\bthis week\b/.test(s)) {
      const base = startOfDay(from);
      const toFriday = (5 - base.getDay() + 7) % 7;
      return { at: new Date(base.getTime() + (toFriday || 5) * DAY), asap: false, raw: raw.trim() };
    }

    return { at: null, asap: false, raw: raw.trim() };
  }

  // ── Priority + volume parsing ─────────────────────────────────

  function parsePriority(text) {
    const s = stripEmoji(String(text || '')).toLowerCase();
    if (!s.trim()) return null;
    if (/!{2,}/.test(text) || /\b(high|urgent|critical|asap|p0|p1)\b/.test(s)) return 'high';
    if (/\b(med|medium|normal|p2)\b/.test(s)) return 'medium';
    if (/\b(low|whenever|no rush|nice to have|p3)\b/.test(s)) return 'low';
    if (/!/.test(text)) return 'high';
    return null;
  }

  const NUMBER_WORDS = { a: 1, an: 1, one: 1, couple: 2, two: 2, few: 3, three: 3, four: 4, five: 5 };

  // How many pieces of content this request represents. Used for the
  // volume maths, so it errs low: unclear asks count as one.
  function parsePostCount(text) {
    const s = cleanText(stripEmoji(text)).toLowerCase();
    let m = s.match(/\b(\d{1,2})\s+(?:more\s+)?(?:posts?|pieces?|drafts?)\b/);
    if (m) {
      const n = +m[1];
      if (n >= 1 && n <= 20) return n;
    }
    m = s.match(/\b(a|an|one|couple|two|few|three|four|five)\s+(?:of\s+)?(?:more\s+)?(?:posts?|pieces?|drafts?)\b/);
    if (m) return NUMBER_WORDS[m[1]];
    // Bulleted lineage links in one ask — each link is a piece of content.
    const slugCount = extractUrls(text).filter(u => /\/lineage\/[^/]+\/[0-9a-f-]{8,}/i.test(u)).length;
    return slugCount > 1 ? slugCount : 1;
  }

  // Content type. ABM is called out separately because it is the work
  // Millie moved onto full-time — the split is the point of the chart.
  function classifyType(text) {
    const s = cleanText(stripEmoji(text)).toLowerCase();
    if (/\babm\b|account[- ]based/.test(s)) return 'ABM';
    if (/\blaunch|embargo|announcement|funding|series [a-d]\b/.test(s)) return 'Launch';
    if (/\bprofile|headline|banner|optimi[sz]ing (?:the )?profile/.test(s)) return 'Profile';
    if (/\bstrateg|ideation|content plan|revamp/.test(s)) return 'Strategy';
    if (/\bhiring|recruit|culture|values\b/.test(s)) return 'Hiring';
    if (/\brework|optimi[sz]|edit|improve|amend|feedback/.test(s)) return 'Rework';
    return 'Post';
  }

  // ── Status ────────────────────────────────────────────────────

  function statusFromReactions(reactions) {
    const names = (reactions || []).map(r => (typeof r === 'string' ? r : r && r.name) || '').map(n => n.toLowerCase());
    for (const [reaction, status] of REACTION_STATUS) {
      if (names.indexOf(reaction) !== -1) return status;
    }
    return 'new';
  }

  // ── Message → requests ────────────────────────────────────────

  // Chatter that is not a request: joins, Millie's own broadcasts, and
  // acknowledgements. Keeping these out matters — they would otherwise
  // inflate the volume counts the capacity decision rests on.
  function isNoise(msg, ownerIds) {
    const text = String(msg.text || '');
    if (!text.trim()) return true;
    if (msg.subtype && msg.subtype !== 'thread_broadcast') return true;   // joins, topic changes, ...
    if (/has joined the channel|has left the channel/.test(text)) return true;
    if (/<!(here|channel|everyone)>/.test(text)) return true;             // team announcements
    // The person doing the work is not the person requesting it.
    if ((ownerIds || []).indexOf(msg.user) !== -1) return true;
    return false;
  }

  // Phrases that make a message an ask rather than a remark. Used only
  // when the client had to be recovered from prose — a bare "thanks
  // Netlify team!" must not become a request just because it names an
  // account, but "can you take a look at Highwire?" must.
  const ASK_PATTERNS = /\b(can|could|would|will) (you|we|i)\b|\bdo you mind\b|\bmind (looking|taking|doing)\b|\bplease\b|\bneed(s|ed)? (some |a |help)\b|\bhelp (with|on|me)\b|\bwould love\b|\blooking for\b|\bsupport on\b|\btake a (look|stab)\b|\bhave a look\b|\bdrafts?\b|\bposts?\b/i;
  const MIN_PROSE_ASK = 40;

  // Recover the client from prose when there is no Client: field and no
  // Lineage link — "I would love some support on overall content
  // strategy for Percents". Longest account name wins so "Hume AI"
  // beats "Hume". Returns null unless the message also reads as an ask.
  function clientFromProse(text, accountNames) {
    if (!accountNames || !accountNames.length) return null;
    const clean = cleanText(stripEmoji(text));
    if (clean.length < MIN_PROSE_ASK || !ASK_PATTERNS.test(clean)) return null;
    const hay = ' ' + clean.toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
    let best = null;
    accountNames.forEach(name => {
      const needle = ' ' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
      if (needle.trim().length < 3) return;                 // too short to match safely
      if (hay.indexOf(needle) !== -1 && (!best || name.length > best.length)) best = name;
    });
    return best;
  }

  // One Slack message can carry several requests — Maxwell's 2026-08-16
  // message asked for a Sourcera post and an Eric Lay post in one go.
  // Split on repeated Client: fields first, then on distinct Lineage
  // client slugs, and otherwise treat the message as a single ask.
  function splitBlocks(text) {
    const lines = String(text || '').split('\n');
    const anchors = [];
    lines.forEach((line, i) => {
      const f = fieldOf(line);
      if (f && f.key === 'client') anchors.push(i);
    });
    if (anchors.length > 1) {
      return anchors.map((start, i) => {
        const end = i + 1 < anchors.length ? anchors[i + 1] : lines.length;
        return lines.slice(start, end).join('\n');
      });
    }
    if (anchors.length === 1) return [text];

    const slugs = lineageSlugs(text);
    if (slugs.length > 1) {
      // Free-form multi-client, e.g. "Sourcera: <brief> <link>  Eric Lay:
      // <brief> <link>". Walk the lines and close a chunk each time a
      // client's link appears, so a client's brief is the text leading up
      // to its own link. Anything trailing the last link is shared
      // sign-off and goes to the final chunk.
      const groups = [];
      const bySlug = {};
      let buffer = [];
      lines.forEach(line => {
        buffer.push(line);
        const found = lineageSlugs(line);
        if (!found.length) return;
        const slug = found[0];
        if (bySlug[slug]) {
          bySlug[slug].lines = bySlug[slug].lines.concat(buffer);   // same client again
        } else {
          bySlug[slug] = { slug, lines: buffer };
          groups.push(bySlug[slug]);
        }
        buffer = [];
      });
      if (buffer.length && groups.length) {
        groups[groups.length - 1].lines = groups[groups.length - 1].lines.concat(buffer);
      }
      if (groups.length > 1) return groups.map(g => g.lines.join('\n'));
    }
    return [text];
  }

  /**
   * Turn one Slack message into zero or more request objects.
   *
   * @param {object} msg   { ts, user, user_name, text, permalink, reactions, thread_reply_count }
   * @param {object} opts  { ownerIds: string[] }  — whose messages are not requests
   * @returns {Array<object>}
   */
  function parseMessage(msg, opts) {
    const options = opts || {};
    if (!msg || isNoise(msg, options.ownerIds)) return [];

    const requestedAt = new Date(Math.round(parseFloat(msg.ts) * 1000));
    const blocks = splitBlocks(msg.text);
    const status = statusFromReactions(msg.reactions);

    return blocks.map((block, i) => {
      const fields = parseFields(block);
      const slugs = lineageSlugs(block);
      const clientRaw = fields.client
        || (slugs.length ? slugToName(slugs[0]) : null)
        || clientFromProse(block, options.accountNames);
      const due = parseDueDate(fields.due ? fields.due : findDuePhrase(block), requestedAt);
      const priority = parsePriority(fields.priority || '') || parsePriority(block);
      const notes = cleanText(fields.notes || stripTemplate(block));

      return {
        id: msg.ts + (blocks.length > 1 ? ':' + i : ''),
        ts: msg.ts,
        source: 'slack',
        permalink: msg.permalink || null,
        requestedBy: msg.user_name || msg.user || 'Unknown',
        requestedById: msg.user || null,
        requestedAt: requestedAt.toISOString(),
        client: clientRaw ? cleanText(clientRaw) : null,
        clientSlug: slugs[0] || null,
        links: extractUrls(block),
        postRefs: lineagePostRefs(block),
        dueAt: due.at ? due.at.toISOString() : null,
        dueRaw: due.raw || (fields.due || ''),
        asap: due.asap,
        requesterPriority: priority,
        type: classifyType(block),
        posts: parsePostCount(block),
        notes: notes.slice(0, 600),
        text: cleanText(block).slice(0, 2000),
        slackStatus: status,
        threadReplies: msg.thread_reply_count || 0,
        _dueSearchedIn: fields.due ? 'field' : 'body'
      };
    }).filter(r => r.client || r.links.length);
  }

  // For free-form asks, look for the sentence carrying the deadline
  // rather than feeding the whole message to the date parser — that way
  // a Lineage post id full of digits cannot be read as a date.
  function findDuePhrase(text) {
    const clean = unwrapLinks(String(text || '')).replace(/https?:\/\/\S+/g, ' ');
    const m = clean.match(/((?:due|by|before|needed?|deadline|for publishing)\b[^.\n!?]{0,60})/i);
    return m ? m[1] : clean;
  }

  function stripTemplate(text) {
    return String(text || '')
      .split('\n')
      .filter(line => !fieldOf(line))
      .join(' ')
      .trim();
  }

  // ── Lead time ─────────────────────────────────────────────────

  // Working days between the ask and the deadline. Weekends do not
  // count: a Friday ask due Monday is one day of notice, not three,
  // and that distinction is the whole argument for the 3-day rule.
  function workingDaysBetween(fromISO, toISO) {
    if (!fromISO || !toISO) return null;
    const from = startOfDay(new Date(fromISO));
    const to = startOfDay(new Date(toISO));
    const sign = to < from ? -1 : 1;
    let days = 0;
    const cursor = new Date(Math.min(from, to));
    const end = new Date(Math.max(from, to));
    while (cursor < end) {
      cursor.setDate(cursor.getDate() + 1);
      const d = cursor.getDay();
      if (d !== 0 && d !== 6) days++;
    }
    return sign * days;
  }

  function leadTime(req, cfg) {
    const config = cfg || DEFAULT_CONFIG;
    if (!req.dueAt) return { days: null, rush: false };
    const days = workingDaysBetween(req.requestedAt, req.dueAt);
    return { days, rush: days !== null && days < config.leadTimeDays };
  }

  // ── Prioritisation ────────────────────────────────────────────

  function mrrPoints(mrr, cfg) {
    for (const band of cfg.mrrBands) if ((mrr || 0) >= band.minMrr) return band.points;
    return cfg.mrrFloorPoints;
  }

  function dueBucket(days, cfg) {
    for (const b of cfg.duePoints) if (days <= b.maxDays) return b;
    return cfg.duePoints[cfg.duePoints.length - 1];
  }

  /**
   * Score one open request. Returns the score, the band, and the list of
   * reasons that produced it — the reasons are shown in the UI so the
   * ranking is always defensible.
   *
   * @param {object} req      a parsed request
   * @param {object} account  { mrr, contentHealth, churnRisk, products, lastDeliveredAt } or null
   * @param {object} opts     { now: Date, config }
   */
  function scoreRequest(req, account, opts) {
    const o = opts || {};
    const cfg = o.config || DEFAULT_CONFIG;
    const now = o.now ? new Date(o.now) : new Date();
    const acct = account || {};
    const reasons = [];
    let score = 0;

    if (req.dueAt) {
      const days = daysBetween(now, new Date(req.dueAt));
      const bucket = dueBucket(days, cfg);
      score += bucket.points;
      reasons.push({ label: bucket.label, points: bucket.points });
    } else {
      score += cfg.noDuePoints;
      reasons.push({ label: 'No due date given', points: cfg.noDuePoints });
    }

    const mp = mrrPoints(acct.mrr, cfg);
    score += mp;
    reasons.push({ label: acct.mrr ? fmtMrr(acct.mrr) + ' MRR' : 'MRR unknown', points: mp });

    const ch = parseScore10(acct.contentHealth);
    if (ch === null) {
      score += cfg.contentHealthUnknownPoints;
      reasons.push({ label: 'Content health not set', points: cfg.contentHealthUnknownPoints });
    } else {
      const band = bandFor(ch, cfg.contentHealthPoints);
      score += band.points;
      reasons.push({ label: band.label + ' (' + ch + '/10)', points: band.points });
    }

    const risk = parseChurnRisk(acct.churnRisk);
    if (risk === null) {
      score += cfg.churnRiskUnknownPoints;
      reasons.push({ label: 'Churn risk not set', points: cfg.churnRiskUnknownPoints });
    } else {
      const band = bandFor(risk, cfg.churnRiskPoints);
      score += band.points;
      reasons.push({ label: band.label + ' (' + risk + '/10)', points: band.points });
    }

    const products = String(acct.products || '');
    if (/rev\s*share/i.test(products)) {
      score += cfg.revSharePoints;
      reasons.push({ label: 'Rev share account', points: cfg.revSharePoints });
    }
    if (/launch/i.test(products) || req.type === 'Launch') {
      score += cfg.launchPoints;
      reasons.push({ label: 'Launch work', points: cfg.launchPoints });
    }

    if (acct.lastDeliveredAt) {
      const since = daysBetween(new Date(acct.lastDeliveredAt), now);
      if (since >= cfg.starvedDays) {
        score += cfg.starvedPoints;
        reasons.push({ label: 'No content in ' + since + ' days', points: cfg.starvedPoints });
      }
    } else if (acct.mrr) {
      score += cfg.starvedPoints;
      reasons.push({ label: 'Nothing delivered yet', points: cfg.starvedPoints });
    }

    const rp = cfg.requesterPriorityPoints[req.requesterPriority || ''] || 0;
    if (rp) {
      score += rp;
      reasons.push({ label: 'Marked ' + req.requesterPriority, points: rp });
    }

    const band = score >= cfg.nowMin ? 'now' : score >= cfg.weekMin ? 'week' : 'queue';
    return { score: Math.round(score), band, reasons };
  }

  const BAND_LABEL = { now: 'Do now', week: 'This week', queue: 'Queue' };

  function bandFor(value, bands) {
    for (const b of bands) if (value <= b.max) return b;
    return bands[bands.length - 1];
  }

  // HubSpot enumeration values arrive as strings. Content Health Score is
  // a plain "1".."10".
  function parseScore10(v) {
    if (v == null || v === '') return null;
    const n = Number(String(v).trim());
    return Number.isFinite(n) && n >= 1 && n <= 10 ? n : null;
  }

  // CSM Sentiment is stored inconsistently in HubSpot: 1-5 are phrases
  // ("Very high likelihood of churn") whose LABEL is the number, while
  // 6-10 are stored as the bare numeral. Accept both, and read it on the
  // same 1-10 scale where lower means more risk.
  const CHURN_PHRASES = [
    [/very high likelihood/i, 1],
    [/somewhat high likelihood/i, 2],
    [/50\s*\/\s*50/i, 3],
    [/low likelihood/i, 4],
    [/virtually zero/i, 5]
  ];
  function parseChurnRisk(v) {
    if (v == null || v === '') return null;
    const s = String(v).trim();
    for (const [re, n] of CHURN_PHRASES) if (re.test(s)) return n;
    return parseScore10(s);
  }

  function cap(s) { return String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1); }

  function fmtMrr(n) {
    const v = Number(n) || 0;
    return v >= 1000 ? '$' + (v / 1000).toFixed(v % 1000 ? 1 : 0).replace(/\.0$/, '') + 'k' : '$' + Math.round(v);
  }

  // ── Capacity maths ────────────────────────────────────────────

  // Monday-anchored week key, so weeks line up with how the team plans.
  function weekKey(dateish) {
    const d = startOfDay(new Date(dateish));
    const offset = (d.getDay() + 6) % 7;            // Monday = 0
    d.setDate(d.getDate() - offset);
    return d.toISOString().slice(0, 10);
  }

  function monthKey(dateish) {
    const d = new Date(dateish);
    if (isNaN(d)) return null;
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function addWeeks(key, n) {
    const d = new Date(key + 'T00:00:00');
    d.setDate(d.getDate() + n * 7);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Requests in vs content delivered, per week. This is the answer to
   * "what is a reasonable number?" — it is measured, not guessed.
   *
   * @returns {Array<{week, requested, requestedPosts, delivered, deliveredPosts, rush}>}
   */
  function weeklyVolume(requests, opts) {
    const o = opts || {};
    const cfg = o.config || DEFAULT_CONFIG;
    const weeks = o.weeks || 12;
    const now = o.now ? new Date(o.now) : new Date();
    const thisWeek = weekKey(now);

    const keys = [];
    for (let i = weeks - 1; i >= 0; i--) keys.push(addWeeks(thisWeek, -i));
    const byKey = {};
    keys.forEach(k => {
      byKey[k] = { week: k, requested: 0, requestedPosts: 0, delivered: 0, deliveredPosts: 0, rush: 0 };
    });

    requests.forEach(r => {
      const rk = weekKey(r.requestedAt);
      if (byKey[rk]) {
        byKey[rk].requested++;
        byKey[rk].requestedPosts += r.posts || 1;
        if (leadTime(r, cfg).rush) byKey[rk].rush++;
      }
      if (r.status === 'done') {
        const dk = weekKey(r.completedAt || r.requestedAt);
        if (byKey[dk]) {
          byKey[dk].delivered++;
          byKey[dk].deliveredPosts += r.posts || 1;
        }
      }
    });

    return keys.map(k => byKey[k]);
  }

  /** Headline capacity numbers over the completed weeks in `weekly`. */
  function capacitySummary(weekly, opts) {
    const o = opts || {};
    const now = o.now ? new Date(o.now) : new Date();
    // The current week is partial — including it would drag the average
    // down and understate what Millie is actually able to deliver.
    const closed = weekly.filter(w => w.week !== weekKey(now));
    const withWork = closed.filter(w => w.deliveredPosts > 0 || w.requestedPosts > 0);
    const n = withWork.length || 1;
    const sum = (k) => withWork.reduce((a, w) => a + w[k], 0);
    const delivered = sum('deliveredPosts');
    const requested = sum('requestedPosts');
    const peak = withWork.reduce((a, w) => Math.max(a, w.deliveredPosts), 0);
    return {
      weeksMeasured: withWork.length,
      avgDelivered: round1(delivered / n),
      avgRequested: round1(requested / n),
      peakDelivered: peak,
      totalDelivered: delivered,
      totalRequested: requested,
      // Above 1.0 the queue is growing faster than it is being cleared.
      intakeRatio: delivered ? round1(requested / delivered) : null
    };
  }

  function round1(n) { return Math.round(n * 10) / 10; }

  /**
   * Headline volume for the Completed widget: everything finished, this
   * calendar month, this week, and a weekly average.
   *
   * Counts ITEMS, the same unit as the list underneath — one row per
   * request or per Lineage draft. It deliberately does not sum `posts`:
   * a tile that disagreed with the rows below it would send whoever is
   * reading it hunting for the missing work. The Capacity tab is where
   * pieces-of-content volume lives.
   *
   * "When it landed" is `completedAt || requestedAt`, matching
   * weeklyVolume, so this average and the Capacity tab's cannot drift
   * apart. For a Lineage-sourced row that is Millie's most recent touch
   * on the draft.
   */
  function completedSummary(requests, opts) {
    const o = opts || {};
    const now = o.now ? new Date(o.now) : new Date();
    const done = (requests || []).filter(r => r.status === 'done');

    const thisMonth = monthKey(now);
    const thisWeek = weekKey(now);

    let month = 0, week = 0;
    const byWeek = {};
    done.forEach(r => {
      const at = r.completedAt || r.requestedAt;
      if (!at) return;
      const wk = weekKey(at);
      if (monthKey(at) === thisMonth) month++;
      if (wk === thisWeek) week++;
      byWeek[wk] = (byWeek[wk] || 0) + 1;
    });

    // The current week is partial. Averaging it in would drag the number
    // down and understate what Millie actually delivers — the same rule
    // capacitySummary applies, for the same reason.
    const closed = Object.keys(byWeek).filter(k => k !== thisWeek);
    const avgPerWeek = closed.length
      ? round1(closed.reduce((a, k) => a + byWeek[k], 0) / closed.length)
      : null;

    return {
      total: done.length,
      month: month,
      week: week,
      avgPerWeek: avgPerWeek,
      weeksMeasured: closed.length,
      monthKey: thisMonth,
      weekStart: thisWeek
    };
  }

  /**
   * Per-account coverage: who is getting Millie's time, who is starved,
   * and who is monopolising her. Accounts with no requests still appear,
   * because "nobody asked" is exactly what Melissa wanted to see.
   */
  function coverageByAccount(requests, accounts, opts) {
    const o = opts || {};
    const cfg = o.config || DEFAULT_CONFIG;
    const now = o.now ? new Date(o.now) : new Date();
    const windowStart = new Date(startOfDay(now).getTime() - cfg.starvedDays * DAY);

    const rows = {};
    (accounts || []).forEach(a => {
      rows[a.id] = {
        id: a.id,
        name: a.name,
        mrr: a.mrr || 0,
        contentHealth: a.contentHealth == null ? null : a.contentHealth,
        churnRisk: a.churnRisk == null ? null : a.churnRisk,
        postsPerMonth: a.postsPerMonth || null,
        contentManager: a.contentManager || null,
        products: a.products || '',
        requests: 0,
        posts: 0,
        deliveredPosts: 0,
        openRequests: 0,
        recentPosts: 0,
        lastDeliveredAt: null,
        matched: false
      };
    });

    let unmatched = 0;
    (requests || []).forEach(r => {
      const row = r.accountId && rows[r.accountId];
      if (!row) { unmatched++; return; }
      row.matched = true;
      row.requests++;
      row.posts += r.posts || 1;
      if (r.status === 'done') {
        const at = new Date(r.completedAt || r.requestedAt);
        row.deliveredPosts += r.posts || 1;
        if (at >= windowStart) row.recentPosts += r.posts || 1;
        if (!row.lastDeliveredAt || at > new Date(row.lastDeliveredAt)) row.lastDeliveredAt = at.toISOString();
      } else {
        row.openRequests++;
      }
    });

    const list = Object.keys(rows).map(k => rows[k]);
    const totalRecent = list.reduce((a, r) => a + r.recentPosts, 0);
    list.forEach(r => {
      r.share = totalRecent ? r.recentPosts / totalRecent : 0;
      r.starved = r.recentPosts === 0;
      r.monopolising = totalRecent >= cfg.monopolyMinTotal && r.share >= cfg.monopolyShare;
    });
    list.sort((a, b) => (b.mrr - a.mrr) || a.name.localeCompare(b.name));
    return { rows: list, unmatched, totalRecentPosts: totalRecent };
  }

  /** Share of requests that arrived with less than the agreed notice. */
  function leadTimeSummary(requests, cfg) {
    const config = cfg || DEFAULT_CONFIG;
    let dated = 0, rush = 0, undated = 0, total = 0;
    const byRequester = {};
    (requests || []).forEach(r => {
      total++;
      const who = r.requestedBy || 'Unknown';
      byRequester[who] = byRequester[who] || { requester: who, total: 0, rush: 0 };
      byRequester[who].total++;
      if (!r.dueAt) { undated++; return; }
      dated++;
      if (leadTime(r, config).rush) { rush++; byRequester[who].rush++; }
    });
    return {
      total,
      dated,
      undated,
      rush,
      rushPct: dated ? Math.round((rush / dated) * 100) : 0,
      byRequester: Object.keys(byRequester)
        .map(k => byRequester[k])
        .sort((a, b) => b.rush - a.rush || b.total - a.total)
    };
  }

  // ── Performance (Lineage) ─────────────────────────────────────

  /**
   * Attach LinkedIn engagement to each request from a Lineage analytics
   * map keyed by post id.
   *
   * A request's numbers are the sum across the posts it produced, and
   * `measured` counts how many of those posts actually came back with
   * data — a request whose posts have not published yet reports zero
   * measured rather than zero engagement, which are different things.
   *
   * Impressions are deliberately absent: Lineage does not expose them for
   * LinkedIn posts, and an estimated reach number would be a fabrication.
   */
  function attachPerformance(requests, analytics) {
    const map = analytics || {};
    return (requests || []).map(r => {
      const refs = r.postRefs || [];
      let likes = 0, comments = 0, reposts = 0, measured = 0, syncedAt = null;
      let icpSum = 0, icpCount = 0, postedAt = null;
      // Who on our side worked the posts behind this request, most involved
      // first. Lineage has no author on a post record, so this comes from
      // the posts' lifecycle feeds — see netlify/functions/lineage-analytics.js.
      const workedBy = [];
      const workedSeen = {};
      refs.forEach(ref => {
        const a = map[ref.postId];
        if (!a) return;
        (a.workedBy || []).forEach(w => {
          const k = w.email || w.name;
          if (!k) return;
          if (workedSeen[k]) { workedSeen[k].events += w.events || 0; return; }
          workedSeen[k] = { name: w.name, email: w.email, events: w.events || 0 };
          workedBy.push(workedSeen[k]);
        });
        // A post can be attributed before it is published, so engagement is
        // only counted for the posts that actually came back with numbers.
        if (a.measured === false) return;
        measured++;
        likes += a.likes || 0;
        comments += a.comments || 0;
        reposts += a.reposts || 0;
        // ICP rate is a percentage per post, so several posts average
        // rather than sum. Posts without it are left out of the average
        // instead of counting as zero.
        if (a.icpRate != null) { icpSum += a.icpRate; icpCount++; }
        if (a.syncedAt && (!syncedAt || new Date(a.syncedAt) > new Date(syncedAt))) syncedAt = a.syncedAt;
        if (a.postedAt && (!postedAt || new Date(a.postedAt) > new Date(postedAt))) postedAt = a.postedAt;
      });
      workedBy.sort((a, b) => b.events - a.events || String(a.name).localeCompare(String(b.name)));
      return Object.assign({}, r, {
        workedBy,
        performance: measured
          ? {
              likes, comments, reposts,
              engagement: likes + comments + reposts,
              icpRate: icpCount ? Math.round((icpSum / icpCount) * 10) / 10 : null,
              measured, posts: refs.length, syncedAt, postedAt, workedBy
            }
          : null
      });
    });
  }

  /**
   * Roll performance up across the queue. Only measured posts count
   * toward the averages, so unpublished drafts cannot drag them down.
   */
  function performanceSummary(requests, opts) {
    const o = opts || {};
    const rows = (requests || []).filter(r => r.performance && r.performance.measured);
    const sum = k => rows.reduce((a, r) => a + r.performance[k], 0);
    const posts = rows.reduce((a, r) => a + r.performance.measured, 0);
    const engagement = sum('engagement');

    const byAccount = {};
    rows.forEach(r => {
      const key = r.accountName || 'Unmatched';
      byAccount[key] = byAccount[key] || { account: key, posts: 0, likes: 0, comments: 0, reposts: 0, engagement: 0 };
      const b = byAccount[key];
      b.posts += r.performance.measured;
      b.likes += r.performance.likes;
      b.comments += r.performance.comments;
      b.reposts += r.performance.reposts;
      b.engagement += r.performance.engagement;
    });

    let syncedAt = null;
    rows.forEach(r => {
      if (r.performance.syncedAt && (!syncedAt || new Date(r.performance.syncedAt) > new Date(syncedAt))) {
        syncedAt = r.performance.syncedAt;
      }
    });

    return {
      measuredPosts: posts,
      measuredRequests: rows.length,
      likes: sum('likes'),
      comments: sum('comments'),
      reposts: sum('reposts'),
      engagement,
      avgEngagement: posts ? Math.round((engagement / posts) * 10) / 10 : 0,
      // Unmeasured = asks whose posts are not published (or not synced yet).
      unmeasuredRequests: (requests || []).filter(r => (r.postRefs || []).length && !r.performance).length,
      top: rows.slice().sort((a, b) => b.performance.engagement - a.performance.engagement).slice(0, o.topN || 10),
      byAccount: Object.keys(byAccount).map(k => byAccount[k]).sort((a, b) => b.engagement - a.engagement),
      syncedAt
    };
  }

  /**
   * Completed work, grouped by customer and ordered by how recent it is —
   * both the customers and the posts inside each one.
   *
   * A completed request with no performance data still appears; it is
   * work Millie did, and hiding it would make the widget read as though
   * less was delivered than actually was.
   */
  function completedByAccount(requests, opts) {
    const o = opts || {};
    const groups = {};

    (requests || []).filter(r => r.status === 'done').forEach(r => {
      const key = r.accountName || 'Unmatched';
      groups[key] = groups[key] || {
        account: key,
        accountId: r.accountId || null,
        items: [],
        likes: 0, comments: 0, reposts: 0, engagement: 0,
        measured: 0, awaiting: 0,
        icpSum: 0, icpCount: 0,
        lastAt: null
      };
      const g = groups[key];
      // Order by when the work actually landed: the post's publish time
      // if we have it, otherwise when it was ticked off.
      const at = (r.performance && r.performance.postedAt) || r.completedAt || r.requestedAt;
      g.items.push(Object.assign({}, r, { completedSortAt: at }));
      if (!g.lastAt || new Date(at) > new Date(g.lastAt)) g.lastAt = at;

      if (r.performance) {
        g.likes += r.performance.likes;
        g.comments += r.performance.comments;
        g.reposts += r.performance.reposts;
        g.engagement += r.performance.engagement;
        g.measured += r.performance.measured;
        if (r.performance.icpRate != null) { g.icpSum += r.performance.icpRate; g.icpCount++; }
      } else if ((r.postRefs || []).length) {
        g.awaiting++;
      }
    });

    const list = Object.keys(groups).map(k => {
      const g = groups[k];
      g.items.sort((a, b) => new Date(b.completedSortAt) - new Date(a.completedSortAt));
      g.icpRate = g.icpCount ? Math.round((g.icpSum / g.icpCount) * 10) / 10 : null;
      g.count = g.items.length;
      g.avgEngagement = g.measured ? Math.round((g.engagement / g.measured) * 10) / 10 : null;
      delete g.icpSum; delete g.icpCount;
      return g;
    });

    list.sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
    return o.limit ? list.slice(0, o.limit) : list;
  }

  // ── Account matching ──────────────────────────────────────────

  function normalizeName(n) { return String(n || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

  /**
   * Match a request's client string to a HubSpot account. Exact
   * normalised match first, then prefix/containment — "Hume" must find
   * "Hume AI", and the lineage slug "hume-ai" must find it too.
   */
  function matchAccount(req, accounts) {
    const candidates = [req.client, req.clientSlug && slugToName(req.clientSlug)]
      .filter(Boolean)
      .map(normalizeName)
      .filter(Boolean);
    if (!candidates.length) return null;

    for (const cand of candidates) {
      const exact = (accounts || []).find(a => normalizeName(a.name) === cand);
      if (exact) return exact;
    }
    for (const cand of candidates) {
      const partial = (accounts || [])
        .filter(a => {
          const n = normalizeName(a.name);
          return n && (n.startsWith(cand) || cand.startsWith(n) || n.indexOf(cand) !== -1);
        })
        .sort((a, b) => normalizeName(a.name).length - normalizeName(b.name).length)[0];
      if (partial) return partial;
    }
    return null;
  }

  // ── Lineage-authored drafts ───────────────────────────────────

  /**
   * Millie's own drafts, straight from Lineage's activity log.
   *
   * The queue only ever sees work somebody asked for in
   * #content-support. Millie's own words there on 2026-07-15: "please
   * drop some requests in! Otherwise I will be spending time looking at
   * everyones accounts" — so the unasked-for half of her output was
   * invisible to this dashboard, and the Completed bucket read as
   * though she had delivered less than she had.
   *
   * Lineage stamps an actor id on every draft event, so a draft she
   * creates is attributable without anyone tagging anything. Each one
   * becomes a completed item, because for Millie the draft IS the
   * deliverable — the AM and the client take it from there.
   *
   * Events arrive already filtered to her actor id by
   * /api/lineage-drafts; this function only reshapes them. It is
   * deliberately tolerant about field names because the activity log
   * is an internal Lineage surface, not a contract.
   */
  function lineageDraftsToRequests(events, opts) {
    const o = opts || {};
    const seen = {};
    const out = [];
    (events || []).forEach(e => {
      if (!e) return;
      const postId = String(e.postId || e.entity_id || e.draft_id || '').toLowerCase();
      const slug = String(e.company || e.companySlug || '').toLowerCase();
      const at = e.ts || e.at || e.created_at || null;
      // Without a post id there is nothing stable to key on, and a row
      // that cannot be deduped would double-count on the next refresh.
      if (!postId || seen[postId]) return;
      seen[postId] = true;
      out.push({
        id: 'lineage:' + postId,
        ts: null,
        source: 'lineage',
        permalink: slug ? 'https://app.virio.ai/lineage/' + slug + '/' + postId : null,
        requestedBy: o.authorName || 'Millie',
        requestedAt: at,
        client: null,
        clientSlug: slug || null,
        links: slug ? ['https://app.virio.ai/lineage/' + slug + '/' + postId] : [],
        postRefs: slug ? [{ company: slug, postId: postId }] : [],
        dueAt: null,
        dueRaw: '',
        asap: false,
        requesterPriority: null,
        type: 'Post',
        posts: 1,
        notes: '',
        text: e.title || 'Draft written in Lineage',
        // Nobody ticks these: writing the draft is the completion, and
        // the activity log only records it once it exists.
        slackStatus: 'done',
        threadReplies: 0
      });
    });
    return out;
  }

  /**
   * Full pipeline: raw Slack messages + stored overrides + accounts →
   * the request list the dashboard renders.
   *
   * `overrides` is the dashboard's own state, keyed by request id:
   *   { status, completedAt, clientId, dueAt, posts, note }
   * It always wins over what was parsed, so a mis-parsed request can be
   * corrected in the UI without editing Slack.
   */
  function buildRequests(messages, overrides, accounts, opts) {
    const ov = overrides || {};
    // The parser needs the account names to recover a client from prose,
    // so fold them into the options rather than making every caller
    // remember to pass them separately.
    const o = Object.assign({}, opts, {
      accountNames: (opts && opts.accountNames) || (accounts || []).map(a => a.name).filter(Boolean)
    });
    const parsed = [];
    (messages || []).forEach(m => { parseMessage(m, o).forEach(r => parsed.push(r)); });

    // Drafts Millie wrote in Lineage. A post that was ALSO asked for in
    // Slack is already represented by that request — adding it again
    // would show one piece of work twice and inflate the week's volume —
    // so the Slack row wins and the Lineage event is dropped.
    const askedFor = {};
    parsed.forEach(r => (r.postRefs || []).forEach(ref => { askedFor[ref.postId] = true; }));
    lineageDraftsToRequests(o.lineageDrafts, o).forEach(r => {
      if (r.postRefs.some(ref => askedFor[ref.postId])) return;
      parsed.push(r);
    });

    // Manually-added requests live only in the override store.
    Object.keys(ov).forEach(id => {
      const entry = ov[id];
      if (entry && entry.manual && !parsed.some(r => r.id === id)) {
        parsed.push(Object.assign({
          id,
          ts: null,
          source: 'manual',
          permalink: null,
          requestedBy: entry.requestedBy || 'Added manually',
          requestedAt: entry.requestedAt || new Date().toISOString(),
          client: entry.client || null,
          clientSlug: null,
          links: entry.links || [],
          postRefs: [],
          dueAt: null,
          dueRaw: '',
          asap: false,
          requesterPriority: null,
          type: entry.type || 'Post',
          posts: 1,
          notes: entry.note || '',
          text: entry.text || entry.note || '',
          slackStatus: 'new',
          threadReplies: 0
        }, {}));
      }
    });

    return parsed.map(r => {
      const entry = ov[r.id] || {};
      const status = entry.status || r.slackStatus || 'new';
      const account = entry.clientId
        ? (accounts || []).find(a => a.id === entry.clientId) || null
        : matchAccount(r, accounts);
      return Object.assign({}, r, {
        status,
        statusLabel: STATUS_LABEL[status] || status,
        statusSource: entry.status ? 'dashboard' : 'slack',
        completedAt: entry.completedAt || null,
        dueAt: entry.dueAt || r.dueAt,
        dueOverridden: !!entry.dueAt,
        posts: entry.posts != null ? entry.posts : r.posts,
        accountId: account ? account.id : null,
        accountName: account ? account.name : (r.client || 'Unmatched'),
        note: entry.note || null
      });
    });
  }

  /** Attach scores and sort a request list into queue order. */
  function prioritise(requests, accounts, opts) {
    const o = opts || {};
    const byId = {};
    (accounts || []).forEach(a => { byId[a.id] = a; });

    // Delivery recency feeds the "starved account" bonus, so it has to
    // be computed across the whole list before any single item is scored.
    const lastDelivered = {};
    (requests || []).forEach(r => {
      if (r.status !== 'done' || !r.accountId) return;
      const at = r.completedAt || r.requestedAt;
      if (!lastDelivered[r.accountId] || new Date(at) > new Date(lastDelivered[r.accountId])) {
        lastDelivered[r.accountId] = at;
      }
    });

    const scored = (requests || []).map(r => {
      const acct = r.accountId ? byId[r.accountId] : null;
      const withHistory = acct
        ? Object.assign({}, acct, { lastDeliveredAt: lastDelivered[acct.id] || null })
        : null;
      const s = scoreRequest(r, withHistory, o);
      return Object.assign({}, r, {
        score: s.score,
        band: s.band,
        bandLabel: BAND_LABEL[s.band],
        reasons: s.reasons,
        lead: leadTime(r, o.config)
      });
    });

    scored.sort((a, b) => {
      if (a.status === 'done' && b.status !== 'done') return 1;
      if (b.status === 'done' && a.status !== 'done') return -1;
      if (b.score !== a.score) return b.score - a.score;
      const ad = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
      const bd = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
      if (ad !== bd) return ad - bd;
      return new Date(a.requestedAt) - new Date(b.requestedAt);
    });
    return scored;
  }

  return {
    DEFAULT_CONFIG,
    STATUS_LABEL,
    BAND_LABEL,
    OPEN_STATUSES,
    REACTION_STATUS,
    // text helpers
    unwrapLinks,
    unwrapMentions,
    stripEmoji,
    cleanText,
    extractUrls,
    lineageSlugs,
    lineagePostRefs,
    slugToName,
    // parsing
    fieldOf,
    parseFields,
    parseDueDate,
    parsePriority,
    parsePostCount,
    classifyType,
    statusFromReactions,
    isNoise,
    clientFromProse,
    splitBlocks,
    parseMessage,
    // maths
    workingDaysBetween,
    daysBetween,
    weekKey,
    monthKey,
    leadTime,
    leadTimeSummary,
    scoreRequest,
    parseScore10,
    parseChurnRisk,
    weeklyVolume,
    capacitySummary,
    coverageByAccount,
    normalizeName,
    matchAccount,
    lineageDraftsToRequests,
    buildRequests,
    prioritise,
    attachPerformance,
    performanceSummary,
    completedByAccount,
    completedSummary,
    fmtMrr
  };
});
