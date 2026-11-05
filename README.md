# Kosmora Lens

A read-only quality-of-life overlay for [Kosmora](https://kosmora.io). It works in Chrome, Edge, Brave and Firefox (140+).

It never buys, sells, bids, lists, fuses, trades, claims or opens anything. Every request is a GET, and all requests go through one queue: price requests at least 0.4 s apart, everything else 0.7–0.9 s. If the server ever answers 429 (rate limited), the whole queue pauses for its Retry-After (30 s if none is given). It was built under the dev's Discord ruling (Nov 2026): read-only plugins are allowed if they don't automate the game.

## Features

**Hover intel**: hover any card anywhere on the site (collection, market, pack reveals, home widgets, Vortex, …) to see the details below. The tooltip shows only while the pointer is on the card itself and hides as soon as it leaves.
- The 30-day market median, low, high and number of sales, with a sparkline of every sale.
- Whether you own it, and how many copies (×N, #1, locked, listed, in album).
- Its family's progress toward the next tier, and what owning or losing this card does to that tier.

- Three market stats for the last 14 days:
  - **14d avg**: the average sale price, from the sales history above. Costs no extra requests.
  - **Sale rate**: the share of listings that ended with at least one bid. The game has no endpoint for unsold listings, so Lens builds this itself from listings it sees while you browse the Market. It reads what the game already loads and how each tile says a listing ended ("Sold" / "No sale"), so this adds no requests. An auction that ended unseen is checked against the card's sales list. Until 3 listings of a card have been seen, it shows the average for that rarity (`~62%`) instead. It gets more accurate the more you browse.
  - **Avg bids**: the average bid count on recent sales. Lens fetches up to 4 recent sales' auction details while you hover a card, and caches them forever, since finished auctions never change. Repeated hovers fill in the rest. These samples are only ever sales, so they're kept out of the sale rate.

**Auto-price (on by default):** Lens prices every card on the page, one at a time (0.4 s apart, the same pace as KosMore), so the `≈` badges fill in without hovering. Cards on screen go first, then the rest of the page top to bottom, including cards you scrolled past. Cached prices (2 hours) are skipped, a failed card is retried after a minute, small cards (home widgets, carousels) wait for a hover, and nothing is fetched in a background tab or inside a Pulsar game. A hover always goes next in the queue. Turn it off in Settings to fetch prices only for the card you hover.

**Card pages** (`/card/{id}`) get a Lens *Market* section under your copies. It shows every open listing of that exact card (price, bids, time left, seller), with yours highlighted, and how many other sellers are at or below your price. It also shows the cheapest listing against the 30-day median, and an **Open in Market** button that runs the Market search for the card. The Market search hides your own listings, so Lens reads those from the card page's "See auction" links. Cost: one search request per card page (cached 60 s), plus one per listing of your own.

The hover tooltip also shows **Listed now** (count, cheapest, yours) from listings Lens has already seen.

**Card badges** sit on the bottom edge of the card art, clear of the game's own markers (NEW, lock, album, copy count). Small cards such as home widgets get no badges, though hover still works on them. The Vortex card picker gets a compact symbol-only form.
- `×2`: you own spare copies.
- `⚑ tier`: your only copy, and the family tier depends on it. Don't sell or fuse it.
- `NEW`: not in your collection.
- `▲ tier`: owning this card bumps a family to its next tier. Very handy on the Market.
- `≈ 500`: the cached median price. On the Market it turns green for a good deal (15%+ under median) and red when overpriced (25%+ over).

**Lens panel**: open it with the orb at bottom-right or **Alt+L**.
- **Fusion**: safe fusions per rarity with the Market value of each, and your next one-go batch (tap a name to copy it). Details are in hover titles.
- **Pulsar**: today's checklist, the Constellation domain ranking and the Vortex throw list (see below).
- **Settings**: collection sync, toggles, hover delay, fusion cushion.

## Pulsar

Lens gives pre-round information only. It never selects, starts or plays anything, never restyles the game's own controls, and shows nothing while a round is in progress: hover and badges are off inside every Pulsar game.

Each lobby gets **one Lens line** that says what to pick, with at most one number. The figures behind it are in the line's hover title. Only the best option is tagged (`★ Lens best`).

| Where | The Lens line | Based on |
|---|---|---|
| **Pulsar hub** | *Today in Pulsar*, right under the game's own **Today** box and styled like it: one row per game with the pick, any open first-win bonus and what's left today. Open first wins come first; finished games are dimmed. The last line is the most Kosmo still on the table today: every paid round left won with the Lens pick, plus open first-win bonuses (Horizon counts your average trip). | All of the below |
| **Constellation** | `Pick <domain>: wins pay +0.6 more than All cards`, or `✓ … pays the most per win` | Your collection's rarity mix per domain: a win pays the base win plus your cards' rarity bonus |
| **Photon** | `Pick stake 50: every light pays the most there` | A run pays stake × last light cleared |
| **Umbra** | `Pick <board>: 3★ pays +40` | The lobby's pay table minus the stake (ledger-verified) |
| **Aion** | Your open first-win bonus, otherwise what a flawless win nets | The lobby's rewards plus your average rarity bonus from finished games |
| **Horizon** | `Launch now` / `Relaunch at 6:38 PM` / no more trips fit | Your finished expeditions and the open trip's return time |
| **Vortex** | Legend for the `✓` / `⚑` / `▲` card marks; the full throw list is in the panel | Your collection and family tiers |

The panel's Pulsar tab shows a *Today in Pulsar* checklist (pick, open first-win bonus, rounds left per game), the Constellation domain ranking and the Vortex throw list.

Pulsar picks are never weighted by your win, bust or 3★ rate. Each option is ranked by what it pays when you win. The *Today in Pulsar* total is the only figure that assumes you win, and it says so.

**Collection sync is automatic.** On first run Lens reads your collection once (about 100 requests, roughly a minute). After that it stays current on its own: pack openings, market events, trades and gifts arrive through the game's own live event stream, and fusion, Vortex and listings through the game's replies to your actions. Each change is confirmed with one request per affected card. If Lens's card count ever drifts from the game's, it resyncs quietly in the background, at most every 6 hours. **Full resync** in the panel is rarely needed.

## Install

### Chrome / Edge / Brave
1. Go to `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick this folder (`KosmoraLens`).

### Firefox
- **Temporary:** go to `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…**, and pick `manifest.json`. It is removed when Firefox restarts, **and Firefox deletes its stored data (cached prices, collection snapshot) at the same time.** To keep the data, set `extensions.webextensions.keepStorageOnUninstall` and `extensions.webextensions.keepUuidOnUninstall` to `true` in `about:config` before closing Firefox. You still need to load the add-on again after each restart.
- **Permanent:** it needs signing. Run `npx web-ext sign --channel=unlisted` with AMO API keys, or zip the folder and upload it as an *unlisted* add-on at addons.mozilla.org/developers. AMO signs unlisted add-ons automatically, usually within minutes.

Package a zip for sharing with `npx web-ext build --source-dir . --artifacts-dir dist --ignore-files dist docs tools "*.md" --overwrite-dest` (output in `dist/`), or zip `manifest.json`, `src/` and `icons/`.

## Files
- `manifest.json`: MV3 manifest. Content scripts only, no background worker, so it runs unchanged in both browsers.
- `src/hook.js`: a tiny page-world observer. It passes copies of allow-listed GET responses the game itself loads (market, prices, pack results, Pulsar lobbies and finished-game histories) to Lens. It never sends requests, never reads anything from inside a running game, and hands the page its original responses untouched.
- `src/content.js`: core: data, hover, badges, panel, and the plugin API.
- `src/cardpage.js`: card-page Market section.
- `src/pulsar.js`: Pulsar module (models, lobby cards, hub plan, Vortex helpers). It plugs into the core via `__KL.register()`.
- `src/lens.css`: styles. Everything is prefixed `kl-`.
- `icons/`: extension icons.

## API used (all GET, same-origin, with your own session)
- `/api/cards/{id}/prices`: sales history for the cards on the page (auto-price) and the card you hover.
- Pack openings: the game's own `/api/openings/{id}` response (relayed by hook.js, no extra request) marks pulled cards as owned right away, then family counts refresh once.
- `/api/auctions/{id}`: bid counts for up to 4 recent sales of the hovered card, cached forever. Also used for your own listings on a card page.
- `/api/auctions?q={name}`: the Market search for the card page you're viewing (cached 60 s).
- `/api/me/families`: your family counts (1 request, cached 10 min).
- `/api/collection?cursor=…`: your collection, only when you click Sync.
- `/api/me`, `/api/me/production`: income figures in the Fusion tab's hover title.
- Pulsar: `/api/games/today`, `/api/constellation/hub`, `/api/exploration/hub`, `/api/timeline/lobby`, `/api/timeline/history`, `/api/photon/lobby`, `/api/umbra/lobby`, `/api/vortex/lobby`. These are normally read from the game's own requests via hook.js. Lens fetches them itself only when you press Refresh, or once when a lobby needs data it hasn't seen.
