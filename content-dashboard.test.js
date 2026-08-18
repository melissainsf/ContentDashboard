/* Unit tests for Millie's Content Dashboard engine.
   Run:  node content-dashboard.test.js
   No dependencies — same tiny assert harness as bonus-calculator.test.js.

   The Slack fixtures below are real messages from #content-support,
   trimmed but otherwise verbatim, so the parser is tested against the
   shapes the team actually posts rather than idealised ones. */
const CD = require('./content-dashboard.js');

let passed = 0, failed = 0;
function ok(name, cond) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ FAIL: ' + name); }
}
function eq(name, actual, expected) {
  const cond = actual === expected;
  if (!cond) console.error('  ✗ FAIL: ' + name + '\n      expected: ' + JSON.stringify(expected) + '\n      actual:   ' + JSON.stringify(actual));
  if (cond) passed++; else failed++;
}
function section(name) { console.log('\n' + name); }

const MILLIE = 'U0A2VGT6NRL';
const OPTS = { ownerIds: [MILLIE] };

// Slack ts values for the fixture messages.
const ts = (iso) => String(new Date(iso).getTime() / 1000);

// ── Slack text helpers ─────────────────────────────────────────
section('Slack text helpers');

eq('unwrapLinks keeps the url, drops the display half',
  CD.unwrapLinks('see <https://app.virio.ai/lineage/axya/abc|app.virio.ai/lineage/…>'),
  'see https://app.virio.ai/lineage/axya/abc');

eq('unwrapMentions renders a readable name',
  CD.unwrapMentions('Hey <@U0A2VGT6NRL|Millie>!'), 'Hey @Millie!');

eq('stripEmoji removes slack shortcodes',
  CD.stripEmoji(':bust_in_silhouette: Client:').trim(), 'Client:');

eq('lineageSlugs pulls the client slug out of a post url',
  CD.lineageSlugs('<https://app.virio.ai/lineage/hume-ai/216565b9-5247|x>')[0], 'hume-ai');

eq('lineageSlugs dedupes repeated clients',
  CD.lineageSlugs('a https://app.virio.ai/lineage/minimal/1 b https://app.virio.ai/lineage/minimal/2').length, 1);

eq('slugToName titlecases a hyphenated slug', CD.slugToName('eric-lay'), 'Eric Lay');

// ── Template field parsing ─────────────────────────────────────
section('Template field parsing');

const TEMPLATE = [
  ':bust_in_silhouette: Client: Axya',
  ' :link: Link: <https://app.virio.ai/lineage/axya/d9426438-3898-46fe-9900-3f301c7ee686|app.virio.ai/lineage/axya/…>',
  ':date: Due Date: July 15th',
  ':red_circle: Priority: HIGH',
  ":memo: Additional Notes: I'm having a bit of a hard time finding an in-angle for this ABM post. Do you mind taking a stab at it? Thank you!"
].join('\n');

const tf = CD.parseFields(TEMPLATE);
eq('client field', tf.client, 'Axya');
eq('due field', tf.due, 'July 15th');
eq('priority field', tf.priority, 'HIGH');
ok('notes field captured', /in-angle for this ABM post/.test(tf.notes));

// David Zou posts the same fields lowercase with no emoji.
const PLAIN = 'client: Hume\nlink: <https://drive.google.com/file/d/1Smw/view|drive.google.com/…>\ndue date: ASAP, need to provide feedback by EOD the latest\npriority: HIGH HIGH HIGH';
const pf = CD.parseFields(PLAIN);
eq('lowercase client field', pf.client, 'Hume');
eq('lowercase priority field', pf.priority, 'HIGH HIGH HIGH');

// Multi-line notes continue until the next recognised field.
const MULTI = ':memo: Additional Notes:\n• first line\n• second line';
ok('multi-line notes keep every line', /first line/.test(CD.parseFields(MULTI).notes) && /second line/.test(CD.parseFields(MULTI).notes));

ok('a normal sentence is not read as a field', CD.fieldOf('Can you take a look at next week for Highwire?') === null);
ok('a url is not read as a field', CD.fieldOf('https://app.virio.ai/lineage/axya/abc') === null);

// ── Due date parsing ───────────────────────────────────────────
section('Due date parsing');

// Anchor: Saturday 2026-07-11, the day Maxwell posted the Axya request.
const JUL11 = new Date('2026-07-11T16:38:36-07:00');

eq('"July 15th" resolves to the 15th',
  CD.parseDueDate('July 15th', JUL11).at.toISOString().slice(0, 10), '2026-07-15');
eq('"Jul 14" resolves to the 14th',
  CD.parseDueDate('Jul 14', JUL11).at.toISOString().slice(0, 10), '2026-07-14');
eq('"July 22nd" resolves to the 22nd',
  CD.parseDueDate('July 22nd', JUL11).at.toISOString().slice(0, 10), '2026-07-22');
eq('ISO dates parse', CD.parseDueDate('2026-08-22', JUL11).at.toISOString().slice(0, 10), '2026-08-22');

const asap = CD.parseDueDate('ASAP, need to provide feedback by EOD the latest', JUL11);
eq('ASAP is due same day', asap.at.toISOString().slice(0, 10), '2026-07-11');
ok('ASAP sets the asap flag', asap.asap === true);

eq('"tomorrow" is +1 day', CD.parseDueDate('tomorrow', JUL11).at.toISOString().slice(0, 10), '2026-07-12');

// Sunday 2026-08-16 → "this Tuesday (18th)".
const AUG16 = new Date('2026-08-16T18:01:26-07:00');
eq('parenthesised day beats the weekday name',
  CD.parseDueDate('this Tuesday (18th) morning for time for graphics', AUG16).at.toISOString().slice(0, 10), '2026-08-18');
eq('"By Tuesday" resolves to the next Tuesday',
  CD.parseDueDate('By Tuesday', AUG16).at.toISOString().slice(0, 10), '2026-08-18');

// A weekday named on that same weekday means the *next* one.
const TUE = new Date('2026-08-18T09:00:00-07:00');
eq('"Tuesday" said on a Tuesday means next Tuesday',
  CD.parseDueDate('by Tuesday', TUE).at.toISOString().slice(0, 10), '2026-08-25');

eq('year rolls forward across December',
  CD.parseDueDate('Jan 3', new Date('2026-12-28T10:00:00Z')).at.toISOString().slice(0, 10), '2027-01-03');

ok('a message with no date returns null', CD.parseDueDate('can I get another couple of posts', JUL11).at === null);

// ── Priority + volume ──────────────────────────────────────────
section('Priority and volume parsing');

eq('HIGH', CD.parsePriority('HIGH'), 'high');
eq('Med', CD.parsePriority('Med'), 'medium');
eq('HIGH HIGH HIGH', CD.parsePriority('HIGH HIGH HIGH'), 'high');
eq('bare !!! reads as high', CD.parsePriority('!!!'), 'high');
eq('no priority given', CD.parsePriority(''), null);

eq('"another couple of posts" counts 2', CD.parsePostCount('could I get another couple of posts like this one for Sourcera?'), 2);
eq('"3 posts" counts 3', CD.parsePostCount('need 3 posts for launch week'), 3);
eq('a single ask counts 1', CD.parsePostCount('Do you mind doing a reintroduction post for Timur?'), 1);
eq('two bulleted lineage posts count 2', CD.parsePostCount(
  '• <https://app.virio.ai/lineage/minimal/3ce56c38-0f15-4195-8372-99ea73834374|x>\n• <https://app.virio.ai/lineage/minimal/2dcce067-e05e-449f-8625-1e344cbfc675|y>'), 2);

eq('ABM classified', CD.classifyType('can we do a series A founders ABM post?'), 'ABM');
eq('launch classified', CD.classifyType("Hume is launching a major voice AI eval, embargo'd post"), 'Launch');
eq('rework classified', CD.classifyType('Got some negative feedback in the comments and need to rework/improve'), 'Rework');
eq('strategy classified', CD.classifyType('I would love some support on overall content strategy for Percents'), 'Strategy');

// ── Status from reactions ──────────────────────────────────────
section('Status from Slack reactions');

eq('green circle means done', CD.statusFromReactions([{ name: 'white_check_mark' }, { name: 'large_green_circle' }]), 'done');
eq('orange circle means in progress', CD.statusFromReactions([{ name: 'white_check_mark' }, { name: 'large_orange_circle' }]), 'in_progress');
eq('tick alone means accepted', CD.statusFromReactions([{ name: 'white_check_mark' }]), 'accepted');
eq('x means the brief is not good enough', CD.statusFromReactions([{ name: 'x' }]), 'blocked');
eq('no reactions means new', CD.statusFromReactions([]), 'new');
eq('plain strings work too', CD.statusFromReactions(['large_green_circle']), 'done');

// ── Noise filtering ────────────────────────────────────────────
section('Noise filtering');

ok('channel joins are noise', CD.isNoise({ text: '<@U0BJTUU4UHW|Ion> has joined the channel', ts: ts('2026-08-17T14:36:14Z') }, OPTS.ownerIds));
ok('@here announcements are noise', CD.isNoise({ text: '<!here> - please drop some requests in!', user: MILLIE, ts: ts('2026-07-16T06:38:53Z') }, OPTS.ownerIds));
ok("Millie's own messages are not requests", CD.isNoise({ text: 'Hi team - I have started adding bi-weekly meetings', user: MILLIE, ts: ts('2026-07-08T18:01:22Z') }, OPTS.ownerIds));
ok('a real templated request is not noise', !CD.isNoise({ text: TEMPLATE, user: 'U0AQTDE8GRY', ts: ts('2026-07-11T23:38:36Z') }, OPTS.ownerIds));

// Chatter with no client and no link is dropped at the parse step, which
// is where the decision belongs — isNoise only handles structural noise.
const PROSE_ACCOUNTS = ['Netlify', 'Hume AI', 'Highwire', 'Percents', 'Crescendo', 'Metaview', 'Axya'];
eq('a short thanks yields no request', CD.parseMessage(
  { text: 'Thanks for creating this, Millie!', user: 'U0A6GDPP9E3', ts: ts('2026-07-08T18:19:30Z'), reactions: [] },
  { ownerIds: [MILLIE], accountNames: PROSE_ACCOUNTS }).length, 0);
eq('naming a client without asking for anything is not a request', CD.parseMessage(
  { text: 'Netlify are really happy with how last week went, nice one team!', user: 'U0A6GDPP9E3', ts: ts('2026-07-08T18:19:30Z'), reactions: [] },
  { ownerIds: [MILLIE], accountNames: PROSE_ACCOUNTS }).length, 0);

// ── Client recovered from prose ────────────────────────────────
section('Client recovered from prose');

// These are real asks that carry no template and no Lineage link. Losing
// them would understate the volume the capacity decision depends on.
eq('"take a look at next week for Highwire" finds the client',
  CD.clientFromProse('Can you take a look at next week for Highwire? I have some drafts that need attention.', PROSE_ACCOUNTS), 'Highwire');
eq('"support on overall content strategy for Percents" finds the client',
  CD.clientFromProse('I would love some support on overall content strategy for Percents. We have saved him from churn', PROSE_ACCOUNTS), 'Percents');
eq('"I need some viral meme posts for him" finds Metaview',
  CD.clientFromProse('And also Metaview, I need some viral meme/goofy posts for him. Bowker dropped one a while back', PROSE_ACCOUNTS), 'Metaview');
eq('the longest matching account name wins',
  CD.clientFromProse('Could you help with a post for Hume AI please, they need it soon', PROSE_ACCOUNTS), 'Hume AI');
ok('a remark that names a client is not treated as an ask',
  CD.clientFromProse('Netlify are really happy with how last week went', PROSE_ACCOUNTS) === null);
ok('a client name with no ask and no length is ignored',
  CD.clientFromProse('Axya', PROSE_ACCOUNTS) === null);
ok('no account list means no prose matching',
  CD.clientFromProse('Can you help with Highwire please, they need drafts', []) === null);

const prose = CD.parseMessage({
  ts: ts('2026-07-16T06:45:45Z'),
  user: 'U0AQTDE8GRY',
  user_name: 'Maxwell Zinkievich',
  text: 'Can you take a look at next week for Highwire? I have some drafts that need attention. Sorry if too broad a request!',
  reactions: [{ name: 'white_check_mark' }, { name: 'large_orange_circle' }]
}, { ownerIds: [MILLIE], accountNames: PROSE_ACCOUNTS });
eq('a link-free prose ask still becomes a request', prose.length, 1);
eq('...with the client attached', prose[0].client, 'Highwire');
eq('...and the in-progress status from its reactions', prose[0].slackStatus, 'in_progress');

// ── Whole-message parsing ──────────────────────────────────────
section('Message parsing');

const axya = CD.parseMessage({
  ts: ts('2026-07-11T23:38:36Z'),
  user: 'U0AQTDE8GRY',
  user_name: 'Maxwell Zinkievich',
  text: TEMPLATE,
  reactions: [{ name: 'white_check_mark' }, { name: 'large_green_circle' }]
}, OPTS);

eq('one templated message yields one request', axya.length, 1);
eq('client parsed', axya[0].client, 'Axya');
eq('due date parsed', axya[0].dueAt.slice(0, 10), '2026-07-15');
eq('requester priority parsed', axya[0].requesterPriority, 'high');
eq('type inferred from the notes', axya[0].type, 'ABM');
eq('status derived from reactions', axya[0].slackStatus, 'done');
eq('link captured', axya[0].links.length, 1);
eq('requester name kept', axya[0].requestedBy, 'Maxwell Zinkievich');

// Free-form ask with no template at all.
const timur = CD.parseMessage({
  ts: ts('2026-07-20T17:21:21Z'),
  user: 'U0AQTDE8GRY',
  user_name: 'Maxwell Zinkievich',
  text: 'Do you mind doing a reintroduction post for Timur? : <https://app.virio.ai/lineage/hustlepay/9854f302-5161-44a1-9080-56e14282c1f4|app.virio.ai/lineage/hustlepay/…>',
  reactions: [{ name: 'large_green_circle' }]
}, OPTS);
eq('free-form ask still becomes a request', timur.length, 1);
eq('client recovered from the lineage slug', timur[0].client, 'Hustlepay');
eq('free-form ask with no date has no due date', timur[0].dueAt, null);

// One message, two clients — Maxwell's 2026-08-16 weekly ask.
const twoClients = CD.parseMessage({
  ts: ts('2026-08-17T01:01:26Z'),
  user: 'U0AQTDE8GRY',
  user_name: 'Maxwell Zinkievich',
  text: [
    'Hey <@U0A2VGT6NRL|Millie>!',
    "Here's what I need help with this week:",
    'Sourcera:',
    'Due by this Tuesday (18th) morning for time for graphics: YC Post Redux please!',
    'Please draft in this link: <https://app.virio.ai/lineage/sourcera/d1001366-58aa-45cb-b0af-b96cbcfd3934|app.virio.ai/lineage/sourcera/…>',
    'Eric Lay:',
    'By Tuesday: can we do a series A founders ABM post? For publishing this wednesday',
    'Please draft in this link: <https://app.virio.ai/lineage/eric-lay/b56cbfa8-3892-4a6e-890a-0406d6b64c4e|app.virio.ai/lineage/eric-lay/…>'
  ].join('\n'),
  reactions: [{ name: 'white_check_mark' }]
}, OPTS);
eq('a two-client message splits into two requests', twoClients.length, 2);
eq('first client', twoClients[0].client, 'Sourcera');
eq('second client', twoClients[1].client, 'Eric Lay');
eq('split requests get distinct ids', new Set(twoClients.map(r => r.id)).size, 2);
// Each client's row must show only its own brief — a Sourcera row that
// also displays the Eric Lay ask is unreadable in the queue.
ok('the first request keeps only its own brief', /YC Post Redux/.test(twoClients[0].text) && !/series A founders/.test(twoClients[0].text));
ok('the second request keeps only its own brief', /series A founders/.test(twoClients[1].text) && !/YC Post Redux/.test(twoClients[1].text));
ok('each request keeps only its own link',
  twoClients[0].links.every(u => !/eric-lay/.test(u)) && twoClients[1].links.every(u => !/sourcera/.test(u)));
eq('the first client keeps its own deadline', twoClients[0].dueAt.slice(0, 10), '2026-08-18');
eq('the second client keeps its own deadline', twoClients[1].dueAt.slice(0, 10), '2026-08-18');
eq('second request classified as ABM', twoClients[1].type, 'ABM');
eq('both inherit the accepted status', twoClients[0].slackStatus, 'accepted');

// Two Client: fields in one templated message also split.
const twoTemplates = CD.splitBlocks(
  ':bust_in_silhouette: Client: Netlify\n:date: Due Date: Jul 14\n:bust_in_silhouette: Client: Trimble\n:date: Due Date: Jul 20');
eq('repeated Client: fields split into blocks', twoTemplates.length, 2);
ok('each block keeps its own due date', /Jul 14/.test(twoTemplates[0]) && /Jul 20/.test(twoTemplates[1]));

// A lineage post id must never be mistaken for a date.
const idOnly = CD.parseMessage({
  ts: ts('2026-08-04T15:01:53Z'),
  user: 'U0AQTDE8GRY',
  user_name: 'Maxwell Zinkievich',
  text: 'Hey! could I get another couple of posts like this one for Sourcera? : <https://app.virio.ai/lineage/sourcera/58559a6d-ee39-4949-b13f-85403732943c|x>',
  reactions: []
}, OPTS);
eq('a post id is not read as a due date', idOnly[0].dueAt, null);
eq('"another couple of posts" is counted as 2', idOnly[0].posts, 2);

// ── Lead time ──────────────────────────────────────────────────
section('Lead time');

eq('Mon → Thu is 3 working days', CD.workingDaysBetween('2026-08-17T09:00:00Z', '2026-08-20T09:00:00Z'), 3);
eq('Fri → Mon is 1 working day, not 3', CD.workingDaysBetween('2026-08-14T09:00:00Z', '2026-08-17T09:00:00Z'), 1);
eq('same day is 0', CD.workingDaysBetween('2026-08-17T09:00:00Z', '2026-08-17T18:00:00Z'), 0);

ok('a Friday ask due Monday is a rush',
  CD.leadTime({ requestedAt: '2026-08-14T09:00:00Z', dueAt: '2026-08-17T09:00:00Z' }).rush === true);
ok('a Monday ask due Thursday clears the 3-day rule',
  CD.leadTime({ requestedAt: '2026-08-17T09:00:00Z', dueAt: '2026-08-20T09:00:00Z' }).rush === false);
ok('no due date is not counted as a rush',
  CD.leadTime({ requestedAt: '2026-08-17T09:00:00Z', dueAt: null }).rush === false);

const lts = CD.leadTimeSummary([
  { requestedAt: '2026-08-14T09:00:00Z', dueAt: '2026-08-17T09:00:00Z', requestedBy: 'Maxwell' },
  { requestedAt: '2026-08-17T09:00:00Z', dueAt: '2026-08-20T09:00:00Z', requestedBy: 'Maxwell' },
  { requestedAt: '2026-08-17T09:00:00Z', dueAt: null, requestedBy: 'David' }
]);
eq('lead time summary counts rushes', lts.rush, 1);
eq('lead time summary ignores undated requests in the percentage', lts.rushPct, 50);
eq('lead time summary counts undated separately', lts.undated, 1);
eq('worst offender ranked first', lts.byRequester[0].requester, 'Maxwell');

// ── Prioritisation ─────────────────────────────────────────────
section('Prioritisation');

const NOW = new Date('2026-08-18T12:00:00Z');
const base = { requestedAt: '2026-08-17T09:00:00Z', type: 'Post', posts: 1 };

// Melissa's own worked example from the sync: a bigger, wobbling account
// outranks a smaller, healthy one on the same deadline.
const big = CD.scoreRequest(Object.assign({}, base, { dueAt: '2026-08-25T09:00:00Z' }),
  { mrr: 20000, health: 'yellow' }, { now: NOW });
const small = CD.scoreRequest(Object.assign({}, base, { dueAt: '2026-08-25T09:00:00Z' }),
  { mrr: 6000, health: 'green' }, { now: NOW });
ok('20k/yellow outranks 6k/green on the same deadline', big.score > small.score);

// ...but a deadline still beats account size.
const dueToday = CD.scoreRequest(Object.assign({}, base, { dueAt: '2026-08-18T09:00:00Z' }),
  { mrr: 6000, health: 'green' }, { now: NOW });
const dueLater = CD.scoreRequest(Object.assign({}, base, { dueAt: '2026-09-30T09:00:00Z' }),
  { mrr: 20000, health: 'yellow' }, { now: NOW });
ok('a deadline today beats a big account with no deadline pressure', dueToday.score > dueLater.score);

const overdue = CD.scoreRequest(Object.assign({}, base, { dueAt: '2026-08-14T09:00:00Z' }),
  { mrr: 6000, health: 'green' }, { now: NOW });
ok('overdue work lands in the "do now" band', overdue.band === 'now');

ok('every score carries its reasons', big.reasons.length >= 3);
ok('reason points sum to the score',
  Math.round(big.reasons.reduce((a, r) => a + r.points, 0)) === big.score);

const revShare = CD.scoreRequest(Object.assign({}, base, { dueAt: '2026-08-25T09:00:00Z' }),
  { mrr: 6000, health: 'green', products: 'EGC, Rev Share' }, { now: NOW });
ok('rev share accounts score above the same account without it', revShare.score > small.score);

const starved = CD.scoreRequest(Object.assign({}, base, { dueAt: '2026-08-25T09:00:00Z' }),
  { mrr: 6000, health: 'green', lastDeliveredAt: '2026-06-01T09:00:00Z' }, { now: NOW });
const wellFed = CD.scoreRequest(Object.assign({}, base, { dueAt: '2026-08-25T09:00:00Z' }),
  { mrr: 6000, health: 'green', lastDeliveredAt: '2026-08-14T09:00:00Z' }, { now: NOW });
ok('an account with nothing recent gets a nudge up the queue', starved.score > wellFed.score);
ok('an account served last week gets no starvation bonus',
  !wellFed.reasons.some(r => /No content in/.test(r.label)));
ok('an account nobody has ever asked about counts as starved too',
  small.reasons.some(r => /Nothing delivered yet/.test(r.label)));

// ── Account matching ───────────────────────────────────────────
section('Account matching');

const ACCOUNTS = [
  { id: '1', name: 'Netlify', mrr: 20000, health: 'green' },
  { id: '2', name: 'Hume AI', mrr: 12000, health: 'yellow' },
  { id: '3', name: 'Axya', mrr: 6000, health: 'green' },
  { id: '4', name: 'HustlePay', mrr: 8000, health: 'red' },
  { id: '5', name: 'Highwire', mrr: 9000, health: 'yellow' }
];

eq('exact match', CD.matchAccount({ client: 'Netlify' }, ACCOUNTS).id, '1');
eq('case and spacing insensitive', CD.matchAccount({ client: 'hustlepay' }, ACCOUNTS).id, '4');
eq('"Hume" finds "Hume AI"', CD.matchAccount({ client: 'Hume' }, ACCOUNTS).id, '2');
eq('the lineage slug is used when no client is named',
  CD.matchAccount({ client: null, clientSlug: 'hume-ai' }, ACCOUNTS).id, '2');
ok('an unknown client matches nothing', CD.matchAccount({ client: 'Someone Else' }, ACCOUNTS) === null);

// ── Capacity maths ─────────────────────────────────────────────
section('Capacity maths');

eq('week key anchors on Monday', CD.weekKey('2026-08-20T12:00:00Z'), '2026-08-17');
eq('Sunday belongs to the week that started the previous Monday', CD.weekKey('2026-08-23T12:00:00Z'), '2026-08-17');

const HISTORY = [
  { requestedAt: '2026-08-03T09:00:00Z', completedAt: '2026-08-04T09:00:00Z', status: 'done', posts: 3, dueAt: '2026-08-07T09:00:00Z' },
  { requestedAt: '2026-08-03T09:00:00Z', completedAt: '2026-08-05T09:00:00Z', status: 'done', posts: 2, dueAt: null },
  { requestedAt: '2026-08-10T09:00:00Z', completedAt: '2026-08-11T09:00:00Z', status: 'done', posts: 4, dueAt: '2026-08-11T09:00:00Z' },
  { requestedAt: '2026-08-10T09:00:00Z', status: 'accepted', posts: 2, dueAt: '2026-08-21T09:00:00Z' }
];
const weekly = CD.weeklyVolume(HISTORY, { now: NOW, weeks: 4 });
eq('weekly volume returns one row per week', weekly.length, 4);
const wk3 = weekly.find(w => w.week === '2026-08-03');
eq('delivered posts bucketed into the completion week', wk3.deliveredPosts, 5);
eq('requested posts bucketed into the request week', wk3.requestedPosts, 5);
const wk10 = weekly.find(w => w.week === '2026-08-10');
eq('open requests count as requested but not delivered', wk10.deliveredPosts, 4);
eq('open requests still count toward intake', wk10.requestedPosts, 6);
eq('same-day deadlines are flagged as rushes', wk10.rush, 1);

const cap = CD.capacitySummary(weekly, { now: NOW });
eq('the partial current week is excluded from the average', cap.weeksMeasured, 2);
eq('average delivered per week', cap.avgDelivered, 4.5);
eq('peak week', cap.peakDelivered, 5);
ok('intake ratio above 1 means the queue is growing', cap.intakeRatio > 1);

// ── Coverage ───────────────────────────────────────────────────
section('Coverage');

const COVERAGE_REQS = [
  { accountId: '1', status: 'done', posts: 8, completedAt: '2026-08-10T09:00:00Z', requestedAt: '2026-08-10T09:00:00Z' },
  { accountId: '3', status: 'done', posts: 1, completedAt: '2026-08-12T09:00:00Z', requestedAt: '2026-08-12T09:00:00Z' },
  { accountId: '3', status: 'accepted', posts: 1, requestedAt: '2026-08-17T09:00:00Z' },
  { accountId: null, status: 'new', posts: 1, requestedAt: '2026-08-17T09:00:00Z' }
];
const cov = CD.coverageByAccount(COVERAGE_REQS, ACCOUNTS, { now: NOW });
eq('every account appears, even ones nobody asked about', cov.rows.length, 5);
const netlify = cov.rows.find(r => r.id === '1');
eq('delivered posts counted', netlify.deliveredPosts, 8);
ok('an account taking most of the recent output is flagged', netlify.monopolising === true);
const highwire = cov.rows.find(r => r.id === '5');
ok('an account with no recent content is flagged as starved', highwire.starved === true);
eq('unmatched requests are counted, not silently dropped', cov.unmatched, 1);
const axyaRow = cov.rows.find(r => r.id === '3');
eq('open requests tracked separately from delivered', axyaRow.openRequests, 1);
eq('rows sort by MRR, biggest first', cov.rows[0].id, '1');

// ── End-to-end ─────────────────────────────────────────────────
section('End to end');

const MESSAGES = [
  { ts: ts('2026-07-11T23:38:36Z'), user: 'U0AQTDE8GRY', user_name: 'Maxwell Zinkievich', text: TEMPLATE, reactions: [{ name: 'large_green_circle' }] },
  { ts: ts('2026-08-17T16:00:00Z'), user: 'U0A6GDPP9E3', user_name: 'Melissa McMillan', text: ':bust_in_silhouette: Client: Netlify\n:date: Due Date: Aug 19\n:red_circle: Priority: High\n:memo: Additional Notes: hiring post, needs to pop off', reactions: [] },
  { ts: ts('2026-08-17T16:05:00Z'), user: MILLIE, user_name: 'Millie Hanson', text: '<!here> please drop requests in', reactions: [] },
  { ts: ts('2026-08-17T16:06:00Z'), user: 'U0BJTUU4UHW', user_name: 'Ion', text: '<@U0BJTUU4UHW|Ion> has joined the channel', reactions: [] }
];

const built = CD.buildRequests(MESSAGES, {}, ACCOUNTS, OPTS);
eq('noise is excluded end to end', built.length, 2);
const ranked = CD.prioritise(built, ACCOUNTS, { now: NOW });
eq('the open Netlify request outranks the finished Axya one', ranked[0].accountName, 'Netlify');
eq('completed work sinks to the bottom', ranked[ranked.length - 1].status, 'done');
ok('every ranked request carries a band label', ranked.every(r => !!r.bandLabel));

// Dashboard overrides beat whatever Slack said.
const overridden = CD.buildRequests(MESSAGES, {
  [ts('2026-08-17T16:00:00Z')]: { status: 'done', completedAt: '2026-08-18T10:00:00Z' }
}, ACCOUNTS, OPTS);
const netlifyReq = overridden.find(r => r.accountName === 'Netlify');
eq('a dashboard tick marks the request done', netlifyReq.status, 'done');
eq('the override is labelled as coming from the dashboard', netlifyReq.statusSource, 'dashboard');
eq('the completion time is kept for the volume charts', netlifyReq.completedAt, '2026-08-18T10:00:00Z');

// A mis-parsed client can be corrected without editing Slack.
const reassigned = CD.buildRequests(MESSAGES, {
  [ts('2026-07-11T23:38:36Z')]: { clientId: '5' }
}, ACCOUNTS, OPTS);
eq('an override reassigns the account', reassigned.find(r => r.id === ts('2026-07-11T23:38:36Z')).accountName, 'Highwire');

// Manually-added requests appear alongside the Slack ones.
const withManual = CD.buildRequests(MESSAGES, {
  'manual-1': { manual: true, client: 'Highwire', note: 'asked on a call', requestedAt: '2026-08-18T09:00:00Z' }
}, ACCOUNTS, OPTS);
eq('a manually added request joins the queue', withManual.length, 3);
eq('manual requests are matched to accounts too', withManual.find(r => r.id === 'manual-1').accountName, 'Highwire');

// ── Summary ────────────────────────────────────────────────────
console.log('\n' + (failed === 0 ? '✓ ' : '✗ ') + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
