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

The page itself leads with Amazon: **every Amazon listing is shown** and Flipkart is capped to
at most **30%** of the feed (3/7 of the Amazon count), so the default grid holds a **70/30
Amazon/Flipkart** split — woven so the ratio holds from the first screen down. The Flipkart
slice is reshuffled on each load for rotating exposure; the Amazon/Flipkart filter buttons
still report each store's full count.

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
`/api/deals`. `GET /api/deals?refresh=1` forces a fresh scrape. It also serves `public/`
statically — so the manifest, service worker and icons load exactly as they do in
production — and answers `/api/push/*` from a gitignored `.push-subs.json`.

## Refreshing the snapshot

```bash
npm run scrape       # one scrape, writes public/deals.json, exits
```

## Installable app (PWA)

`public/manifest.webmanifest` plus `public/sw.js` make the page installable and
tolerant of a dead connection:

- The shell (`/`, `/index.html`, `/offline.html`, the icons and the manifest) is
  precached on install. Navigations are network-first, falling back to the cached
  shell and then `offline.html`.
- `/api/deals` is network-first too, so the feed is never stale while online; the
  last good snapshot answers when the network is gone.
- Product images and webfonts are cache-first, trimmed to the most recent 120 entries.
- Icons come from the same arrow mark as `favicon.svg`. Regenerate them with
  `npm run icons` (uses the Playwright the scraper already needs).

## Push notifications

The page offers an opt-in "2 handpicked deals every morning" prompt. Accepting it
creates a plain VAPID Web Push subscription in the browser — no third-party push
SDK and no vendor account — and `daily-push.yml` sends one digest a day.

The prompt only appears once a subscription can really be stored and sent: `/api/push/key`
reports `ready` alongside the public key, and the page keeps the section hidden while the
key or the KV namespace is missing. If storing a subscription fails, the page says so
instead of showing a false "On". On iPhone and iPad, Web Push is only available once the
site is added to the Home Screen, and the prompt says that rather than failing silently.

| Piece | Role |
| --- | --- |
| `public/index.html` | asks permission, creates the subscription, POSTs it to `/api/push/subscribe` |
| `public/sw.js` | renders the notification and opens the deal on tap |
| `functions/api/push/key.js` | serves the public VAPID key (set in `wrangler.toml` under `[vars]`) plus whether push storage is ready |
| `functions/api/push/subscribe.js` | stores subscriptions in the KV namespace bound as `SUBS` |
| `scripts/send-daily-push.js` | picks the two best deals, reads the subscriber list, sends |

Setup:

1. **VAPID key pair.** Generate one with `npx web-push generate-vapid-keys`. The
   public key is committed in `wrangler.toml` (`[vars] VAPID_PUBLIC_KEY`) — public by
   design; swap in a new pair only if you rotate. A pair generated on this machine is
   also kept, gitignored, in `.vapid.json`.
2. **Repository secrets.** Add the ones in the table below — `VAPID_PUBLIC_KEY` must
   hold the same value as the `[vars]` entry above.
3. **Push storage.** Nothing to create by hand. `scripts/provision-push.mjs` runs
   before every deploy and creates the KV namespace the endpoints write to, binds it
   as `SUBS`, and stores `PUSH_ADMIN_SECRET` as a Pages secret (which gates the
   subscriber list the sender reads). It is idempotent, so it can run on every deploy,
   and non-fatal: a token that cannot manage KV leaves the opt-in hidden rather than
   failing the deploy. Run `npm run provision` to do the same locally against the
   account `wrangler login` is using.

Until the key and the namespace are in place the prompt stays hidden and the sender logs
a warning and exits — nothing 500s.

The digest goes out once a day (02:30 UTC / 08:00 IST in `daily-push.yml`). Change the
cron there to move it, or `PUSH_DEAL_COUNT` to send a different number of deals.

```bash
npm start                    # local dev server: serves the PWA and /api/push/* endpoints
npm run push:dry             # build the digest from the snapshot and print it, no send
SITE_URL=http://localhost:4173 npm run push:dry   # same, against a local scrape
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
- `.github/workflows/daily-push.yml` sends the daily 2-deal digest described under
  **Push notifications**.
- On the deployed site `/api/deals` is served from `public/deals.json` via the
  `public/_redirects` rewrite. The only dynamic routes are the Pages Functions under
  `functions/api/push/`, which run on Cloudflare's edge — there is no server process to
  keep alive.

Required repository secrets:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Scoped token with **Cloudflare Pages: Edit** and **Workers KV Storage: Edit** on the account |
| `CLOUDFLARE_ACCOUNT_ID` | Target Cloudflare account id |
| `AMAZON_CREATORS_CLIENT_ID` | Creators API credential id (preferred Amazon source) |
| `AMAZON_CREATORS_CLIENT_SECRET` | Creators API credential secret |
| `SCRAPE_PROXY` | Optional residential proxy for the scraping fallback |
| `VAPID_PUBLIC_KEY` | Web Push public key — same value as `[vars]` in `wrangler.toml` |
| `VAPID_PRIVATE_KEY` | Web Push private key, used only by the daily push job |
| `VAPID_SUBJECT` | `https://` or `mailto:` contact for the push service |
| `PUSH_ADMIN_SECRET` | Gates the subscriber list; set the same value as a Pages secret |

## Notes

- GitHub's scheduler is best-effort: a 10-minute cron is the requested cadence, not a guarantee
  — runs can be delayed or dropped under load.
- Amazon and Flipkart both rate-limit datacenter IP ranges, so a scheduled scrape can come back
  small from CI. Blocked queries are retried, the merge keeps the richer snapshot when a run is
  degraded, and `SCRAPE_PROXY` removes the block outright. To seed or repair the snapshot by
  hand, run `npm run scrape` locally and commit `public/deals.json`.
- Product images are third-party URLs served straight from the marketplaces.
