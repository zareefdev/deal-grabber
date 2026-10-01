# Amazon to Flipkart Deals Grabber

Live discounted tech listings from Amazon.in and Flipkart, shown on a single static page at
**[atof.in](https://atof.in)**.

- **Frontend:** `public/index.html` — no framework, no build step.
- **Data:** `public/deals.json` — the latest merged snapshot, refreshed by CI.
- **Scraper:** `server.js` — plain `fetch` first, Playwright/Chromium fallback for Flipkart's
  Akamai wall and Amazon's `bm-verify` interstitial.

## How the feed stays current

Each refresh scrapes both stores, then merges the result with the previous snapshot:

- A healthy scrape is **authoritative** — deals that are gone are dropped, so expired listings
  disappear on their own.
- If a store returns suspiciously little (CI IPs are often blocked), the run is treated as
  **partial**: fresh deals are kept and recent unseen rows are retained, marked stale, and
  aged out after `DEAL_TTL_MS` (24h). A fully blocked store holds its last snapshot for at most
  `STORE_STALE_MS` (3h).
- Every deal carries `firstSeen`/`lastSeen`; anything first seen in the last 24h gets a **New**
  badge in the UI.

The previous snapshot lives in `.deal-state.json` (gitignored). In CI it is carried between
runs with the Actions cache, so the ledger survives a fresh checkout without committing data
churn. Tune with `MERGE_KEEP_RATIO`, `DEAL_TTL_MS`, `STORE_STALE_MS`, `MAX_STORE_DEALS`.

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

## SEO

- Canonical, Open Graph and Twitter card metadata, plus JSON-LD (`WebSite`, `Organization`,
  `CollectionPage`, `FAQPage`, and a live `ItemList` of the top deals injected client-side).
- `public/robots.txt` and `public/sitemap.xml` (its `lastmod` is stamped from the snapshot on
  every deploy), `public/favicon.svg`, `public/og-image.png`.
- `public/404.html` is served for unknown paths so junk URLs 404 instead of duplicating the
  homepage.

## Deployment

Cloudflare Pages (direct upload), driven by GitHub Actions.

- `.github/workflows/refresh.yml` runs on a best-effort 10-minute schedule, scrapes, and
  deploys `public/` to the `deal-grabber` Pages project with `wrangler pages deploy`.
- On the deployed site `/api/deals` is served from `public/deals.json` via the
  `public/_redirects` rewrite — there is no server process in production.

Required repository secrets:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Scoped token with **Cloudflare Pages: Edit** on the account |
| `CLOUDFLARE_ACCOUNT_ID` | Target Cloudflare account id |

## Notes

- GitHub's scheduler is best-effort: a 10-minute cron is the requested cadence, not a guarantee
  — runs can be delayed or dropped under load.
- Amazon and Flipkart both block datacenter IP ranges, so a scheduled scrape can come back
  small from CI. The merge logic above keeps the site from regressing; run `npm run scrape`
  locally and commit `public/deals.json` to seed or repair it.
- Product images are third-party URLs served straight from the marketplaces.
