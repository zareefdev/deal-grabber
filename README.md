# Deal Grabber

Live discounted tech listings scraped from Amazon.in and Flipkart, shown on a single static page.

- **Frontend:** `public/index.html` — no framework, no build step.
- **Data:** `public/deals.json` — the latest snapshot, refreshed by CI.
- **Scraper:** `server.js` — Plain `fetch` first, Playwright/Chromium fallback for Flipkart's Akamai wall and Amazon's `bm-verify` interstitial.

## Local development

```bash
npm install
npx playwright install chromium
npm start            # http://localhost:4173
```

`npm start` runs the dev server, which scrapes on demand and serves the live result at
`/api/deals`. `GET /api/deals?refresh=1` forces a fresh scrape.

## Refreshing the snapshot

```bash
npm run scrape       # one scrape, writes public/deals.json, exits
```

## Deployment

Cloudflare Pages (direct upload), driven by GitHub Actions.

- `.github/workflows/refresh.yml` scrapes on a schedule and deploys `public/` to the
  `deal-grabber` Pages project with `wrangler pages deploy`.
- On the deployed site `/api/deals` is served from `public/deals.json` via the
  `public/_redirects` rewrite — there is no server process in production.

Required repository secrets:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Scoped token with **Cloudflare Pages: Edit** on the account |
| `CLOUDFLARE_ACCOUNT_ID` | Target Cloudflare account id |

## Notes

- Amazon and Flipkart both block datacenter IP ranges, so the scheduled scrape can come
  back empty from CI. When a store returns nothing the last good snapshot is kept, so the
  site never regresses — run `npm run scrape` locally and commit `public/deals.json` to
  seed or repair it.
- Product images are third-party URLs served straight from the marketplaces.
