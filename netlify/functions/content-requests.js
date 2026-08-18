// Millie's Content Dashboard — read the #content-support request feed.
//
// Pulls raw message history from the Slack channel the team already uses
// for content requests and returns it alongside the dashboard's own
// stored state. All parsing happens client-side in content-dashboard.js,
// so this function stays a thin, cacheable transport.
//
// Netlify env vars:
//   SLACK_BOT_TOKEN            xoxb-… token for a Slack app in the workspace
//   SLACK_CONTENT_CHANNEL_ID   channel id (default: #content-support)
//   SLACK_CONTENT_OWNER_IDS    comma-separated user ids whose messages are
//                              NOT requests (default: Millie's id)
//   SLACK_CONTENT_DAYS         how far back to read (default 120)
//
// The Slack app needs channels:history + groups:history (the channel is
// private, so groups:history is the one that matters), plus users:read to
// resolve author names, and it must be invited to the channel itself.
//
// GET -> {
//   messages: [{ ts, user, user_name, text, reactions, permalink, thread_reply_count }],
//   overrides: { [requestId]: { status, completedAt, clientId, ... } },
//   ownerIds: [...],
//   channel: { id, name } | null,
//   configured: boolean,
//   note: string | null
// }
//
// Slack being unreachable is reported in `note` with configured:false
// rather than as a 500 — the dashboard still renders its stored state and
// says plainly that the live feed is missing, instead of showing an empty
// queue that looks like "no work".

const DEFAULT_CHANNEL = 'C0BFY7Y3MK7';   // #content-support
const DEFAULT_OWNERS  = 'U0A2VGT6NRL';   // Millie Hanson — she does the work, not the asking
const SLACK = 'https://slack.com/api';

exports.handler = async function (event) {
  const overrides = await readOverrides(event);

  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CONTENT_CHANNEL_ID || DEFAULT_CHANNEL;
  const ownerIds = (process.env.SLACK_CONTENT_OWNER_IDS || DEFAULT_OWNERS)
    .split(',').map(s => s.trim()).filter(Boolean);

  if (!token) {
    return reply(200, {
      messages: [], overrides, ownerIds, channel: null, configured: false,
      note: 'SLACK_BOT_TOKEN is not set — showing stored requests only. Add the token in Netlify to pull live requests from #content-support.'
    });
  }

  const days = Number(process.env.SLACK_CONTENT_DAYS) || 120;
  const oldest = Math.floor((Date.now() - days * 86400000) / 1000);

  try {
    const messages = await fetchHistory(token, channel, oldest);
    const names = await resolveUserNames(token, messages);
    messages.forEach(m => { m.user_name = names[m.user] || m.user_name || m.user || 'Unknown'; });

    return reply(200, {
      messages,
      overrides,
      ownerIds,
      channel: { id: channel, name: process.env.SLACK_CONTENT_CHANNEL_NAME || 'content-support' },
      configured: true,
      note: null
    });
  } catch (e) {
    // Same reasoning as above: degrade to stored state with a loud note.
    return reply(200, {
      messages: [], overrides, ownerIds, channel: { id: channel },
      configured: false,
      note: 'Could not read Slack: ' + e.message
    });
  }
};

// Page through conversations.history. Slack caps page size at 1000; the
// channel sees a handful of messages a week, so a few pages is plenty.
async function fetchHistory(token, channel, oldest) {
  const out = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ channel, limit: '200', oldest: String(oldest) });
    if (cursor) params.set('cursor', cursor);

    const res = await fetch(`${SLACK}/conversations.history?${params}`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    const data = await res.json();
    if (!data.ok) throw new Error(slackError(data.error, channel));

    (data.messages || []).forEach(m => {
      // Thread replies are conversation about a request, not new requests.
      if (m.thread_ts && m.thread_ts !== m.ts) return;
      out.push({
        ts: m.ts,
        user: m.user || (m.bot_id ? 'bot:' + m.bot_id : null),
        user_name: m.username || null,
        text: m.text || '',
        subtype: m.subtype || null,
        reactions: (m.reactions || []).map(r => ({ name: r.name, count: r.count })),
        thread_reply_count: m.reply_count || 0,
        has_files: !!(m.files && m.files.length)
      });
    });

    cursor = data.response_metadata && data.response_metadata.next_cursor;
    if (!cursor) break;
  }

  // Permalinks are built rather than fetched — one API call per message
  // would be dozens of round trips for a link the UI may never open.
  const team = process.env.SLACK_WORKSPACE || 'virio-workspace';
  out.forEach(m => {
    m.permalink = `https://${team}.slack.com/archives/${channel}/p${String(m.ts).replace('.', '')}`;
  });
  return out;
}

// Resolve author ids to display names in one batched pass.
async function resolveUserNames(token, messages) {
  const ids = [...new Set(messages.map(m => m.user).filter(u => u && !u.startsWith('bot:')))];
  const names = {};
  await Promise.all(ids.map(async id => {
    try {
      const res = await fetch(`${SLACK}/users.info?user=${encodeURIComponent(id)}`, {
        headers: { Authorization: 'Bearer ' + token }
      });
      const data = await res.json();
      if (data.ok && data.user) {
        const p = data.user.profile || {};
        names[id] = p.real_name || p.display_name || data.user.real_name || data.user.name || id;
      }
    } catch { /* a missing name is cosmetic — the request still shows */ }
  }));
  return names;
}

// Turn Slack's terse error codes into something actionable in the UI.
function slackError(code, channel) {
  const hints = {
    not_in_channel: `the bot is not a member of ${channel} — invite it with /invite @<app> in #content-support`,
    channel_not_found: `channel ${channel} not found — check SLACK_CONTENT_CHANNEL_ID, and that the bot can see private channels`,
    missing_scope: 'the Slack app is missing a scope — it needs groups:history (private channels), channels:history and users:read',
    invalid_auth: 'SLACK_BOT_TOKEN was rejected — regenerate it in the Slack app config',
    account_inactive: 'the Slack app token belongs to a deactivated account'
  };
  return hints[code] || ('Slack API error: ' + code);
}

async function readOverrides(event) {
  try {
    const { connectLambda, getStore } = require('@netlify/blobs');
    if (typeof connectLambda === 'function') connectLambda(event);
    const store = getStore('content-requests');
    const stored = await store.get('map', { type: 'json' });
    return (stored && typeof stored === 'object') ? stored : {};
  } catch (e) {
    console.log('content-requests: Blobs read failed —', e.message);
    return {};
  }
}

function reply(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(body)
  };
}
