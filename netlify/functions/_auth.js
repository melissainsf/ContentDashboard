// The gate every /api/* function passes through.
//
// The dashboard serves the client book — names, MRR, content health, churn
// risk — and the functions hold the tokens that read it. So the check runs
// HERE, on the server, in front of the data. The sign-in screen in the page
// is a convenience; it is not the boundary. A previous version of this
// dashboard put the whole gate in the browser, which hid the UI while
// leaving every one of these routes open to anyone with the URL.
//
// The caller presents the Supabase access token from a Google sign-in. This
// module asks Supabase who that token belongs to — signature, expiry and
// revocation are all Supabase's answer, not ours — and then requires the
// verified email to be on the allowed domain.
//
// Netlify environment variables:
//   SUPABASE_URL           (required) the auth project, e.g. https://<ref>.supabase.co
//   SUPABASE_ANON_KEY      (required) the project's public anon key
//   AUTH_ALLOWED_DOMAIN    (optional) default "virio.ai"

const DEFAULT_DOMAIN = 'virio.ai';
const DEFAULT_CALLBACK_PATH = '/auth/callback';

function allowedDomain() {
  return String(process.env.AUTH_ALLOWED_DOMAIN || DEFAULT_DOMAIN).toLowerCase();
}

/**
 * Where the OAuth provider sends the visitor back to. The ORIGIN is never
 * configured — the page uses whatever it is being served from, so localhost
 * on any port, the production site and every deploy preview all work with no
 * code change. Only the path is fixed, because the auth project's allowlist
 * matches on it: `http://localhost:*\/auth/callback` covers every local port
 * precisely because the path is the constant half.
 *
 * If this ever changes, the rewrite in netlify.toml has to change with it —
 * the path has to serve the page for the callback to be readable.
 */
function callbackPath() {
  const raw = String(process.env.AUTH_CALLBACK_PATH || DEFAULT_CALLBACK_PATH).trim();
  return raw.startsWith('/') ? raw : '/' + raw;
}

function deny(statusCode, error) {
  return {
    ok: false,
    response: {
      statusCode,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error })
    }
  };
}

function bearerToken(event) {
  const headers = (event && event.headers) || {};
  // Netlify lowercases header names, but a direct handler call in a test
  // may not, so both spellings are read.
  const raw = headers.authorization || headers.Authorization || '';
  return raw.startsWith('Bearer ') ? raw.slice(7).trim() : '';
}

/**
 * Resolve the caller, or return the response to send instead.
 *
 * 401 means "no usable token" — not signed in, or the session expired.
 * 403 means "signed in, wrong person" — a real Google account outside the
 * allowed domain. The page treats them differently: 401 shows the sign-in
 * screen again, 403 says the account is not permitted.
 */
async function requireVirioUser(event) {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  // Fail closed. A missing auth configuration must never read as "no gate
  // needed" — that is how a deploy quietly serves the client book to
  // anybody.
  if (!url || !anonKey) {
    return deny(500, 'Auth is not configured on this deploy (SUPABASE_URL / SUPABASE_ANON_KEY).');
  }

  const token = bearerToken(event);
  if (!token) return deny(401, 'Sign in to use this dashboard.');

  let res;
  try {
    res = await fetch(url.replace(/\/+$/, '') + '/auth/v1/user', {
      headers: { apikey: anonKey, Authorization: 'Bearer ' + token }
    });
  } catch (e) {
    // Reaching the auth server failed. That is not proof the caller is
    // valid, so it stays a refusal — 503, because retrying can work.
    return deny(503, 'Could not reach the auth service (' + e.message + ').');
  }

  if (!res.ok) return deny(401, 'Your session is not valid. Sign in again.');

  let user;
  try {
    user = await res.json();
  } catch {
    return deny(503, 'The auth service returned an unreadable response.');
  }

  const email = String((user && user.email) || '').toLowerCase();
  const domain = allowedDomain();
  if (!email.endsWith('@' + domain)) {
    return deny(403, 'Access is restricted to @' + domain + ' accounts.');
  }

  return { ok: true, user: { id: user.id, email } };
}

module.exports = { requireVirioUser, allowedDomain, callbackPath, bearerToken };
