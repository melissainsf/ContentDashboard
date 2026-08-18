// Virio CS Dashboard - HubSpot serverless function v2
exports.handler = async function(event, context) {
  const token = process.env.HUBSPOT_TOKEN;

  if (!token) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'HUBSPOT_TOKEN environment variable is not set.' })
    };
  }

  const requestBody = {
    // Two filter groups are OR'd together: keep every pilot-tracked company the
    // dashboard already shows, PLUS every account whose lifecyclestage is the
    // source of truth for the NRR cohort — "customer" (current, in-pilot or post-
    // pilot) or "Churned" (HubSpot custom-stage internal id 1271359806). Pulling
    // churned accounts via the lifecycle field means their churn is captured even
    // if pilot_status is missing. Opportunity/lead/other stages are never matched
    // here, so a mis-tagged churn (lifecyclestage=other) stays off until re-tagged.
    filterGroups: [
      {
        filters: [{
          propertyName: 'pilot_status',
          operator: 'IN',
          values: ['In progress', 'Converted', 'Exited During Pilot', 'Churned Post Conversion']
        }]
      },
      {
        filters: [{
          propertyName: 'lifecyclestage',
          operator: 'IN',
          values: ['customer', '1271359806']
        }]
      }
    ],
    properties: [
      'name', 'pilot_status', 'lifecyclestage', 'stage', 'mrr', 'expansion_mrr',
      'churned_mrr_value', 'churn_reason', 'churn_date', 'domain', 'csm',
      'kickoff_call_date', 'first_post_date', 'vertical', 'customer_journey',
      'content_manager', 'posts_per_month', 'product', 'upsold_products',
      'success_criteria'
    ],
    limit: 200
  };

  try {
    const res = await fetch('https://api.hubapi.com/crm/v3/objects/companies/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify(requestBody)
    });

    const data = await res.json();

    return {
      statusCode: res.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify(data)
    };
  } catch(e) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: e.message })
    };
  }
};
