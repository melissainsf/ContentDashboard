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
    duePoints: [
      { maxDays: -1,       points: 40, label: 'Overdue' },
      { maxDays: 0,        points: 35, label: 'Due today' },
      { maxDays: 2,        points: 28, label: 'Due in 2 days' },
      { maxDays: 5,        points: 18, label: 'Due this week' },
      { maxDays: 10,       points: 10, label: 'Due next week' },
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

    // Account health, as set by the AMs on the CS dashboard. A wobbling
    // account earns content attention ahead of a comfortable one.
    healthPoints: { red: 20, yellow: 12, blue: 6, green: 2 },
    healthUnknownPoints: 6,

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
    nowMin: 60,
    weekMin: 35,

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
   * @param {object} account  { mrr, health, products, lastDeliveredAt } or null
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

    const hp = acct.health && cfg.healthPoints[acct.health] != null
      ? cfg.healthPoints[acct.health]
      : cfg.healthUnknownPoints;
    score += hp;
    reasons.push({ label: acct.health ? cap(acct.health) + ' health' : 'Health not set', points: hp });

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
        health: a.health || null,
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
    leadTime,
    leadTimeSummary,
    scoreRequest,
    weeklyVolume,
    capacitySummary,
    coverageByAccount,
    normalizeName,
    matchAccount,
    buildRequests,
    prioritise,
    fmtMrr
  };
});
