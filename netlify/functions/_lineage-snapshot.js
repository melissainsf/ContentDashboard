// Snapshot of Millie's Lineage draft activity, captured 2026-09-02.
//
// WHY A SNAPSHOT EXISTS
// lineage-drafts.js reads Lineage's activity log live, but the REST path
// that serves it has never been confirmed (see that file's header), so in
// production it currently reaches nothing. Without this, the Completed
// bucket silently reports only the Slack queue — 23 requests — and reads
// as though Millie had done a fraction of her actual work.
//
// These rows were read from Lineage's own per-company activity logs via
// the MCP workspace on 2026-09-02, filtered to Millie Hanson's actor id
// (82d663fe-f00e-4892-ad16-37ac9837d7f7) and to draft.* events from
// 2026-08-01 onward, deduped to one entry per draft and dated by her most
// recent touch on it.
//
// IT IS A SNAPSHOT, NOT A FEED. It does not update. The function serves it
// ONLY when the live endpoint cannot be reached, always marks the response
// source:"snapshot" with this capture date, and the dashboard says so on
// screen. The moment LINEAGE_ACTIVITY_URL points at the real path, live
// data wins and this file stops being read. Delete it then.
//
// It is also a FLOOR. A busy account's activity log is capped near 2,000
// events and keeps the OLDEST, so ten of the twenty-one readable accounts
// — Sybill and Watt Data among them, her two busiest in July — have logs
// that stop before 1 August and contribute nothing here. Their August work
// is real and uncounted.

exports.capturedAt = '2026-09-02';
exports.since = '2026-08-01';
exports.drafts = [
  {
    "company": "concord-visa",
    "postId": "ce13f70e-6308-4bce-bca1-ac3011c76e4b",
    "ts": "2026-08-28T16:14:39.066259+00:00",
    "title": null
  },
  {
    "company": "percents",
    "postId": "657940e6-afcd-4d05-8d3f-c4ba7b197749",
    "ts": "2026-08-26T13:32:52.840267+00:00",
    "title": null
  },
  {
    "company": "percents",
    "postId": "95591843-7117-486e-8525-06b59f22750e",
    "ts": "2026-08-26T13:32:29.684764+00:00",
    "title": null
  },
  {
    "company": "percents",
    "postId": "bcfa98ef-241b-463b-891a-78e4d46e9837",
    "ts": "2026-08-20T07:31:06.221094+00:00",
    "title": null
  },
  {
    "company": "percents",
    "postId": "2dda7dc6-5fda-406e-b8b3-1f577230651b",
    "ts": "2026-08-18T13:26:17.957004+00:00",
    "title": null
  },
  {
    "company": "sourcera",
    "postId": "6d012062-6d8e-42b0-9489-098582350c32",
    "ts": "2026-08-18T10:56:50.039597+00:00",
    "title": null
  },
  {
    "company": "sourcera",
    "postId": "569cb8f2-832e-4e65-806e-523f3a50a883",
    "ts": "2026-08-18T10:47:01.25592+00:00",
    "title": null
  },
  {
    "company": "sourcera",
    "postId": "1bee7a28-dacf-4ee8-84f3-856f4f307c29",
    "ts": "2026-08-18T09:46:39.786678+00:00",
    "title": null
  },
  {
    "company": "fergana-labs",
    "postId": "e8d67118-65cf-42d4-b020-d020d2f33a77",
    "ts": "2026-08-13T12:23:35.846957+00:00",
    "title": null
  },
  {
    "company": "fergana-labs",
    "postId": "93cc9718-fcfe-4349-9368-e8fa48898619",
    "ts": "2026-08-13T11:25:51.912867+00:00",
    "title": null
  },
  {
    "company": "fergana-labs",
    "postId": "36b0f416-c40a-4402-88f4-2ba6a991d920",
    "ts": "2026-08-13T11:07:47.033292+00:00",
    "title": null
  },
  {
    "company": "fergana-labs",
    "postId": "46e06c44-3c86-447d-b767-aab2a520db75",
    "ts": "2026-08-13T11:00:23.22934+00:00",
    "title": null
  },
  {
    "company": "fergana-labs",
    "postId": "c05c979b-f212-46c7-812a-80d509502fc4",
    "ts": "2026-08-13T10:18:37.342617+00:00",
    "title": null
  },
  {
    "company": "percents",
    "postId": "b702558e-793a-4971-941f-b2567872ae1b",
    "ts": "2026-08-10T13:36:23.49256+00:00",
    "title": null
  },
  {
    "company": "percents",
    "postId": "04071df3-73cb-4f44-b519-2e65aec4f983",
    "ts": "2026-08-06T12:00:26.739309+00:00",
    "title": null
  },
  {
    "company": "percents",
    "postId": "fce7e250-7563-433b-bf58-6c1d400281eb",
    "ts": "2026-08-04T15:00:36.652523+00:00",
    "title": null
  },
  {
    "company": "innovocommerce",
    "postId": "c683860a-fa8b-42ba-8ab9-11b8579a52d1",
    "ts": "2026-08-03T19:27:52.241439+00:00",
    "title": null
  },
  {
    "company": "innovocommerce",
    "postId": "1f45c086-58dc-4d7f-af43-28e5612e2163",
    "ts": "2026-08-03T19:11:29.04772+00:00",
    "title": null
  },
  {
    "company": "innovocommerce",
    "postId": "1f822c74-0f22-4fba-99b0-2a9d40e88459",
    "ts": "2026-08-03T19:10:54.139535+00:00",
    "title": null
  },
  {
    "company": "innovocommerce",
    "postId": "aa6ae4a3-6f09-44da-b7b0-16df8054d9d2",
    "ts": "2026-08-03T19:10:07.396823+00:00",
    "title": null
  }
];
