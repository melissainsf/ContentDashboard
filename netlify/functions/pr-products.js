// Virio Product Request Tracker - deal product enrichment.
//
// Returns a map of HubSpot company id -> { product, closeDate } so the tracker
// can tag each account as EGC vs Full Service and derive pilot/renewal dates.
//
// The "Product" field is a custom deal property, so rather than hardcode its
// internal name we auto-discover it: the deal property whose dropdown options
// include "EGC" / "Full Service". Everything is best-effort — on any failure we
// return an empty map and the board still renders (accounts show "Unspecified").
//
// Requires HUBSPOT_TOKEN with crm.objects.deals.read + crm.schemas.deals.read.
// Optional override: HS_DEAL_PRODUCT_PROP forces a specific property internal name.

const HS = 'https://api.hubapi.com';

exports.handler = async function () {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) return reply({ map: {}, note: 'HUBSPOT_TOKEN not configured' });

  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };

  try {
    const prop = process.env.HS_DEAL_PRODUCT_PROP || (await discoverProductProperty(headers));
    if (!prop) return reply({ map: {}, note: 'Could not locate an EGC/Full Service deal property' });

    // Page through closed-won deals, collecting the product + close date.
    const deals = [];
    let after;
    for (let i = 0; i < 30; i++) {
      const body = {
        filterGroups: [{ filters: [{ propertyName: 'hs_is_closed_won', operator: 'EQ', value: 'true' }] }],
        properties: [prop, 'closedate'],
        limit: 100,
        ...(after ? { after } : {})
      };
      const res = await fetch(`${HS}/crm/v3/objects/deals/search`, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) break;
      const data = await res.json();
      (data.results || []).forEach(d => deals.push({ id: d.id, product: d.properties[prop], closeDate: d.properties.closedate }));
      after = data.paging && data.paging.next && data.paging.next.after;
      if (!after) break;
    }
    if (!deals.length) return reply({ map: {}, property: prop, note: 'No closed-won deals found' });

    // Resolve each deal's associated company (batch, 100 at a time).
    const map = {};
    for (let i = 0; i < deals.length; i += 100) {
      const batch = deals.slice(i, i + 100);
      const res = await fetch(`${HS}/crm/v4/associations/deals/companies/batch/read`, {
        method: 'POST', headers, body: JSON.stringify({ inputs: batch.map(d => ({ id: d.id })) })
      });
      if (!res.ok) continue;
      const data = await res.json();
      const dealById = Object.fromEntries(batch.map(d => [d.id, d]));
      (data.results || []).forEach(r => {
        const dealId = r.from && r.from.id;
        const companyId = r.to && r.to[0] && r.to[0].toObjectId;
        const deal = dealById[dealId];
        if (!companyId || !deal) return;
        const prev = map[companyId];
        // Prefer the most recent closed-won deal for a company.
        if (!prev || (deal.closeDate && deal.closeDate > prev.closeDate)) {
          map[companyId] = { product: normalizeProduct(deal.product), closeDate: deal.closeDate || null };
        }
      });
    }
    return reply({ map, property: prop, deals: deals.length });
  } catch (e) {
    return reply({ map: {}, note: e.message });
  }
};

async function discoverProductProperty(headers) {
  const res = await fetch(`${HS}/crm/v3/properties/deals`, { headers });
  if (!res.ok) return null;
  const data = await res.json();
  const props = data.results || [];
  // Best match: an enumeration whose options look like EGC / Full Service.
  const scored = props
    .filter(p => Array.isArray(p.options) && p.options.length)
    .map(p => {
      const opts = p.options.map(o => (o.label || o.value || '').toLowerCase());
      const hasEgc = opts.some(o => o.includes('egc') || o.includes('employee generated'));
      const hasFull = opts.some(o => o.includes('full service') || o.includes('full-service'));
      const labelIsProduct = (p.label || '').toLowerCase() === 'product';
      return { name: p.name, score: (hasEgc ? 2 : 0) + (hasFull ? 2 : 0) + (labelIsProduct ? 1 : 0) };
    })
    .filter(p => p.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.length ? scored[0].name : null;
}

function normalizeProduct(v) {
  if (!v) return null;
  const s = String(v).toLowerCase();
  if (s.includes('egc') || s.includes('employee generated')) return 'EGC';
  if (s.includes('full')) return 'Full Service';
  return v;
}

function reply(body) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body)
  };
}
