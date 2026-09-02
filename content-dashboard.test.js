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
  { mrr: 20000, contentHealth: '4', churnRisk: '2' }, { now: NOW });
const small = CD.scoreRequest(Object.assign({}, base, { dueAt: '2026-08-25T09:00:00Z' }),
  { mrr: 6000, contentHealth: '9', churnRisk: '5' }, { now: NOW });
ok('a big account behind on content outranks a small healthy one', big.score > small.score);

// ...but a deadline still beats account size.
const dueToday = CD.scoreRequest(Object.assign({}, base, { dueAt: '2026-08-18T09:00:00Z' }),
  { mrr: 6000, contentHealth: '9', churnRisk: '5' }, { now: NOW });
const dueLater = CD.scoreRequest(Object.assign({}, base, { dueAt: '2026-09-30T09:00:00Z' }),
  { mrr: 20000, contentHealth: '4', churnRisk: '2' }, { now: NOW });
ok('a deadline today beats a big account with no deadline pressure', dueToday.score > dueLater.score);

const overdue = CD.scoreRequest(Object.assign({}, base, { dueAt: '2026-08-14T09:00:00Z' }),
  { mrr: 6000, contentHealth: '9', churnRisk: '5' }, { now: NOW });
ok('overdue work lands in the "do now" band', overdue.band === 'now');

ok('every score carries its reasons', big.reasons.length >= 3);
ok('reason points sum to the score',
  Math.round(big.reasons.reduce((a, r) => a + r.points, 0)) === big.score);

const revShare = CD.scoreRequest(Object.assign({}, base, { dueAt: '2026-08-25T09:00:00Z' }),
  { mrr: 6000, contentHealth: '9', churnRisk: '5', products: 'EGC, Rev Share' }, { now: NOW });
ok('rev share accounts score above the same account without it', revShare.score > small.score);

const starved = CD.scoreRequest(Object.assign({}, base, { dueAt: '2026-08-25T09:00:00Z' }),
  { mrr: 6000, contentHealth: '9', churnRisk: '5', lastDeliveredAt: '2026-06-01T09:00:00Z' }, { now: NOW });
const wellFed = CD.scoreRequest(Object.assign({}, base, { dueAt: '2026-08-25T09:00:00Z' }),
  { mrr: 6000, contentHealth: '9', churnRisk: '5', lastDeliveredAt: '2026-08-14T09:00:00Z' }, { now: NOW });
ok('an account with nothing recent gets a nudge up the queue', starved.score > wellFed.score);
ok('an account served last week gets no starvation bonus',
  !wellFed.reasons.some(r => /No content in/.test(r.label)));

// ── Content health and churn risk ──────────────────────────────
section('Content health and churn risk');

// HubSpot stores Content Health Score as a plain "1".."10".
eq('content health parses', CD.parseScore10('4'), 4);
eq('a blank content health is unknown, not zero', CD.parseScore10(''), null);
eq('an out-of-range value is rejected', CD.parseScore10('11'), null);

// CSM Sentiment is stored as phrases for 1-5 and bare numerals for 6-10.
eq('"Very high likelihood of churn" reads as 1', CD.parseChurnRisk('Very high likelihood of churn'), 1);
eq('"Somewhat high likelihood of churn" reads as 2', CD.parseChurnRisk('Somewhat high likelihood of churn'), 2);
eq('"50/50 - likelihood of churn" reads as 3', CD.parseChurnRisk('50/50 - likelihood of churn'), 3);
eq('"Low likelihood of churn" reads as 4', CD.parseChurnRisk('Low likelihood of churn'), 4);
eq('"Virtually zero likelihood of churn" reads as 5', CD.parseChurnRisk('Virtually zero likelihood of churn'), 5);
eq('a bare numeral still parses', CD.parseChurnRisk('8'), 8);
eq('an unset sentiment is unknown', CD.parseChurnRisk(null), null);

// Being behind on content is the most direct reason to prioritise an ask.
const behind = CD.scoreRequest(Object.assign({}, base, { dueAt: '2026-08-25T09:00:00Z' }),
  { mrr: 6000, contentHealth: '2', churnRisk: '5' }, { now: NOW });
const ahead = CD.scoreRequest(Object.assign({}, base, { dueAt: '2026-08-25T09:00:00Z' }),
  { mrr: 6000, contentHealth: '10', churnRisk: '5' }, { now: NOW });
ok('an account behind on content outranks one well ahead', behind.score > ahead.score);
ok('the reason names the content health score', behind.reasons.some(r => /behind on content \(2\/10\)/i.test(r.label)));

const churny = CD.scoreRequest(Object.assign({}, base, { dueAt: '2026-08-25T09:00:00Z' }),
  { mrr: 6000, contentHealth: '9', churnRisk: 'Very high likelihood of churn' }, { now: NOW });
ok('a churn-risk account outranks a comfortable one', churny.score > small.score);
ok('the reason names the churn risk', churny.reasons.some(r => /high churn risk/i.test(r.label)));

// Unknown must not silently score as best or worst.
const unknown = CD.scoreRequest(Object.assign({}, base, { dueAt: '2026-08-25T09:00:00Z' }), { mrr: 6000 }, { now: NOW });
ok('unknown content health scores between behind and ahead', unknown.score < behind.score && unknown.score > ahead.score);
ok('unknown signals are labelled as unset',
  unknown.reasons.some(r => /Content health not set/.test(r.label)) &&
  unknown.reasons.some(r => /Churn risk not set/.test(r.label)));

// ── Account matching ───────────────────────────────────────────
section('Account matching');

const ACCOUNTS = [
  { id: '1', name: 'Netlify', mrr: 20000, contentHealth: '8', churnRisk: 'Virtually zero likelihood of churn' },
  { id: '2', name: 'Hume AI', mrr: 12000, contentHealth: '5', churnRisk: '50/50 - likelihood of churn' },
  { id: '3', name: 'Axya', mrr: 6000, contentHealth: '9', churnRisk: 'Low likelihood of churn' },
  { id: '4', name: 'HustlePay', mrr: 8000, contentHealth: '2', churnRisk: 'Very high likelihood of churn' },
  { id: '5', name: 'Highwire', mrr: 9000, contentHealth: '4', churnRisk: 'Somewhat high likelihood of churn' }
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
eq('coverage carries content health through for the table', cov.rows.find(r => r.id === '4').contentHealth, '2');
eq('coverage carries churn risk through', cov.rows.find(r => r.id === '4').churnRisk, 'Very high likelihood of churn');

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

// ── Lineage performance ────────────────────────────────────────
section('Lineage performance');

// The uuid in a pasted Lineage URL is the analytics key — that join is
// what lets the queue report how the post Millie wrote actually did.
const refs = CD.lineagePostRefs('<https://app.virio.ai/lineage/hustlepay/9854f302-5161-44a1-9080-56e14282c1f4|x>');
eq('one post ref found', refs.length, 1);
eq('company slug captured', refs[0].company, 'hustlepay');
eq('post uuid captured', refs[0].postId, '9854f302-5161-44a1-9080-56e14282c1f4');
eq('a lineage link without a post id yields no ref',
  CD.lineagePostRefs('<https://app.virio.ai/lineage/minimal|x>').length, 0);
eq('a non-lineage link yields no ref',
  CD.lineagePostRefs('https://docs.google.com/document/d/1Er1').length, 0);
eq('two posts in one ask are both captured', CD.lineagePostRefs(
  'a https://app.virio.ai/lineage/minimal/3ce56c38-0f15-4195-8372-99ea73834374 ' +
  'b https://app.virio.ai/lineage/minimal/2dcce067-e05e-449f-8625-1e344cbfc675').length, 2);

// Real numbers, from the Timur reintroduction post Millie wrote.
// icpRate is carried but Lineage's current per-post surface does not
// return it, so the null case is the one that must behave.
const ANALYTICS = {
  '9854f302-5161-44a1-9080-56e14282c1f4': { likes: 93, comments: 6, reposts: 2, icpRate: 34.5, postedAt: '2026-07-21T16:00:00Z', syncedAt: '2026-08-15T09:57:05Z' },
  '3ce56c38-0f15-4195-8372-99ea73834374': { likes: 10, comments: 1, reposts: 0, icpRate: null, postedAt: '2026-07-24T12:00:00Z', syncedAt: '2026-08-15T09:00:00Z' }
};

const perfReqs = CD.attachPerformance([
  { id: 'a', accountName: 'HustlePay', status: 'done', completedAt: '2026-07-21T09:00:00Z', requestedAt: '2026-07-20T09:00:00Z',
    postRefs: [{ company: 'hustlepay', postId: '9854f302-5161-44a1-9080-56e14282c1f4' }] },
  { id: 'b', accountName: 'Minimal', status: 'done', completedAt: '2026-07-24T09:00:00Z', requestedAt: '2026-07-23T09:00:00Z',
    postRefs: [
      { company: 'minimal', postId: '3ce56c38-0f15-4195-8372-99ea73834374' },
      { company: 'minimal', postId: '2dcce067-e05e-449f-8625-1e344cbfc675' } ] },
  { id: 'c', accountName: 'Netlify', status: 'done', completedAt: '2026-08-01T09:00:00Z', requestedAt: '2026-07-30T09:00:00Z',
    postRefs: [{ company: 'netlify', postId: 'not-in-the-map' }] },
  { id: 'd', accountName: 'Axya', status: 'accepted', requestedAt: '2026-08-17T09:00:00Z', postRefs: [] }
], ANALYTICS);

eq('engagement attached to the matching request', perfReqs[0].performance.engagement, 101);
eq('reactions carried through', perfReqs[0].performance.likes, 93);
eq('reposts carried through', perfReqs[0].performance.reposts, 2);
eq('ICP rate carried through', perfReqs[0].performance.icpRate, 34.5);
eq('publish time carried through for ordering', perfReqs[0].performance.postedAt, '2026-07-21T16:00:00Z');
eq('sync time carried through for staleness', perfReqs[0].performance.syncedAt, '2026-08-15T09:57:05Z');
eq('a request with two posts sums only the measured one', perfReqs[1].performance.engagement, 11);
eq('...and reports how many of its posts were measured', perfReqs[1].performance.measured, 1);
eq('...out of how many it produced', perfReqs[1].performance.posts, 2);
eq('a post with no ICP rate leaves it null rather than zero', perfReqs[1].performance.icpRate, null);
ok('an unpublished post reports no performance rather than zero engagement', perfReqs[2].performance === null);
ok('a request with no Lineage post has no performance', perfReqs[3].performance === null);
ok('impressions are never invented', perfReqs[0].performance.impressions === undefined);

// ICP rate is a percentage, so several posts average rather than sum.
const twoIcp = CD.attachPerformance([{ id: 'x', postRefs: [{ postId: 'p1' }, { postId: 'p2' }] }],
  { p1: { likes: 1, comments: 0, reposts: 0, icpRate: 20 }, p2: { likes: 1, comments: 0, reposts: 0, icpRate: 40 } });
eq('two ICP rates average rather than sum', twoIcp[0].performance.icpRate, 30);
const oneIcp = CD.attachPerformance([{ id: 'x', postRefs: [{ postId: 'p1' }, { postId: 'p2' }] }],
  { p1: { likes: 1, comments: 0, reposts: 0, icpRate: 20 }, p2: { likes: 1, comments: 0, reposts: 0, icpRate: null } });
eq('a post without an ICP rate is left out of the average, not counted as zero', oneIcp[0].performance.icpRate, 20);

const ps = CD.performanceSummary(perfReqs);
eq('measured posts counted', ps.measuredPosts, 2);
eq('total engagement', ps.engagement, 112);
eq('reposts totalled', ps.reposts, 2);
eq('average is per measured post, not per request', ps.avgEngagement, 56);
eq('unmeasured requests are surfaced, not hidden', ps.unmeasuredRequests, 1);
eq('best performer ranked first', ps.top[0].accountName, 'HustlePay');
eq('per-account rollup ranks by engagement', ps.byAccount[0].account, 'HustlePay');
eq('per-account reposts rolled up', ps.byAccount[0].reposts, 2);
eq('newest sync time wins', ps.syncedAt, '2026-08-15T09:57:05Z');

const empty = CD.performanceSummary([]);
eq('an empty queue averages zero rather than dividing by zero', empty.avgEngagement, 0);
eq('...and reports nothing measured', empty.measuredPosts, 0);

// ── Completed, by customer and recency ─────────────────────────
section('Completed, by customer and recency');

const completed = CD.completedByAccount(perfReqs);
eq('only completed work appears', completed.length, 3);
ok('the open request is excluded', !completed.some(g => g.account === 'Axya'));
eq('the most recently finished customer comes first', completed[0].account, 'Netlify');
eq('...then the next most recent', completed[1].account, 'Minimal');
eq('...then the oldest', completed[2].account, 'HustlePay');

const hustle = completed.find(g => g.account === 'HustlePay');
eq('engagement rolled up per customer', hustle.engagement, 101);
eq('reposts rolled up per customer', hustle.reposts, 2);
eq('ICP rate rolled up per customer', hustle.icpRate, 34.5);
eq('post count per customer', hustle.count, 1);
eq('average engagement per measured post', hustle.avgEngagement, 101);

const netlifyGroup = completed.find(g => g.account === 'Netlify');
eq('completed work with no data still appears', netlifyGroup.count, 1);
eq('...and is counted as awaiting data, not as zero engagement', netlifyGroup.awaiting, 1);
eq('...so its ICP rate stays null', netlifyGroup.icpRate, null);
eq('...and its average engagement is null, not 0', netlifyGroup.avgEngagement, null);

// Recency uses the post's publish time when there is one, because that is
// when the work actually landed in front of an audience.
const ordering = CD.completedByAccount(CD.attachPerformance([
  { id: 'p', accountName: 'Early ticked, late posted', status: 'done', completedAt: '2026-07-01T09:00:00Z', postRefs: [{ postId: 'z' }] },
  { id: 'q', accountName: 'Later ticked, no post', status: 'done', completedAt: '2026-07-10T09:00:00Z', postRefs: [] }
], { z: { likes: 1, comments: 0, reposts: 0, postedAt: '2026-07-20T09:00:00Z' } }));
eq('publish time beats tick time for ordering', ordering[0].account, 'Early ticked, late posted');

// Several posts for one customer sort newest first inside the group.
const multi = CD.completedByAccount(CD.attachPerformance([
  { id: '1', accountName: 'Acme', status: 'done', completedAt: '2026-07-01T09:00:00Z', postRefs: [] },
  { id: '2', accountName: 'Acme', status: 'done', completedAt: '2026-08-01T09:00:00Z', postRefs: [] },
  { id: '3', accountName: 'Acme', status: 'done', completedAt: '2026-07-15T09:00:00Z', postRefs: [] }
], {}));
eq('one group for the customer', multi.length, 1);
eq('three posts in it', multi[0].count, 3);
eq('newest post first', multi[0].items[0].id, '2');
eq('oldest post last', multi[0].items[2].id, '1');

eq('nothing completed yields no groups', CD.completedByAccount([]).length, 0);

// ── Drafts Millie wrote in Lineage ─────────────────────────────
// The fixtures below are verbatim lines from Lineage's own activity
// log (Sourcera, 2026-08-18), so the parser is tested against the
// shape the log actually emits.
section('Lineage-authored drafts');

const LINEAGE_MILLIE = '82d663fe-f00e-4892-ad16-37ac9837d7f7';
const LOG_LINES = [
  '{"source":"platform","role":"system","content":"draft.created","actor":"82d663fe-f00e-4892-ad16-37ac9837d7f7","ts":"2026-08-18T09:46:39.786678+00:00","event_type":"draft.created","entity_type":"draft","entity_id":"1BEE7A28-DACF-4EE8-84F3-856F4F307C29","title":"Smaller VCs in SF"}',
  '{"source":"platform","role":"system","content":"draft.status_changed","actor":"82d663fe-f00e-4892-ad16-37ac9837d7f7","ts":"2026-08-18T10:47:01.25592+00:00","event_type":"draft.status_changed","entity_type":"draft","entity_id":"569cb8f2-832e-4e65-806e-523f3a50a883","to":"editing","from":"draft","override":true}',
  '{"source":"platform","role":"system","content":"draft.created","actor":"aa62072f-c148-41b5-a9e9-194824f1a3fe","ts":"2026-06-29T11:47:57.031946+00:00","event_type":"draft.created","entity_type":"draft","entity_id":"b538296a-5797-42bd-bb07-f5e8c66237ae","title":"","user_id":"d4177fcc-09b7-451b-8ac9-5994a6be5b83"}'
].join('\n');

const parseLog = require('./netlify/functions/lineage-drafts.js').parseLog;
const SINCE = new Date('2026-01-01T00:00:00Z');

const mine = parseLog(LOG_LINES, 'sourcera', LINEAGE_MILLIE, ['draft.created'], SINCE);
eq('only the author’s draft.created is kept', mine.length, 1);

// The default counts every draft.* event, not just authorship. Measured
// over 2026-07-08..09-02 Millie created 1 draft and worked 45: she moves
// existing drafts through review and scheduling rather than starting them,
// so a draft.created-only count would report 1 post of work.
const anyDraft = parseLog(LOG_LINES, 'sourcera', LINEAGE_MILLIE, [], SINCE);
eq('an empty event list means every draft.* event', anyDraft.length, 2);
ok('the status change is included by default',
  anyDraft.some(d => d.postId === '569cb8f2-832e-4e65-806e-523f3a50a883'));
eq('another author is still excluded by default',
  anyDraft.filter(d => d.postId === 'b538296a-5797-42bd-bb07-f5e8c66237ae').length, 0);
eq('post id is lowercased so it matches a url', mine[0].postId, '1bee7a28-dacf-4ee8-84f3-856f4f307c29');
eq('company travels with the event', mine[0].company, 'sourcera');
eq('title comes through', mine[0].title, 'Smaller VCs in SF');

// Millie's real footprint on Sourcera is status changes, not authorship.
// Counting those as work she created would credit her with somebody
// else's draft, so they are only ever counted when explicitly asked for.
eq('status changes are not drafts she wrote',
  parseLog(LOG_LINES, 'sourcera', LINEAGE_MILLIE, ['draft.created'], SINCE)
    .filter(d => d.postId === '569cb8f2-832e-4e65-806e-523f3a50a883').length, 0);
eq('but they can be counted on request',
  parseLog(LOG_LINES, 'sourcera', LINEAGE_MILLIE, ['draft.created', 'draft.status_changed'], SINCE).length, 2);

eq('another author’s draft is never attributed to her',
  mine.filter(d => d.postId === 'b538296a-5797-42bd-bb07-f5e8c66237ae').length, 0);

eq('events older than the window are dropped',
  parseLog(LOG_LINES, 'sourcera', LINEAGE_MILLIE, ['draft.created'], new Date('2026-09-01T00:00:00Z')).length, 0);

// A wrong endpoint must not read as "she wrote nothing".
ok('a non-activity payload is rejected rather than counted as zero',
  parseLog('{"results":[{"name":"Acme","account_health":"green"}]}', 'x', LINEAGE_MILLIE, ['draft.created'], SINCE) === null);
ok('an empty body is rejected',
  parseLog('', 'x', LINEAGE_MILLIE, ['draft.created'], SINCE) === null);
ok('an html error page is rejected',
  parseLog('<!doctype html><title>404</title>', 'x', LINEAGE_MILLIE, ['draft.created'], SINCE) === null);
ok('a log with no events by this author parses to an empty list, not null',
  Array.isArray(parseLog(LOG_LINES, 'sourcera', 'someone-else', ['draft.created'], SINCE)));

// A truncated final line is normal for a streamed log and must not
// discard the events that did arrive.
eq('a torn last line does not lose the good ones',
  parseLog(LOG_LINES + '\n{"source":"platform","actor":"82d6', 'sourcera', LINEAGE_MILLIE, ['draft.created'], SINCE).length, 1);

// ── Lineage drafts become completed rows ───────────────────────
section('Lineage drafts in the Completed bucket');

const draftEvents = [
  { company: 'sourcera', postId: 'aaaa1111-0000-4000-8000-000000000001', ts: '2026-08-18T09:46:39Z', title: 'Smaller VCs in SF' },
  { company: 'minimal',  postId: 'bbbb2222-0000-4000-8000-000000000002', ts: '2026-08-20T11:00:00Z', title: null }
];

const stubs = CD.lineageDraftsToRequests(draftEvents, {});
eq('one row per draft', stubs.length, 2);
eq('id is stable so a correction survives a refresh', stubs[0].id, 'lineage:aaaa1111-0000-4000-8000-000000000001');
eq('lands as completed work', stubs[0].slackStatus, 'done');
eq('marked as coming from Lineage', stubs[0].source, 'lineage');
eq('carries a post ref so engagement can attach later', stubs[0].postRefs[0].postId, 'aaaa1111-0000-4000-8000-000000000001');
eq('links back to the post in Lineage', stubs[0].permalink,
  'https://app.virio.ai/lineage/sourcera/aaaa1111-0000-4000-8000-000000000001');
eq('an untitled draft still reads as something', stubs[1].text, 'Draft written in Lineage');
eq('the client slug is kept for account matching', stubs[1].clientSlug, 'minimal');
eq('a repeated event is only counted once',
  CD.lineageDraftsToRequests(draftEvents.concat([draftEvents[0]]), {}).length, 2);

// Several events on one draft — created, edited, scheduled — are one piece
// of work, and the row carries the most recent touch because the feed
// arrives newest first.
const manyTouches = CD.lineageDraftsToRequests([
  { company: 'percents', postId: 'cccc3333-0000-4000-8000-000000000003', ts: '2026-08-26T13:32:00Z' },
  { company: 'percents', postId: 'cccc3333-0000-4000-8000-000000000003', ts: '2026-08-20T07:31:00Z' },
  { company: 'percents', postId: 'cccc3333-0000-4000-8000-000000000003', ts: '2026-07-12T18:31:00Z' }
], {});
eq('one row for a draft she touched three times', manyTouches.length, 1);
eq('and it is dated by her most recent touch', manyTouches[0].requestedAt, '2026-08-26T13:32:00Z');
eq('no drafts is not an error', CD.lineageDraftsToRequests(null, {}).length, 0);

const LINEAGE_ACCOUNTS = [
  { id: 'a1', name: 'Sourcera', mrr: 6000 },
  { id: 'a2', name: 'Minimal', mrr: 9000 }
];

const withDrafts = CD.buildRequests([], {}, LINEAGE_ACCOUNTS, { lineageDrafts: draftEvents });
eq('both drafts reach the request list', withDrafts.length, 2);
eq('the slug matched a HubSpot account', withDrafts[0].accountName, 'Sourcera');
eq('and it is done, so it sits in Completed', withDrafts[0].status, 'done');

// The same post asked for in Slack AND written in Lineage is one piece
// of work. Showing it twice would inflate the week's delivered volume.
const askMsg = {
  ts: ts('2026-08-17T09:00:00Z'),
  user: 'U0AQTDE8GRY',
  userName: 'Maxwell',
  text: 'Could I get a post for Sourcera about smaller VCs? <https://app.virio.ai/lineage/sourcera/aaaa1111-0000-4000-8000-000000000001|link>',
  reactions: [{ name: 'large_green_circle' }]
};
const merged = CD.buildRequests([askMsg], {}, LINEAGE_ACCOUNTS, Object.assign({}, OPTS, { lineageDrafts: draftEvents }));
eq('the duplicate is dropped, not shown twice', merged.length, 2);
eq('the Slack request is the one kept', merged.filter(r => r.source === 'lineage').length, 1);
ok('the surviving Lineage row is the one nobody asked for',
  merged.filter(r => r.source === 'lineage')[0].postRefs[0].postId === 'bbbb2222-0000-4000-8000-000000000002');

// Ticking a Lineage-sourced row off still works, because the id is stable.
const corrected = CD.buildRequests([], { 'lineage:bbbb2222-0000-4000-8000-000000000002': { status: 'accepted' } },
  LINEAGE_ACCOUNTS, { lineageDrafts: draftEvents });
eq('a dashboard override beats the Lineage default',
  corrected.find(r => r.id === 'lineage:bbbb2222-0000-4000-8000-000000000002').status, 'accepted');

// And they group into the Completed widget like any other finished work.
const lineageGroups = CD.completedByAccount(CD.attachPerformance(withDrafts, {}));
eq('two customers in the completed widget', lineageGroups.length, 2);
eq('newest account first', lineageGroups[0].account, 'Minimal');

// ── The August floor and the shipped snapshot ──────────────────
section('Window and snapshot');

const snap = require('./netlify/functions/_lineage-snapshot.js');
eq('the snapshot declares the window it was cut for', snap.since, '2026-08-01');
ok('and when it was captured', /^\d{4}-\d{2}-\d{2}$/.test(snap.capturedAt));
ok('every snapshot row is on or after the floor',
  snap.drafts.every(d => d.ts >= '2026-08-01'));
ok('every snapshot row can be turned into a completed item',
  CD.lineageDraftsToRequests(snap.drafts, {}).every(r =>
    r.slackStatus === 'done' && r.source === 'lineage' && r.postRefs.length === 1));
eq('the snapshot dedupes to one row per draft',
  CD.lineageDraftsToRequests(snap.drafts, {}).length, snap.drafts.length);

// The floor is a fixed date, not a rolling window: a rolling one would
// quietly drop the early weeks out of the total as time passed.
eq('events before the floor are dropped',
  parseLog(LOG_LINES, 'sourcera', LINEAGE_MILLIE, [], new Date('2026-08-19T00:00:00Z')).length, 0);
eq('events on or after it are kept',
  parseLog(LOG_LINES, 'sourcera', LINEAGE_MILLIE, [], new Date('2026-08-01T00:00:00Z')).length, 2);

// ── Summary ────────────────────────────────────────────────────
console.log('\n' + (failed === 0 ? '✓ ' : '✗ ') + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
