// Millie's Content Dashboard — the client book, from HubSpot.
//
// Everything the queue needs to rank a request lives on the HubSpot
// company record, so this is the dashboard's only account dependency:
//
//   mrr / expansion_mrr    how much the account is worth
//   content_health_score   "Are we on track with their content? The goal
//                          is to be 30 days ahead." 1-10, low = behind
//   csm_sentiment          churn risk, 1-10, low = more likely to churn
//   posts_per_month        the cadence the customer is paying for
//   content_manager        the Content Engineer who owns their content
//   product/upsold_products  EGC, Full Service, Rev Share, Launch, FOCs
//
// Only live customers are returned — a churned account cannot be given
// content attention and would pad the coverage table with dead rows.
//
// Requires HUBSPOT_TOKEN with crm.objects.companies.read.
//
// GET -> { accounts: [...], count, note: string|null }

const HS = 'https://api.hubapi.com';

// HubSpot's custom "Churned" lifecycle stage id. Excluded explicitly
// because the stage reads as an opaque numeric id, not a word.
const CHURNED_STAGE = '1271359806';

const PROPERTIES = [
  'name', 'domain', 'mrr', 'expansion_mrr', 'lifecyclestage', 'pilot_status',
  'content_health_score', 'csm_sentiment', 'posts_per_month',
  'content_manager', 'csm', 'product', 'upsold_products', 'customer_journey'
];

const { requireVirioUser } = require('./_auth.js');

exports.handler = async function (event) {
  const gate = await requireVirioUser(event);
  if (!gate.ok) return gate.response;

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) {
    return reply(500, { accounts: [], count: 0, error: 'HUBSPOT_TOKEN is not set.' });
  }

  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };

  try {
    const results = [];
    let after;
    // Page rather than assuming one request covers the book — silently
    // truncating at 100 would drop clients off the coverage table, which
    // is the one view whose whole job is to be complete.
    for (let page = 0; page < 20; page++) {
      const body = {
        filterGroups: [{
          filters: [{ propertyName: 'lifecyclestage', operator: 'EQ', value: 'customer' }]
        }],
        properties: PROPERTIES,
        limit: 100,
        ...(after ? { after } : {})
      };
      const res = await fetch(`${HS}/crm/v3/objects/companies/search`, {
        method: 'POST', headers, body: JSON.stringify(body)
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HubSpot ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = await res.json();
      (data.results || []).forEach(r => results.push(r));
      after = data.paging && data.paging.next && data.paging.next.after;
      if (!after) break;
    }

    const accounts = results
      .filter(r => {
        const p = r.properties || {};
        return p.lifecyclestage !== CHURNED_STAGE
          && p.pilot_status !== 'Exited During Pilot'
          && p.pilot_status !== 'Churned Post Conversion'
          && p.domain !== 'virio.ai' && p.name !== 'Virio';
      })
      .map(r => {
        const p = r.properties || {};
        return {
          id: r.id,
          name: p.name || p.domain || r.id,
          mrr: (parseFloat(p.mrr) || 0) + (parseFloat(p.expansion_mrr) || 0),
          contentHealth: p.content_health_score || null,
          churnRisk: p.csm_sentiment || null,
          postsPerMonth: p.posts_per_month || null,
          contentManager: p.content_manager || null,
          am: p.csm || null,
          products: [p.product, p.upsold_products].filter(Boolean).join(', '),
          journey: p.customer_journey || null
        };
      })
      .sort((a, b) => b.mrr - a.mrr || a.name.localeCompare(b.name));

    return reply(200, { accounts, count: accounts.length, note: null });
  } catch (e) {
    return reply(500, { accounts: [], count: 0, error: e.message });
  }
};

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
