#!/usr/bin/env node
// Rebuild netlify/functions/_lineage-snapshot.js from Lineage activity logs.
//
//   node tools/build-lineage-snapshot.js <logsDir> [sinceISO]
//
// <logsDir> holds one file per Lineage company, named <company-slug>.jsonl,
// each the raw contents of that company's /conversations/trigger-log.jsonl.
// A daily job fetches those through the Lineage MCP workspace and runs this,
// so every run derives the snapshot the same way instead of by hand.
//
// Only the author's draft.* events count, deduped to one entry per draft and
// dated by their most recent touch — the same rule lineage-drafts.js applies
// to live data, so the snapshot and the live feed never disagree about what
// a draft is.
//
// Exits 0 and writes nothing when the result is byte-identical to what is
// already on disk, so an unchanged day produces no commit.

const fs = require('fs');
const path = require('path');

const AUTHOR = process.env.LINEAGE_AUTHOR_ID || '82d663fe-f00e-4892-ad16-37ac9837d7f7'; // Millie Hanson
const OUT = path.join(__dirname, '..', 'netlify', 'functions', '_lineage-snapshot.js');

const logsDir = process.argv[2];
const since = process.argv[3] || '2026-08-01';
if (!logsDir) {
  console.error('usage: build-lineage-snapshot.js <logsDir> [sinceISO]');
  process.exit(2);
}

const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.jsonl'));
if (!files.length) {
  console.error('No .jsonl logs in ' + logsDir + ' — refusing to write an empty snapshot.');
  process.exit(1);
}

const byDraft = new Map();
const stopsBefore = [];
let scanned = 0;

for (const f of files) {
  const company = f.replace(/\.jsonl$/, '');
  const text = fs.readFileSync(path.join(logsDir, f), 'utf8');
  let last = null;
  let sawAny = false;

  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let r;
    try { r = JSON.parse(t); } catch { continue; }   // a torn tail line is normal
    sawAny = true;
    if (r.ts && (!last || r.ts > last)) last = r.ts;
    if (r.actor !== AUTHOR) continue;

    const type = String(r.event_type || r.content || '');
    if (type.indexOf('draft.') !== 0) continue;
    if (r.entity_type && r.entity_type !== 'draft') continue;
    const postId = String(r.entity_id || r.draft_id || '').toLowerCase();
    if (!postId) continue;
    if (r.ts && r.ts < since) continue;

    const key = company + '/' + postId;
    const prev = byDraft.get(key);
    if (!prev || (r.ts || '') > prev.ts) {
      byDraft.set(key, { company, postId, ts: r.ts || null, title: r.title || null });
    }
  }

  if (!sawAny) continue;
  scanned++;
  // A log that stops before the window cannot report work in it. Recording
  // which accounts those are is the difference between "she did nothing
  // there" and "nothing there is readable".
  if (last && last < since) stopsBefore.push({ company, lastEvent: last.slice(0, 10) });
}

const drafts = [...byDraft.values()].sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
stopsBefore.sort((a, b) => a.lastEvent.localeCompare(b.lastEvent));

const capturedAt = new Date().toISOString().slice(0, 10);
const body = `// Snapshot of Millie's Lineage draft activity, captured ${capturedAt}.
//
// GENERATED — do not edit by hand. Rebuild with:
//   node tools/build-lineage-snapshot.js <logsDir> ${since}
//
// WHY A SNAPSHOT EXISTS
// lineage-drafts.js reads Lineage's activity log live, but the REST path
// that serves it has never been confirmed (see that file's header), so in
// production it currently reaches nothing. Without this, the Completed
// bucket silently reports only the Slack queue and reads as though Millie
// had done a fraction of her actual work.
//
// Read from Lineage's per-company activity logs, filtered to her actor id
// (${AUTHOR}) and to draft.* events from
// ${since} onward, deduped to one entry per draft and dated by her most
// recent touch on it. ${scanned} accounts had a readable log.
//
// IT IS A SNAPSHOT, NOT A FEED. The function serves it ONLY when the live
// endpoint cannot be reached, always marks the response source:"snapshot"
// with this capture date, and the dashboard says so on screen. The moment
// LINEAGE_ACTIVITY_URL points at the real path, live data wins and this
// file stops being read. Delete it then.
//
// It is also a FLOOR: ${stopsBefore.length} of those accounts have logs that stop before
// ${since}, so their work in this window is real and uncounted. A busy
// account's log is capped near 2,000 events and keeps the OLDEST; only a
// paginated or date-filtered activity endpoint can reach past that.

exports.capturedAt = '${capturedAt}';
exports.since = '${since}';
exports.accountsScanned = ${scanned};
exports.stopsBeforeWindow = ${JSON.stringify(stopsBefore, null, 2)};
exports.drafts = ${JSON.stringify(drafts, null, 2)};
`;

// Compare ignoring the capture date, so an unchanged day is not a commit.
const strip = t => t.replace(/captured \d{4}-\d{2}-\d{2}/, '').replace(/capturedAt = '[^']*'/, '');
const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
if (existing && strip(existing) === strip(body)) {
  console.log(`unchanged: ${drafts.length} drafts, ${scanned} accounts — nothing to commit`);
  process.exit(0);
}

fs.writeFileSync(OUT, body);
console.log(`written: ${drafts.length} drafts from ${scanned} accounts since ${since}` +
  (stopsBefore.length ? ` (${stopsBefore.length} accounts' logs stop before the window)` : ''));
