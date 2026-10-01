# Amazon to Flipkart Deals Grabber

Live discounted tech listings from Amazon.in and Flipkart, shown on a single static page at
**[atof.in](https://atof.in)**.

- **Frontend:** `public/index.html` — no framework, no build step.
- **Data:** `public/deals.json` — the latest merged snapshot, refreshed by CI.
- **Scraper:** `server.js` — plain `fetch` first, Playwright/Chromium fallback for Flipkart's
  Akamai wall and Amazon's `bm-verify` interstitial.

## How the feed stays current

Each refresh scrapes both stores, then merges the result with the previous snapshot:

- A scrape where **every query answered** is authoritative — deals that are gone are dropped, so
  expired listings disappear on their own.
- If **any query came back blocked** (CI IPs are often served a robot interstitial), the run is
  treated as **degraded**: fresh deals are kept and recent unseen rows are retained, marked
  stale, and aged out after `DEAL_TTL_MS` (24h). A fully blocked store holds its last snapshot
  for at most `STORE_STALE_MS` (3h).
- Every deal carries `firstSeen`/`lastSeen`; anything first seen in the last 24h gets a **New**
  badge in the UI.

The previous snapshot lives in `.deal-state.json` (gitignored). In CI it is carried between
runs with the Actions cache, so the ledger survives a fresh checkout without committing data
churn. Tune with `DEAL_TTL_MS`, `STORE_STALE_MS`, `MAX_STORE_DEALS`.

### Scraping from a datacenter IP

Amazon rate-limits by IP and intermittently answers a search with a robot interstitial that
carries no result cards. The scraper handles that directly:

- A blocked query is detected in ~4s and **retried** (`AMAZON_QUERY_RETRIES`, default 2), which
  recovers most of them; navigations are spaced out with a small random delay.
- The Amazon context hides the automation flag, seeds INR/locale cookies, and warms up on the
  homepage once, so the searches reuse a normal-looking session.
- If queries still come back empty, the merge falls back to keeping the richer snapshot rather
  than overwriting it.

To remove the block entirely, set the repository secret **`SCRAPE_PROXY`** to a residential
proxy (`http://user:pass@host:port` or `socks5://…`). The scraping browser then routes through
it and CI sees the same result set as a local run. Unset means scrape direct.

### Official Amazon data (Creators API)

If **`AMAZON_CREATORS_CLIENT_ID`** and **`AMAZON_CREATORS_CLIENT_SECRET`** are set, Amazon rows
are _also_ fetched from the official
[Creators API](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/introduction) — the
successor to the deprecated Product Advertising API 5.0. It runs **alongside** the page scraper in
the same refresh (the two execute in parallel) and their results are merged, deduplicated by ASIN,
with the API's row winning on a clash. The API adds authoritative price/availability and is an
authenticated REST call, so it is IP-independent and works from CI without a proxy; the scraper
keeps contributing the search-page breadth the API does not cover. Either side coming back empty is
harmless — the merge simply uses the other.

- Credential **version 3.2** (EU home region) selects the Login-with-Amazon token endpoint
  `https://api.amazon.co.uk/auth/o2/token`; the credentials are global and the marketplace is
  chosen per call with the `x-marketplace` header (`www.amazon.in` by default).
- Access tokens last an hour and the token endpoint expects at most one token per hour, per
  credential, so the token is cached to `.creators-token.json` and carried between CI runs in the
  same Actions cache as the merge ledger.
- Amazon gates the API: the associate account must have made **10 qualified sales in the trailing
  30 days**. Until then every call answers `403 AssociateNotEligible`, the reason is logged
  (`[amazon] creators api unusable: AssociateNotEligible`), and the refresh carries on with the
  scraper alone — no redeploy needed once the account qualifies, the API rows just start appearing
  in the merge.

Tune with `AMAZON_CREATORS_PAGES` (search pages per query, default 2), `AMAZON_MARKETPLACE`, and
`AMAZON_CREATORS_TOKEN_URL`.

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

## Affiliate links

- Every Amazon link is tagged with the Associates id **`mdzareef-21`** (override with the
  `AMAZON_TAG` env var). The tag is applied both when the scraper builds URLs and again at
  render time, so even a snapshot scraped before the tag existed still earns the referral.
- Outbound deal links carry `rel="sponsored noopener noreferrer"`, and the Amazon Associates
  relationship is disclosed next to the listings, in the footer, and in the FAQ (visible copy
  and JSON-LD).
- Typefaces: **Inter** for body/UI, **Ubuntu** for headings, both loaded from Google Fonts.

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
| `AMAZON_CREATORS_CLIENT_ID` | Creators API credential id (preferred Amazon source) |
| `AMAZON_CREATORS_CLIENT_SECRET` | Creators API credential secret |
| `SCRAPE_PROXY` | Optional residential proxy for the scraping fallback |

## Notes

- GitHub's scheduler is best-effort: a 10-minute cron is the requested cadence, not a guarantee
  — runs can be delayed or dropped under load.
- Amazon and Flipkart both rate-limit datacenter IP ranges, so a scheduled scrape can come back
  small from CI. Blocked queries are retried, the merge keeps the richer snapshot when a run is
  degraded, and `SCRAPE_PROXY` removes the block outright. To seed or repair the snapshot by
  hand, run `npm run scrape` locally and commit `public/deals.json`.
- Product images are third-party URLs served straight from the marketplaces.
