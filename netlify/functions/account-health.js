// Millie's Content Dashboard — account health colours (read).
//
// Health is NOT owned by this site. The AMs set red/yellow/green/blue on
// the CS dashboard, and those colours feed the content queue's ranking —
// a wobbling account earns content attention ahead of a comfortable one.
//
// Netlify Blobs stores are per-site, so reading this site's own store
// would give a permanently empty map and quietly flatten that whole
// ranking signal. Instead, proxy the CS dashboard's public endpoint:
//
//   CS_DASHBOARD_URL   e.g. https://viriodash.netlify.app
//
// The upstream endpoint already sends Access-Control-Allow-Origin: * and
// is read-only, so nothing is being worked around here.
//
// With CS_DASHBOARD_URL unset the function falls back to this site's own
// Blobs store, which is empty until somebody writes to it. That is a
// working-but-degraded state, so it is reported in `source` and the
// dashboard says so rather than showing every account as "not set" as
// though the AMs had never triaged anything.
//
// GET -> { map: { [hubspotCompanyId]: "red"|"yellow"|"green"|"blue" },
//          source: "cs-dashboard" | "local" | "none", note: string|null }

exports.handler = async function (event) {
  const upstream = (process.env.CS_DASHBOARD_URL || '').replace(/\/+$/, '');

  if (upstream) {
    try {
      const res = await fetch(upstream + '/api/account-health', {
        headers: { Accept: 'application/json' }
      });
      if (!res.ok) throw new Error('upstream returned ' + res.status);
      const data = await res.json();
      const map = (data && data.map && typeof data.map === 'object') ? data.map : {};
      return reply({
        map,
        source: 'cs-dashboard',
        note: Object.keys(map).length ? null : 'The CS dashboard returned no health colours.'
      });
    } catch (e) {
      // Fall through to the local store rather than failing the whole
      // page load — health is one ranking signal, not the queue itself.
      console.log('account-health: upstream read failed —', e.message);
      const local = await readLocal(event);
      return reply({
        map: local,
        source: 'local',
        note: 'Could not reach the CS dashboard (' + e.message + '), so health may be stale or missing.'
      });
    }
  }

  const local = await readLocal(event);
  return reply({
    map: local,
    source: Object.keys(local).length ? 'local' : 'none',
    note: Object.keys(local).length
      ? null
      : 'CS_DASHBOARD_URL is not set, so account health is unavailable and is not counted in ranking.'
  });
};

async function readLocal(event) {
  try {
    const { connectLambda, getStore } = require('@netlify/blobs');
    if (typeof connectLambda === 'function') connectLambda(event);
    const store = getStore('account-health');
    const stored = await store.get('map', { type: 'json' });
    return (stored && typeof stored === 'object') ? stored : {};
  } catch (e) {
    console.log('account-health: local Blobs read failed —', e.message);
    return {};
  }
}

function reply(body) {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(body)
  };
}
