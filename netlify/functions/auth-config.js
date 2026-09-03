// What the sign-in screen needs to talk to Supabase.
//
// Both values are public by design: the project URL and its anon key are
// meant to ship to browsers. They are served from here rather than written
// into index.html because this repo is public, and because a deploy pointed
// at a different project must not need a code change.
//
// This is the one route that cannot require a session — the page reads it
// in order to build one.

const { allowedDomain, callbackPath } = require('./_auth.js');

exports.handler = async function () {
  const supabaseUrl = process.env.SUPABASE_URL || null;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || null;
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      configured: !!(supabaseUrl && supabaseAnonKey),
      supabaseUrl,
      supabaseAnonKey,
      allowedDomain: allowedDomain(),
      callbackPath: callbackPath(),
      // Netlify sets URL to the site's canonical address and DEPLOY_PRIME_URL
      // to this particular deploy's. Neither is used to build the redirect —
      // the browser's own origin is, so previews and localhost work without
      // configuration. They are returned only so a failed sign-in can say
      // which origin it asked for, which is the one fact that diagnoses an
      // allowlist miss.
      deployUrl: process.env.DEPLOY_PRIME_URL || process.env.URL || null
    })
  };
};
