# Fuel Log

A private calorie and training tracker that runs as a page on Gareth's Claude account,
plus a small connector that pulls workouts in from Garmin.

- **Fuel Log page:** https://claude.ai/artifact/NdKCDqAR5k8ytdcDgu3jbc (private to its owner)
- **Page source:** `fuel-log-page/fuel-log.html`. It is published to that URL with Claude's Artifact tool,
  not served from this repo. It stores the log in the page's own database (`days/<YYYY-MM-DD>`,
  `meta/settings`; owner-only read and write), estimates food calories with Claude from a description
  or a photo, and pulls Garmin workouts through the Garmin Sync connector.
- **Garmin Sync connector:** `garmin-connector/worker.js`, a Cloudflare Worker (config in `wrangler.toml`).
  It speaks MCP so claude.ai can add it as a custom connector, and calls Garmin's Personal API with
  your own key. Read-only.

## Garmin Sync connector

| Route | What it does |
|---|---|
| `GET /` | Says the Worker is running |
| `GET /check/<CONNECTOR_SECRET>` | Checks the Garmin key and shows one recent activity |
| `POST /mcp/<CONNECTOR_SECRET>` | MCP endpoint for claude.ai (tools: `get_activities`, `garmin_get`) |

Secrets on the Worker (Cloudflare dashboard, Worker, Settings, Variables and Secrets):

- `GARMIN_API_KEY`: from https://connect.garmin.com/app/settings/personalApiToken (shown once; expires after the period you pick)
- `CONNECTOR_SECRET`: a long random string; it is part of the connector URL, so keep that URL private

Garmin Personal API facts this relies on: the key is exchanged at
`POST https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token`
(`Authorization: ApiKey <key>`) for a 24-hour bearer token with no refresh token; workouts come from
`/activitylist-service/activities/search/activities?start=&limit=&startDate=&endDate=` (pages above ~45 fail).
Activity field names are mapped defensively in `shapeActivity`; open `/check/<secret>` to see what Garmin really sends.

Tests run the Worker against a fake Garmin API:

```sh
cd garmin-connector && npm test
```

Cloudflare deploys this repo with Workers Builds (`npx wrangler deploy` from the repo root).
