/* Kosmora Lens — read-only QoL overlay for kosmora.io
 *
 * Ground rules (per the dev's Discord ruling, Nov 2026):
 *  - READ ONLY. This script never buys, sells, bids, lists, fuses, trades,
 *    claims or opens anything. It only issues GET requests.
 *  - Every request goes through one queue, spaced >= 0.4 s apart (prices) or
 *    0.7–0.9 s (everything else), and the queue pauses when the server sends 429.
 *  - Prices are fetched for every card tile on the page (on screen first), one at a time
 *    (Settings → "Auto-price cards on the page"), and for cards you hover. They are
 *    cached for 2 hours.
 */
(() => {
  'use strict';
  if (window.__kosmoraLens) return;
  window.__kosmoraLens = true;

  const ext = globalThis.browser ?? globalThis.chrome;
  // Firefox content scripts must use the page's fetch to send same-origin cookies.
  const pageFetch =
    typeof content !== 'undefined' && content && typeof content.fetch === 'function'
      ? content.fetch.bind(content)
      : globalThis.fetch.bind(globalThis);

  // ───────────────────────── constants ─────────────────────────
  const RARITIES = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythic'];
  // Base fusion recipes (help text + client config `fusion.recipes`, checked 2026-11-05).
  // Only a fallback: the player's real, talent-adjusted costs come from GET /api/fusion
  // (Master Fuser I: C/U/R take 2; Master Fuser II: Epic takes 3; Mythic always takes 6).
  const FUSE_COST = { Common: 3, Uncommon: 3, Rare: 3, Epic: 4, Legendary: 6 };
  const FUSION_TTL = 10 * 60e3;
  const MSTATS_TTL = 60 * 60e3; // the game rebuilds /api/market/stats about hourly (builtAt)
  const BASE_MILESTONES = [2, 5, 10, 25, 50, 100, 250, 500, 1000];
  const PRICE_TTL = 2 * 3600e3;
  const SCAN_GAP = 400; // ms between price requests (on-screen scan and hover)
  const FAMILY_TTL = 10 * 60e3;
  const ME_TTL = 60e3;
  const MAX_PRICES = 4000;
  const F = { locked: 1, auction: 2, albums: 4, numberOne: 8, veil: 16, mods: 32 };
  const DEFAULTS = {
    tooltip: true,
    badges: true,
    critical: true,
    newBadge: true,
    hoverDelay: 280,
    autoPrice: true,
    fuseBuffer: 0,
  };

  // ───────────────────────── state ─────────────────────────
  const S = {
    settings: { ...DEFAULTS },
    prices: {},
    obs: {},
    families: null,
    mstats: null, // {t, builtAt, med:{Common:21,...}, sales:{...}} from /api/market/stats?period=7d (completed sales)
    fusion: null, // {t, recipes:{Common:{to,cards,usual}}, maxBatches, rarities:{Common:{copies,spare}}} from /api/fusion
    famById: new Map(),
    famByName: new Map(),
    milestones: BASE_MILESTONES,
    collection: null, // Map id -> {id,q,r,famId,famName,name,f}
    collectionAt: 0,
    me: null,
    prod: null,
    meAt: 0,
    syncing: false,
    sync: null,
    rev: 0,
  };

  // ───────────────────────── utils ─────────────────────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const micro = (v) => (v == null ? null : Number(v) / 1e6);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n, d) => {
    if (n == null || !isFinite(n)) return '—';
    const digits = d ?? (Math.abs(n) >= 1000 ? 0 : Math.abs(n) >= 10 ? 1 : 2);
    return n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  };
  const ago = (t) => {
    if (!t) return 'never';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };
  const rarityIdx = (r) => RARITIES.indexOf(r);
  const rarityClass = (r) => `kl-r-${String(r || 'common').toLowerCase()}`;
  // Debounced calls run at most `maxWait` after the first call (so a burst of hovers can't
  // postpone a save forever) and can be flushed. Every pending save is flushed when the
  // page is hidden or unloaded, because the site does full-page navigations.
  const pendingFlush = new Set();
  const debounce = (fn, ms, maxWait = 0) => {
    let t;
    let first = 0;
    let args = null;
    const run = () => {
      clearTimeout(t);
      t = null;
      first = 0;
      pendingFlush.delete(d);
      const a = args;
      args = null;
      fn(...a);
    };
    const d = (...a) => {
      args = a;
      clearTimeout(t);
      if (!first) first = Date.now();
      pendingFlush.add(d);
      const wait = maxWait ? Math.min(ms, Math.max(0, first + maxWait - Date.now())) : ms;
      t = setTimeout(run, wait);
    };
    d.flush = () => t && run();
    return d;
  };
  const flushAll = () => [...pendingFlush].forEach((d) => d.flush());
  addEventListener('pagehide', flushAll);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushAll());

  // stored data plus anything newer already in memory (hook.js can relay before storage loads)
  const mergeNewerInto = (saved, mem) => {
    const out = { ...(saved || {}) };
    mergeNewer(out, mem);
    return out;
  };
  // Saves wait until stored data has loaded, so an early save can't replace it with a near-empty set.
  let stored = false;

  // keep the entry with the newest `t` from either side; returns how many came from `src`
  function mergeNewer(target, src) {
    let n = 0;
    for (const [id, v] of Object.entries(src || {})) {
      if (v && (!target[id] || (v.t || 0) > (target[id].t || 0))) {
        target[id] = v;
        n++;
      }
    }
    return n;
  }

  const store = {
    async get(k) {
      try {
        const o = await ext.storage.local.get(k);
        return o?.[k];
      } catch {
        return undefined;
      }
    },
    async set(k, v) {
      try {
        await ext.storage.local.set({ [k]: v });
      } catch (e) {
        console.warn('[Kosmora Lens] storage write failed', e);
      }
    },
  };

  // tiny event bus
  const listeners = new Set();
  const emit = (type, data) => listeners.forEach((fn) => fn(type, data));
  const bump = () => {
    S.rev++;
    scheduleScan();
    emit('rev');
  };

  // ───────────────────────── API (GET only, queued) ─────────────────────────
  let lastCall = 0;
  let chain = Promise.resolve();
  const ownPaths = new Map(); // pathname -> time Lens requested it
  const isOwn = (path) => {
    const t = ownPaths.get(path);
    return t != null && Date.now() - t < 30e3;
  };
  // set when the server answers 429; every request (hover and scan) waits it out
  let blockedUntil = 0;
  function apiGet(path, gap = 900, guard = null) {
    const job = async () => {
      if (guard && !guard()) throw new Error('skipped');
      const wait = Math.max(lastCall + gap, blockedUntil) - Date.now();
      if (wait > 0) await sleep(wait);
      if (guard && !guard()) throw new Error('skipped');
      lastCall = Date.now();
      ownPaths.set(new URL(path, location.origin).pathname, Date.now());
      if (ownPaths.size > 200) ownPaths.delete(ownPaths.keys().next().value);
      const r = await pageFetch(new URL(path, location.origin).href, {
        method: 'GET',
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (r.status === 429) {
        const ra = Number(r.headers.get('Retry-After'));
        blockedUntil = Date.now() + (ra > 0 ? Math.min(ra, 300) : 30) * 1e3;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    };
    const p = chain.then(job, job);
    chain = p.catch(() => {});
    return p;
  }

  // prices
  const priceInflight = new Map();
  const savePrices = debounce(() => {
    if (!stored) return;
    const ids = Object.keys(S.prices);
    if (ids.length > MAX_PRICES) {
      ids.sort((a, b) => S.prices[a].t - S.prices[b].t)
        .slice(0, ids.length - MAX_PRICES)
        .forEach((id) => delete S.prices[id]);
    }
    store.set('prices', S.prices);
  }, 2000, 10000);

  function priceFresh(id) {
    const p = S.prices[id];
    return p && Date.now() - p.t < PRICE_TTL ? p : null;
  }
  // guard: a scan request drops out of the queue if its card left the screen before its turn
  function getPrice(id, force = false, guard = null) {
    if (!force && priceFresh(id)) return Promise.resolve(S.prices[id]);
    if (priceInflight.has(id)) return priceInflight.get(id);
    const p = apiGet(`/api/cards/${encodeURIComponent(id)}/prices`, SCAN_GAP, guard)
      .then((j) => storePrice(id, j))
      .finally(() => priceInflight.delete(id));
    priceInflight.set(id, p);
    return p;
  }
  function storePrice(id, j) {
    const x = j?.prices || {};
    const e = {
      t: Date.now(),
      n: x.count || 0,
      d: x.days || 30,
      med: micro(x.median),
      lo: micro(x.low),
      hi: micro(x.high),
      // [soldAt ms, price, auctionId]
      s: (x.sales || [])
        .map((s) => [Date.parse(s.soldAt), micro(s.price), s.auctionId || null])
        .filter((s) => isFinite(s[0]) && s[1] != null)
        .sort((a, b) => a[0] - b[0]),
    };
    S.prices[id] = e;
    savePrices();
    S.rev++;
    scheduleScan();
    emit('price', id);
    return e;
  }

  // ───────── observed auctions (sale rate / bids) ─────────
  // id -> { c: subjectId, r: rarity, b: max bids seen, st: state, e: endsAt ms, fp: final price, t: last seen }
  const WINDOW = 14 * 864e5;
  const saveObs = debounce(() => {
    if (!stored) return;
    const cutoff = Date.now() - 35 * 864e5;
    const ids = Object.keys(S.obs);
    for (const id of ids) if ((S.obs[id].e || S.obs[id].t) < cutoff) delete S.obs[id];
    const left = Object.keys(S.obs);
    if (left.length > 25000)
      left.sort((a, b) => S.obs[a].t - S.obs[b].t).slice(0, left.length - 25000).forEach((id) => delete S.obs[id]);
    store.set('obs', S.obs);
  }, 3000, 10000);

  // sampled = fetched by Lens for bid counts (always sold), so it must not feed the sale rate
  function ingestAuction(a, sampled = false) {
    if (!a || typeof a !== 'object' || !a.id || !a.card?.subjectId || !('bids' in a)) return false;
    const prev = S.obs[a.id];
    S.obs[a.id] = {
      c: String(a.card.subjectId),
      r: a.card.rarity || prev?.r || null,
      b: Math.max(Number(a.bids) || 0, prev?.b || 0),
      st: a.state || prev?.st || null,
      e: Date.parse(a.endsAt) || prev?.e || null,
      fp: a.finalPrice != null ? micro(a.finalPrice) : (prev?.fp ?? null),
      // current price: best bid so far, else the starting price
      cp: micro(a.bestBid ?? a.startPrice) ?? prev?.cp ?? null,
      me: !!a.yours || !!prev?.me,
      t: Date.now(),
      // stays true only while the auction is known solely from Lens's own bid sampling
      smp: sampled ? (prev ? !!prev.smp : true) : false,
    };
    return true;
  }
  function ingestAny(data, depth = 0) {
    if (!data || typeof data !== 'object' || depth > 3) return 0;
    if (Array.isArray(data)) return data.reduce((n, x) => n + ingestAny(x, depth + 1), 0);
    if (ingestAuction(data)) return 1;
    let n = 0;
    for (const v of Object.values(data)) if (v && typeof v === 'object') n += ingestAny(v, depth + 1);
    return n;
  }

  // sold / unsold / live / unknown / skip
  function outcome(aid, o, p, soldIds) {
    if (o.st === 'cancelled' || o.st === 'withdrawn' || o.st === 'removed') return 'skip';
    if (o.st === 'sold' || o.fp != null || soldIds?.has(aid)) return 'sold';
    if (o.st && o.st !== 'open') return 'unsold';
    if (!o.e || o.e > Date.now()) return 'live';
    // ended while we weren't looking: decided by the card's sales list, once that is newer than the end
    if (p && p.t > o.e + 120e3) return 'unsold';
    return 'unknown';
  }

  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

  function marketStats(id, rarity) {
    const now = Date.now();
    const p = S.prices[id];
    const recent = p ? p.s.filter((s) => s[0] >= now - WINDOW) : [];
    const soldIds = new Set(p ? p.s.map((s) => s[2]).filter(Boolean) : []);
    const bids = recent.map((s) => s[2] && S.obs[s[2]]).filter((o) => o && o.b > 0).map((o) => o.b);
    let sold = 0;
    let unsold = 0;
    let live = 0;
    let unknown = 0;
    let rSold = 0;
    let rTot = 0;
    for (const [aid, o] of Object.entries(S.obs)) {
      if (!o.e || o.e < now - WINDOW || o.smp) continue;
      if (o.c === id) {
        const r = outcome(aid, o, p, soldIds);
        if (r === 'sold') sold++;
        else if (r === 'unsold') unsold++;
        else if (r === 'live') live++;
        else if (r === 'unknown') unknown++;
      } else if (rarity && o.r === rarity) {
        const op = S.prices[o.c];
        const r = outcome(aid, o, op, op ? new Set(op.s.map((s) => s[2])) : null);
        if (r === 'sold' || r === 'unsold') {
          rTot++;
          if (r === 'sold') rSold++;
        }
      }
    }
    return {
      avg14: mean(recent.map((s) => s[1])),
      n14: recent.length,
      avgBids: mean(bids),
      nb: bids.length,
      nRecentWithId: recent.filter((s) => s[2]).length,
      sold,
      unsold,
      live,
      unknown,
      rarityRate: rTot >= 5 ? rSold / rTot : null,
      rarityN: rTot,
    };
  }

  // fetch bid counts for a few recent sales of the hovered card; finished auctions never change, so cache forever
  const bidInflight = new Set();
  function sampleBids(id, stillWanted) {
    const p = S.prices[id];
    if (!p) return;
    const now = Date.now();
    const need = p.s
      .filter((s) => s[2] && s[0] >= now - WINDOW && !(S.obs[s[2]]?.b > 0) && !bidInflight.has(s[2]))
      .sort((a, b) => b[0] - a[0])
      .slice(0, 4);
    for (const s of need) {
      bidInflight.add(s[2]);
      apiGet(`/api/auctions/${encodeURIComponent(s[2])}`, 900, stillWanted)
        .then((a) => {
          if (ingestAuction(a, true)) {
            saveObs();
            emit('obs', id);
          }
        })
        .catch(() => {})
        .finally(() => bidInflight.delete(s[2]));
    }
  }
  function needsResolve(id) {
    const p = S.prices[id];
    if (!p) return false;
    return Object.values(S.obs).some((o) => o.c === id && o.e && o.e < Date.now() - 120e3 && (!o.st || o.st === 'open') && o.fp == null && p.t < o.e + 120e3);
  }

  // data the game itself loaded, relayed by hook.js (no extra requests)
  addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin || !e.data || e.data.__kosmoraLens !== 1) return;
    const { path, data } = e.data;
    if (e.data.event) return onGameEvent(e.data.event, data);
    if (typeof path !== 'string' || isOwn(path)) return; // echo of a request Lens made itself
    if (e.data.action) return onOwnAction(path, data);
    for (const p of plugins) if (p.onMessage && p.onMessage(path, data, e.data.search || '')) return;
    if (path === '/api/me') return onMe(data);
    if (path === '/api/fusion') return setFusion(data);
    if (path === '/api/collection') return mergeCollectionPage(data);
    const cm = path.match(/^\/api\/collection\/(\d+)$/);
    if (cm) return applyCopies(cm[1], data);
    const m = path.match(/^\/api\/cards\/([^/]+)\/prices$/);
    if (m) {
      if (data?.prices && !String(e.data.search || '').match(/finish=(?!plain)/)) storePrice(decodeURIComponent(m[1]), data);
      return;
    }
    const op = path.match(/^\/api\/openings\/([^/]+)$/);
    if (op) return noteOpening(op[1], data);
    if (ingestAny(data)) {
      saveObs();
      emit('obs');
    }
  });

  // ───────────────────────── live collection sync ─────────────────────────
  // The snapshot is kept current without manual resyncs:
  //  - exact per-card truth comes from /api/collection/{id} (the card page's own endpoint);
  //  - Lens learns *which* cards changed from pack openings, the game's live events, and
  //    the game's replies to your own actions (fusion, Vortex, trades, listing...);
  //  - pages the game loads anyway (collection grid, card pages) refresh rows for free;
  //  - a count check against /api/me catches anything missed and, only then, triggers a
  //    quiet background resync (at most every 6 h).
  const reconcileQueue = new Set();
  let reconciling = false;
  const saveCollectionSoon = debounce(() => S.collection && saveCollection(), 1500);
  const refreshFamiliesSoon = debounce(() => getFamilies(true).catch(() => {}), 3000);
  let lastChangeAt = 0;

  function collectionChanged() {
    lastChangeAt = Date.now();
    saveCollectionSoon();
    refreshFamiliesSoon();
    S.rev++;
    scheduleScan();
    emit('sync');
  }

  function reconcile(ids) {
    if (!S.collection) return;
    for (const id of ids) if (id && /^\d+$/.test(String(id))) reconcileQueue.add(String(Number(id)));
    drainReconcile();
  }
  async function drainReconcile() {
    if (reconciling) return;
    reconciling = true;
    try {
      while (reconcileQueue.size) {
        const id = reconcileQueue.values().next().value;
        reconcileQueue.delete(id);
        try {
          applyCopies(id, await apiGet(`/api/collection/${id}`));
        } catch {}
      }
    } finally {
      reconciling = false;
    }
  }

  // set one card's row from its copies list (an empty list means no longer owned)
  function applyCopies(id, j) {
    if (!S.collection || !j || !Array.isArray(j.copies)) return;
    id = String(Number(id));
    const prev = S.collection.get(id);
    const copies = j.copies;
    if (!copies.length) {
      if (prev) {
        S.collection.delete(id);
        collectionChanged();
      }
      return;
    }
    let f = prev ? prev.f & ~F.auction : 0;
    if (copies.some((c) => c.auction_id || c.hold === 'sale' || c.state === 'escrow')) f |= F.auction;
    const free = copies.filter((c) => (c.state || 'available') === 'available' && !c.auction_id && !c.hold).length;
    // copies don't say which are locked in an album or tome: keep the previous locked share
    const lockedPrev = prev ? Math.max(0, prev.q - (prev.u ?? prev.q)) : 0;
    const row = {
      id,
      q: copies.length,
      u: Math.max(0, Math.min(free, copies.length - lockedPrev)),
      r: j.rarity || prev?.r,
      famId: j.primaryFamily?.id ?? prev?.famId ?? null,
      famName: j.primaryFamily?.name ?? prev?.famName ?? null,
      name: j.name || prev?.name || '',
      f,
      dom: j.domain?.id || prev?.dom || (j.primaryFamily?.id || '').split('.')[0] || null,
    };
    if (prev && prev.q === row.q && prev.u === row.u && prev.f === row.f && prev.r === row.r) return;
    S.collection.set(id, row);
    collectionChanged();
  }

  // the collection grid the game loads anyway: refresh those rows (never removes others)
  function mergeCollectionPage(data) {
    if (!S.collection || !Array.isArray(data?.items)) return;
    let changed = false;
    const seen = new Map();
    for (const it of data.items) {
      if (!it?.card?.subjectId) continue;
      const r = rowFromItem(it);
      const acc = seen.get(r.id);
      if (acc) {
        acc.q += r.q;
        acc.u += r.u;
        acc.f |= r.f;
      } else seen.set(r.id, r);
    }
    for (const [id, r] of seen) {
      const prev = S.collection.get(id);
      if (!prev || prev.q !== r.q || prev.u !== r.u || prev.f !== r.f) {
        S.collection.set(id, r);
        changed = true;
      }
    }
    if (changed) collectionChanged();
  }

  // find card / auction / opening ids anywhere in a payload
  function collectIds(data) {
    const out = { subjects: new Set(), auctions: new Set(), openings: new Set() };
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 6) return;
      if (Array.isArray(o)) return o.forEach((x) => walk(x, depth + 1));
      for (const [k, v] of Object.entries(o)) {
        if ((k === 'subjectId' || k === 'subject_id') && (typeof v === 'string' || typeof v === 'number')) out.subjects.add(String(v));
        else if ((k === 'auctionId' || k === 'auction_id') && typeof v === 'string') out.auctions.add(v);
        else if ((k === 'openingId' || k === 'opening_id') && typeof v === 'string') out.openings.add(v);
        else if (v && typeof v === 'object') walk(v, depth + 1);
      }
    };
    walk(data, 0);
    return out;
  }

  // the game's reply to something you did in this tab (packs, fusion, Vortex, trades, listings)
  function onOwnAction(path, data) {
    const ids = collectIds(data);
    if (/\/packs\/open/.test(path) && Array.isArray(data?.cards) && data.id) noteOpening(data.id, data);
    ids.openings.forEach(fetchOpening);
    reconcile([...ids.subjects].slice(0, 40));
    ids.auctions.forEach(reconcileAuction);
  }

  // live events from the game's own event stream
  function onGameEvent(type, data) {
    const ids = collectIds(data);
    if (/^opening\./.test(type)) {
      const oid = data?.openingId || data?.id;
      if (oid) fetchOpening(oid);
    }
    if (/^auction\.(won|sold|created|cancelled|expired|reinstated|withdrawn)$/.test(type)) {
      if (ids.subjects.size) reconcile([...ids.subjects]);
      else ids.auctions.forEach(reconcileAuction);
    }
    if (/^(trade\.accepted|transfer\.(claimed|received))$/.test(type)) reconcile([...ids.subjects].slice(0, 40));
  }
  function fetchOpening(oid) {
    if (seenOpenings.has(oid)) return;
    apiGet(`/api/openings/${encodeURIComponent(oid)}`)
      .then((j) => noteOpening(oid, j))
      .catch(() => {});
  }
  function reconcileAuction(aid) {
    apiGet(`/api/auctions/${encodeURIComponent(aid)}`)
      .then((a) => {
        ingestAuction(a);
        if (a?.card?.subjectId) reconcile([a.card.subjectId]);
      })
      .catch(() => {});
  }

  // pack openings: add pulled cards right away (badges update instantly), then confirm
  // each card's exact copy count from the server
  const seenOpenings = new Set();
  let openingsLoaded = false;
  async function noteOpening(id, data) {
    if (!S.collection || !Array.isArray(data?.cards) || !data.cards.length) return;
    if (!openingsLoaded) {
      openingsLoaded = true;
      ((await store.get('openings')) || []).forEach((x) => seenOpenings.add(x));
    }
    if (seenOpenings.has(id)) return;
    seenOpenings.add(id);
    store.set('openings', [...seenOpenings].slice(-300));
    const when = Date.parse(data.committedAt || data.presentedAt || '') || Date.now();
    const ids = [];
    for (const c of data.cards) {
      const card = c.card || {};
      const sid = String(c.subjectId || card.subjectId || '');
      if (!sid) continue;
      ids.push(sid);
      if (when < S.collectionAt) continue; // already counted by the last full sync
      const prev = S.collection.get(sid);
      if (prev) {
        prev.q += 1;
        prev.u = (prev.u ?? prev.q - 1) + 1;
      } else
        S.collection.set(sid, {
          id: sid,
          q: 1,
          u: 1,
          r: c.rarity || card.rarity,
          famId: card.primaryFamily?.id || null,
          famName: card.primaryFamily?.name || null,
          name: card.name || '',
          f: 0,
          dom: card.domain?.id || null,
        });
    }
    collectionChanged();
    reconcile(ids);
  }

  // safety net: compare the game's own owned-card count with the snapshot
  let mismatchSince = 0;
  function onMe(me) {
    S.me = me;
    S.meAt = Date.now();
    const server = me?.collection?.uniqueOwned;
    if (!S.collection || typeof server !== 'number') return;
    if (server === S.collection.size) mismatchSince = 0;
    else if (!mismatchSince) mismatchSince = Date.now();
    maybeAutoResync();
  }
  function maybeAutoResync() {
    if (!S.collection || S.syncing || reconciling || reconcileQueue.size || document.visibilityState !== 'visible') return;
    const now = Date.now();
    const drift = mismatchSince && now - mismatchSince > 3 * 60e3 && now - lastChangeAt > 60e3;
    const old = now - S.collectionAt > 7 * 864e5;
    if ((drift || old) && now - (S.autoSyncAt || 0) > 6 * 3600e3) {
      S.autoSyncAt = now;
      store.set('autoSyncAt', now);
      syncCollection({ quiet: true });
    }
  }
  setInterval(maybeAutoResync, 60e3);

  // fusion recipes: the game's own per-player figures (talents included)
  let fusionInflight = null;
  function setFusion(j) {
    if (!Array.isArray(j?.recipes)) return;
    const recipes = {};
    for (const r of j.recipes) if (r?.from && r.cards > 0) recipes[r.from] = { to: r.to, cards: r.cards, usual: r.usual || null };
    S.fusion = { t: Date.now(), recipes, maxBatches: j.maxBatches || null, rarities: j.rarities || {} };
    store.set('fusion', S.fusion);
    bump();
  }
  function getFusion(force = false) {
    if (!force && S.fusion && Date.now() - S.fusion.t < FUSION_TTL) return Promise.resolve(S.fusion);
    if (fusionInflight) return fusionInflight;
    fusionInflight = apiGet('/api/fusion')
      .then((j) => (setFusion(j), S.fusion))
      .finally(() => (fusionInflight = null));
    return fusionInflight;
  }
  const fuseCost = (r) => S.fusion?.recipes?.[r]?.cards || FUSE_COST[r];

  // market: the game's own 7-day median sale price per rarity (completed sales only)
  let mstatsInflight = null;
  function getMarketStats(force = false) {
    if (!force && S.mstats && Date.now() - S.mstats.t < MSTATS_TTL) return Promise.resolve(S.mstats);
    if (mstatsInflight) return mstatsInflight;
    mstatsInflight = apiGet('/api/market/stats?period=7d')
      .then((j) => {
        if (!Array.isArray(j?.rarity)) return S.mstats;
        const med = {};
        const sales = {};
        for (const x of j.rarity) {
          if (!x?.rarity || x.median == null) continue;
          med[x.rarity] = micro(x.median);
          sales[x.rarity] = x.sales || 0;
        }
        S.mstats = { t: Date.now(), builtAt: j.builtAt || null, med, sales };
        store.set('mstats', S.mstats);
        bump();
        return S.mstats;
      })
      .finally(() => (mstatsInflight = null));
    return mstatsInflight;
  }
  // market value of one fusion: median of the card you get minus the medians of the cards you put in
  function fuseValue(r) {
    const med = S.mstats?.med;
    const to = S.fusion?.recipes?.[r]?.to || RARITIES[rarityIdx(r) + 1];
    if (!med || med[r] == null || med[to] == null) return null;
    const cost = fuseCost(r);
    return { put: cost * med[r], get: med[to], net: med[to] - cost * med[r], cost, to, each: med[r] };
  }

  // families
  let famInflight = null;
  function setFamilies(f) {
    S.families = f;
    S.famById = new Map();
    S.famByName = new Map();
    const ms = new Set(BASE_MILESTONES);
    for (const x of f.list) {
      S.famById.set(x.id, x);
      if (!S.famByName.has(x.name)) S.famByName.set(x.name, x);
      if (x.nextMilestone) ms.add(x.nextMilestone);
    }
    S.milestones = [...ms].sort((a, b) => a - b);
  }
  function getFamilies(force = false) {
    if (!force && S.families && Date.now() - S.families.t < FAMILY_TTL) return Promise.resolve(S.families);
    if (famInflight) return famInflight;
    famInflight = apiGet('/api/me/families?tags=1&sort=closest&limit=1000')
      .then((j) => {
        const list = (j.families || []).map((x) => ({
          id: x.id,
          name: x.name,
          domain: x.domain,
          collected: x.collected || 0,
          nextMilestone: x.nextMilestone || null,
          economic: x.economic !== false,
          power: x.power ?? null,
          nextPower: x.nextPower ?? null,
          parent: x.parent || null,
        }));
        setFamilies({ t: Date.now(), list });
        store.set('families', S.families);
        bump();
        return S.families;
      })
      .finally(() => (famInflight = null));
    return famInflight;
  }
  const floorOf = (c) => {
    let f = 0;
    for (const m of S.milestones) if (c >= m) f = m;
    return f;
  };
  const tierOf = (c) => S.milestones.filter((m) => c >= m).length;

  // me / production
  async function getMe(force = false) {
    if (!force && S.me && Date.now() - S.meAt < ME_TTL) return;
    const [me, prod] = await Promise.all([apiGet('/api/me'), apiGet('/api/me/production')]);
    S.me = me;
    S.prod = prod;
    S.meAt = Date.now();
    emit('me');
  }

  // collection snapshot
  function rowFromItem(it) {
    const c = it.card || {};
    let f = 0;
    if (it.locked) f |= F.locked;
    if (it.inAuction) f |= F.auction;
    if (it.inAlbums) f |= F.albums;
    if (c.numberOne) f |= F.numberOne;
    if (it.veil) f |= F.veil;
    if (c.mods && (Array.isArray(c.mods) ? c.mods.length : Object.keys(c.mods).length)) f |= F.mods;
    return {
      id: String(c.subjectId),
      q: it.quantity || 1,
      // copies that can leave the collection now (the game's own count: excludes listed,
      // gifted, offered and locked-in-album/tome copies)
      u: it.usable ?? (it.quantity || 1),
      r: c.rarity,
      famId: c.primaryFamily?.id || null,
      famName: c.primaryFamily?.name || null,
      name: c.name || '',
      f,
      dom: c.domain?.id || (c.primaryFamily?.id || '').split('.')[0] || null,
    };
  }
  async function saveCollection() {
    const rows = [...S.collection.values()].map((x) => [x.id, x.q, rarityIdx(x.r), x.famId, x.famName, x.name, x.f, x.dom, x.u]);
    await store.set('collection', { t: S.collectionAt, rows });
  }
  function loadCollection(o) {
    if (!o?.rows) return;
    S.collection = new Map(
      o.rows.map(([id, q, r, famId, famName, name, f, dom, u]) => [
        id,
        { id, q, u: u ?? q, r: RARITIES[r], famId, famName, name, f, dom: dom || (famId || '').split('.')[0] || null },
      ])
    );
    S.collectionAt = o.t || 0;
  }

  async function syncCollection({ quiet = false } = {}) {
    if (S.syncing) return;
    S.syncing = true;
    S.sync = { pages: 0, cards: 0, expected: S.me?.collection?.uniqueOwned || S.collection?.size || 0, error: null };
    emit('sync');
    try {
      if (!S.sync.expected) {
        try {
          await getMe();
          S.sync.expected = S.me?.collection?.uniqueOwned || 0;
        } catch {}
      }
      const rows = new Map();
      let cursor = null;
      let pages = 0;
      do {
        const q = `/api/collection?sort=rarity&split=1&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const j = await apiGet(q, 700);
        for (const it of j.items || []) {
          const r = rowFromItem(it);
          const prev = rows.get(r.id);
          if (prev) {
            prev.q += r.q;
            prev.u += r.u;
            prev.f |= r.f;
          } else rows.set(r.id, r);
        }
        cursor = j.nextCursor;
        pages++;
        S.sync.pages = pages;
        S.sync.cards = rows.size;
        emit('sync');
      } while (cursor && pages < 500);
      S.collection = rows;
      S.collectionAt = Date.now();
      await saveCollection();
      await getFamilies(true);
      mismatchSince = 0;
      if (!quiet) toast(`Collection synced — ${fmt(rows.size)} cards`);
    } catch (e) {
      S.sync.error = e.message || String(e);
      if (!quiet) toast(`Sync stopped: ${S.sync.error}`, true);
    } finally {
      S.syncing = false;
      bump();
      emit('sync');
    }
  }

  // ───────────────────────── card intel ─────────────────────────
  // Pulsar games: no hover intel or card badges anywhere inside them (lobbies included),
  // so Lens never adds information while you're actually playing. Vortex is a choice screen, not a skill game, so it stays on.
  const GAME_ZONE = /^\/(constellation|photon|umbra|timeline|aion|horizon|exploration)(\/|$)/;
  const inGameZone = () => GAME_ZONE.test(location.pathname);

  // a card is any .kc: links in grids, <article> on pack reveals, etc.
  const cardRoot = (kc) => kc.closest('a.kc-link, .kc-article') || kc;
  // some screens (pack reveal) lay a transparent button over the card as a sibling,
  // so fall back to the nearest small container that holds exactly one card
  function cardFromTarget(t) {
    if (!t?.closest) return null;
    const kc = t.closest('.kc');
    if (kc) return kc;
    let p = t;
    for (let i = 0; i < 3 && p && p !== document.body; i++, p = p.parentElement) {
      const found = p.querySelectorAll('.kc');
      if (found.length === 1) return found[0];
      if (found.length > 1) return null;
    }
    return null;
  }

  function readTile(a) {
    const href = a.getAttribute('href') || '';
    const m =
      href.match(/\/card\/(\d+)/) ||
      (a.querySelector('img.kc-img')?.getAttribute('src') || '').match(/\/media\/cards\/(\d+)\//) ||
      (a.querySelector('[data-testid="card-corner"]')?.textContent || '').match(/(\d+)/);
    if (!m) return null;
    const kc = a.querySelector('.kc');
    const rarity =
      RARITIES.find((r) => kc?.classList.contains(`kc-${r.toLowerCase()}`)) ||
      a.querySelector('.kc-rarity-name')?.textContent.trim() ||
      (a.getAttribute('aria-label') || '').split(',')[1]?.trim();
    return {
      id: String(Number(m[1])),
      auctionId: href.match(/\/market\/([0-9a-f-]{36})/)?.[1] || null,
      name: a.querySelector('.kc-name')?.textContent.trim() || (a.getAttribute('aria-label') || '').split(',')[0],
      rarity,
      famName: a.querySelector('.kc-family')?.textContent.trim() || (a.getAttribute('aria-label') || '').split(',').slice(2).join(',').trim(),
    };
  }

  function intel(t) {
    const own = S.collection?.get(t.id) || null;
    const fam = (own?.famId && S.famById.get(own.famId)) || (t.famName && S.famByName.get(t.famName)) || null;
    const r = { own, fam, synced: !!S.collection };
    if (fam) {
      const c = fam.collected;
      r.c = c;
      r.floor = floorOf(c);
      r.tier = tierOf(c);
      r.next = fam.nextMilestone;
      r.need = r.next ? r.next - c : null;
      if (own) {
        r.critical = own.q <= 1 && r.floor > 0 && c - 1 < r.floor;
      } else if (S.collection) {
        r.tierUp = r.need === 1;
      }
    }
    return r;
  }

  function plateNumber(wrap) {
    const pl = wrap?.querySelector('.price-plate');
    if (!pl) return null;
    const m = pl.innerText.replace(/,/g, '').match(/\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  }

  // market tiles say how a listing ended (data-ended="sold" | "noSale"): free, exact outcome data
  function noteTileOutcome(a, t) {
    const li = a.closest('.mk-pr-tile');
    const ended = li?.dataset.ended;
    const aid = t.auctionId || li?.dataset.glide;
    if (!ended || !aid) return;
    const st = ended === 'sold' ? 'sold' : ended === 'noSale' ? 'expired' : null;
    if (!st) return;
    const o = S.obs[aid];
    if (o && o.st === st && !o.smp) return;
    const bidsTxt = li.querySelector('.price-plate')?.innerText.match(/(\d+)\s*bids?/i);
    S.obs[aid] = {
      c: t.id,
      r: t.rarity || o?.r || null,
      b: Math.max(o?.b || 0, bidsTxt ? Number(bidsTxt[1]) : 0),
      st,
      e: o?.e || Date.now(),
      fp: o?.fp ?? null,
      t: Date.now(),
      smp: false,
    };
    saveObs();
  }

  // ───────────────────────── tile badges ─────────────────────────
  function decorate(a) {
    const t = readTile(a);
    if (!t) return;
    noteTileOutcome(a, t);
    const host = a.querySelector('.kc-window') || a;
    let el = host.querySelector(':scope > .kl-badges');
    if (!S.settings.badges) {
      el?.remove();
      return;
    }
    // Small cards (home widgets, carousels) get no labels: they'd swamp the art and the
    // game's own markers. Hover still works on them. Vortex keeps a compact glyph-only form,
    // because its card picker uses small cards and "safe to throw" matters there.
    const face = a.querySelector('.kc') || a;
    const small = face.offsetWidth > 0 && face.offsetWidth < 150;
    const compact = small && location.pathname === '/vortex';
    if (small && !compact) {
      el?.remove();
      return;
    }
    const wrap = a.closest('.kc-wrap') || a.parentElement;
    const marketPrice = plateNumber(wrap);
    const sig = `${t.id}|${S.rev}|${marketPrice}|${compact}`;
    if (el && el.dataset.sig === sig) return;

    const i = intel(t);
    const chips = [];
    // skip our ×N when the game already prints a copy count on the card
    if (i.own && i.own.q > 1 && !/×\s*\d/.test(a.querySelector('.kc-badge')?.textContent || '')) {
      chips.push(`<span class="kl-chip kl-dupe" data-g="×${i.own.q}" title="You own ${i.own.q} copies (${i.own.q - 1} spare)">×${i.own.q}</span>`);
    }
    if (i.own && i.critical && S.settings.critical) {
      chips.push(
        `<span class="kl-chip kl-crit" data-g="⚑" title="Your only copy. Selling or fusing it drops ${esc(i.fam.name)} from ${i.c} to ${i.c - 1} — below the ${i.floor}-card tier.">⚑ tier</span>`
      );
    }
    if (!i.own && i.synced && S.settings.newBadge) {
      chips.push(`<span class="kl-chip kl-new" data-g="N" title="Not in your collection">NEW</span>`);
    }
    if (i.tierUp) {
      chips.push(
        `<span class="kl-chip kl-up" data-g="▲" title="Owning this takes ${esc(i.fam.name)} from ${i.c} to ${i.next} — next family tier">▲ tier</span>`
      );
    }
    for (const pl of plugins) if (pl.chips) chips.push(...(pl.chips(t, i) || []));
    const p = priceFresh(t.id);
    if (p && p.med != null) {
      let cls = '';
      let extra = '';
      if (marketPrice != null && p.med > 0) {
        const pct = (marketPrice - p.med) / p.med;
        if (pct <= -0.15) cls = ' kl-good';
        else if (pct >= 0.25) cls = ' kl-bad';
        extra = ` · listed ${pct >= 0 ? '+' : ''}${Math.round(pct * 100)}% vs median`;
      }
      chips.push(
        `<span class="kl-chip kl-price${cls}" title="30-day median ${fmt(p.med)} (${p.n} sale${p.n === 1 ? '' : 's'})${extra}">≈ ${fmt(p.med)}</span>`
      );
    }

    if (!chips.length) {
      el?.remove();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.className = 'kl-badges';
      if (getComputedStyle(host).position === 'static') host.classList.add('kl-host');
      host.appendChild(el);
    }
    el.dataset.sig = sig;
    el.classList.toggle('kl-compact', compact);
    el.innerHTML = chips.join('');
  }

  let scanQueued = false;
  function scheduleScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      if (inGameZone()) {
        document.querySelectorAll('.kl-badges').forEach((b) => b.remove());
        if (hoverA) hideTip();
      } else document.querySelectorAll('.kc').forEach((kc) => decorate(cardRoot(kc)));
      if (S.settings.autoPrice && !inGameZone()) watchCards();
      for (const p of plugins) p.onScan?.();
    });
  }

  // ───────── page price scan ─────────
  // Every full-size card the page has loaded gets priced, one at a time (SCAN_GAP apart,
  // KosMore's pace): cards on screen first, then the rest of the page top to bottom,
  // including ones you scrolled past. Nothing is dropped; a card leaves the queue only
  // when it's priced, cached (2 h), or gone from the page. Only one scan request sits in
  // the shared queue at a time, so a hover never waits behind a backlog.
  const onScreen = new Set();
  const seenTiles = new WeakSet();
  const scanFailed = new Map(); // id -> time of last failure (retry after a minute)
  let scanIO = null;
  let scanBusy = false;
  let scanTimer = null;
  function watchCards() {
    if (!scanIO) {
      scanIO = new IntersectionObserver(
        (entries) => {
          for (const e of entries) e.isIntersecting ? onScreen.add(e.target) : onScreen.delete(e.target);
          pumpScan();
        },
        { threshold: 0.25 }
      );
    }
    document.querySelectorAll('.kc').forEach((kc) => {
      const a = cardRoot(kc);
      if (!seenTiles.has(a)) {
        seenTiles.add(a);
        scanIO.observe(a);
      }
    });
    pumpScan();
  }
  const scanAllowed = () => S.settings.autoPrice && !document.hidden && !inGameZone();
  function scanCandidate(a) {
    if (!a.isConnected) return null;
    // small cards (home widgets, carousels) show no price badge, so they wait for a hover;
    // cards hidden by the page (offsetWidth 0) are skipped too
    const face = a.querySelector('.kc') || a;
    if (face.offsetWidth < 150) return null;
    const t = readTile(a);
    if (!t || priceFresh(t.id) || priceInflight.has(t.id)) return null;
    if (Date.now() - (scanFailed.get(t.id) || 0) < 60e3) return null;
    return { a, id: t.id };
  }
  function pumpScan() {
    if (scanBusy || !scanAllowed()) return;
    let pick = null;
    for (const a of onScreen) {
      if (!a.isConnected) onScreen.delete(a);
      else if ((pick = scanCandidate(a))) break;
    }
    if (!pick) {
      for (const kc of document.querySelectorAll('.kc')) if ((pick = scanCandidate(cardRoot(kc)))) break;
    }
    if (!pick) return;
    scanBusy = true;
    const wanted = () => (pick.a.isConnected && scanAllowed()) || hoverA === pick.a;
    getPrice(pick.id, false, wanted)
      .catch((e) => {
        if (e?.message !== 'skipped') scanFailed.set(pick.id, Date.now());
      })
      .finally(() => {
        scanBusy = false;
        clearTimeout(scanTimer);
        scanTimer = setTimeout(pumpScan, 0);
      });
  }
  document.addEventListener('visibilitychange', () => pumpScan());

  // ───────────────────────── hover tooltip ─────────────────────────
  const tip = document.createElement('div');
  tip.className = 'kl-tip';
  tip.setAttribute('role', 'tooltip');
  let hoverA = null;
  let hoverTimer = null;
  let tipRefresh = null;
  listeners.add((type) => type === 'obs' && tipRefresh && tipRefresh());

  function sparkline(sales, med) {
    const W = 268;
    const H = 46;
    const P = 4;
    if (!sales.length) return '';
    const ys = sales.map((s) => s[1]);
    let lo = Math.min(...ys, med ?? Infinity);
    let hi = Math.max(...ys, med ?? -Infinity);
    if (hi === lo) {
      hi += 1;
      lo -= 1;
    }
    const t0 = sales[0][0];
    const t1 = sales[sales.length - 1][0];
    const x = (t) => (t1 === t0 ? W / 2 : P + ((t - t0) / (t1 - t0)) * (W - 2 * P));
    const y = (v) => P + (1 - (v - lo) / (hi - lo)) * (H - 2 * P);
    const pts = sales.map((s) => `${x(s[0]).toFixed(1)},${y(s[1]).toFixed(1)}`);
    const line = pts.join(' ');
    const area = sales.length > 1 ? `M${pts[0]} L${pts.slice(1).join(' L')} L${x(t1).toFixed(1)},${H} L${x(t0).toFixed(1)},${H} Z` : '';
    const medY = med != null ? y(med).toFixed(1) : null;
    const last = sales[sales.length - 1];
    return `<svg class="kl-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">
      <defs><linearGradient id="kl-g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#f5c96a" stop-opacity=".35"/><stop offset="1" stop-color="#f5c96a" stop-opacity="0"/></linearGradient></defs>
      ${medY ? `<line x1="0" x2="${W}" y1="${medY}" y2="${medY}" class="kl-spark-med"/>` : ''}
      ${area ? `<path d="${area}" fill="url(#kl-g)"/>` : ''}
      ${sales.length > 1 ? `<polyline points="${line}" class="kl-spark-line"/>` : ''}
      ${sales.map((s) => `<circle cx="${x(s[0]).toFixed(1)}" cy="${y(s[1]).toFixed(1)}" r="2"/>`).join('')}
      <circle cx="${x(last[0]).toFixed(1)}" cy="${y(last[1]).toFixed(1)}" r="3.5" class="kl-spark-last"/>
    </svg>`;
  }

  function famBar(i) {
    const f = i.fam;
    const c = i.c;
    const next = i.next;
    if (!next) return `<div class="kl-row"><b>${esc(f.name)}</b> · ${c} cards · max tier</div>`;
    const prev = i.floor;
    const pct = Math.max(0, Math.min(1, (c - prev) / (next - prev)));
    let note = '';
    if (i.own) {
      note = i.critical
        ? `<div class="kl-warn">Only copy — losing it drops ${esc(f.name)} below its ${prev}-card tier.</div>`
        : i.own.q > 1
          ? `<div class="kl-ok">${i.own.q - 1} spare cop${i.own.q - 1 === 1 ? 'y' : 'ies'} — safe to sell or fuse.</div>`
          : prev > 0
            ? `<div class="kl-ok">${c - prev} card${c - prev === 1 ? '' : 's'} of slack above the tier.</div>`
            : '';
    } else if (i.synced) {
      note = i.tierUp
        ? `<div class="kl-up-note">Owning this reaches the next tier (${next}).</div>`
        : `<div class="kl-muted">Owning this: ${c + 1}/${next}.</div>`;
    }
    const pw = f.power != null && f.nextPower != null ? ` · power ${fmt(f.power)} → ${fmt(f.nextPower)}` : '';
    return `<div class="kl-row"><b>${esc(f.name)}</b>${f.economic ? '' : ' <span class="kl-muted">(no income)</span>'}</div>
      <div class="kl-bar"><span style="width:${(pct * 100).toFixed(1)}%"></span></div>
      <div class="kl-row kl-muted">${c} / ${next} for tier ${i.tier + 1} · ${i.need} to go${pw}</div>${note}`;
  }

  // open listings Lens has seen for this card while you browsed (no extra requests)
  function liveListings(id) {
    const now = Date.now();
    return Object.entries(S.obs)
      .filter(([, o]) => o.c === id && o.e > now && (!o.st || o.st === 'open') && o.fp == null && !o.smp)
      .map(([aid, o]) => ({ aid, ...o }))
      .sort((a, b) => (a.cp ?? 1e12) - (b.cp ?? 1e12));
  }
  function liveLine(id) {
    const live = liveListings(id);
    if (!live.length) return '';
    const low = live[0].cp;
    const mine = live.filter((l) => l.me).length;
    return `<div class="kl-row kl-live">Listed now: <b>${live.length}</b>${low != null ? ` · from <b>${fmt(low)}</b>` : ''}${mine ? ` · ${mine} yours` : ''} <span class="kl-muted">(seen ${ago(Math.max(...live.map((l) => l.t)))})</span></div>`;
  }

  function statsGrid(t) {
    const m = marketStats(t.id, t.rarity);
    const sampling = S.prices[t.id]?.s.some((s) => s[2] && bidInflight.has(s[2]));

    const avg = m.n14
      ? `<b>${fmt(m.avg14)}</b><span>${m.n14} sale${m.n14 === 1 ? '' : 's'}</span>`
      : `<b class="kl-muted">—</b><span>no sales</span>`;

    const seen = m.sold + m.unsold;
    let rate;
    if (seen >= 3) {
      const r = m.sold / seen;
      rate = `<b class="${r >= 0.7 ? 'kl-pos' : r < 0.4 ? 'kl-neg' : ''}">${Math.round(r * 100)}%</b><span>${m.sold} of ${seen} seen</span>`;
    } else if (m.rarityRate != null) {
      rate = `<b class="kl-muted" title="Not enough listings of this card observed yet; showing the ${esc(t.rarity)} average">~${Math.round(m.rarityRate * 100)}%</b><span>${esc(t.rarity)} avg</span>`;
    } else {
      rate = `<b class="kl-muted">—</b><span>${seen ? `${m.sold} of ${seen} seen` : 'none seen yet'}</span>`;
    }
    if (m.live) rate = rate.replace('</span>', ` · ${m.live} live</span>`);

    const bids = m.nb
      ? `<b>${fmt(m.avgBids, 1)}</b><span>${m.nb} sale${m.nb === 1 ? '' : 's'}${sampling ? '…' : ''}</span>`
      : sampling
        ? `<b class="kl-muted">…</b><span>checking</span>`
        : `<b class="kl-muted">—</b><span>${m.n14 ? 'no data' : 'no sales'}</span>`;

    return `<div class="kl-mstats">
      <div title="Average sale price over the last 14 days"><div class="kl-lbl">14d avg</div>${avg}</div>
      <div title="Share of listings that ended with at least one bid, over the last 14 days. Built from listings Lens has seen while you browse the Market."><div class="kl-lbl">Sale rate</div>${rate}</div>
      <div title="Average number of bids on sales in the last 14 days"><div class="kl-lbl">Avg bids</div>${bids}</div>
    </div>`;
  }

  function renderTip(t) {
    const i = intel(t);
    const p = S.prices[t.id];
    const loading = priceInflight.has(t.id) && !p;
    let market;
    if (p) {
      if (!p.n) market = `<div class="kl-muted">No sales in the last ${p.d} days.</div>${statsGrid(t)}`;
      else {
        const last = p.s[p.s.length - 1];
        market = `<div class="kl-big">${fmt(p.med)}<small> median</small></div>
          <div class="kl-row kl-muted">low ${fmt(p.lo)} · high ${fmt(p.hi)} · ${p.n} sale${p.n === 1 ? '' : 's'}</div>
          ${sparkline(p.s, p.med)}
          ${last ? `<div class="kl-row kl-muted">last sold ${fmt(last[1])} · ${ago(last[0])}</div>` : ''}
          ${statsGrid(t)}${liveLine(t.id)}`;
      }
    } else if (loading) market = `<div class="kl-skel"><i></i><i></i><i></i></div>`;
    else market = `<div class="kl-muted">Couldn't load prices.</div>`;

    let ownTxt;
    if (!i.synced) ownTxt = `<span class="kl-muted">Sync your collection in Lens to see ownership.</span>`;
    else if (!i.own) ownTxt = `<span class="kl-new-txt">Not in your collection</span>`;
    else {
      const flags = [];
      if (i.own.f & F.numberOne) flags.push('#1 copy');
      if (i.own.f & F.locked) flags.push('locked');
      if (i.own.f & F.auction) flags.push('listed');
      if (i.own.f & F.albums) flags.push('in album');
      ownTxt = `You own <b>×${i.own.q}</b>${flags.length ? ` <span class="kl-muted">· ${flags.join(' · ')}</span>` : ''}`;
    }

    tip.innerHTML = `
      <div class="kl-tip-head"><span class="kl-rar ${rarityClass(t.rarity)}">${esc(t.rarity || '')}</span><b>${esc(t.name)}</b></div>
      <section><div class="kl-lbl">Market · ${p?.d || 30} days</div>${market}</section>
      <section><div class="kl-lbl">Collection</div><div class="kl-row">${ownTxt}</div></section>
      ${i.fam ? `<section><div class="kl-lbl">Family</div>${famBar(i)}</section>` : ''}
      <div class="kl-foot">Kosmora Lens${p ? ` · prices ${ago(p.t)}` : ''}</div>`;
  }

  function placeTip(a) {
    const r = a.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const gap = 12;
    let left = r.right + gap;
    if (left + w > innerWidth - 8) left = r.left - gap - w;
    if (left < 8) left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    let top = r.top + r.height / 2 - h / 2;
    top = Math.max(8, Math.min(innerHeight - h - 8, top));
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function showTip(a) {
    const t = readTile(a);
    if (!t) return;
    const wanted = () => hoverA === a;
    const refresh = () => wanted() && (renderTip(t), placeTip(a));
    const afterPrice = () => {
      if (wanted()) sampleBids(t.id, wanted);
      refresh();
    };
    if (!priceFresh(t.id) || needsResolve(t.id)) getPrice(t.id, true).catch(() => {}).finally(afterPrice);
    else sampleBids(t.id, wanted);
    tipRefresh = refresh;
    if (!S.families) getFamilies().catch(() => {});
    renderTip(t);
    if (!tip.isConnected) document.documentElement.appendChild(tip);
    tip.classList.add('kl-show');
    placeTip(a);
  }
  function hideTip() {
    clearTimeout(hoverTimer);
    hoverA = null;
    tipRefresh = null;
    tip.classList.remove('kl-show');
  }

  // Hover is decided by geometry, not DOM ancestry: the tooltip shows only while the
  // pointer is inside the card face itself (the .kc box) and hides as soon as it leaves,
  // including when the page scrolls under a still pointer.
  const ptr = { x: -1, y: -1 };
  let ptrQueued = false;
  function hitCard(x, y) {
    if (x < 0) return null;
    const el = document.elementFromPoint(x, y);
    if (!el || el.closest('.kl-tip, .kl-panel, .kl-orb, .kl-lob')) return null;
    const kc = cardFromTarget(el);
    if (!kc) return null;
    const r = kc.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom ? kc : null;
  }
  function evalHover() {
    ptrQueued = false;
    const kc = hitCard(ptr.x, ptr.y);
    const a = kc ? cardRoot(kc) : null;
    if (a === hoverA) return;
    hideTip();
    if (!a || !S.settings.tooltip || inGameZone()) return;
    hoverA = a;
    hoverTimer = setTimeout(() => hoverA === a && showTip(a), S.settings.hoverDelay);
  }
  const queueHover = () => {
    if (ptrQueued) return;
    ptrQueued = true;
    requestAnimationFrame(evalHover);
  };
  document.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType === 'touch') return;
      ptr.x = e.clientX;
      ptr.y = e.clientY;
      queueHover();
    },
    { passive: true, capture: true }
  );
  // pointer left the window entirely
  document.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget) {
      ptr.x = ptr.y = -1;
      hideTip();
    }
  });
  addEventListener(
    'scroll',
    () => {
      queueHover();
      if (hoverA && tip.classList.contains('kl-show')) placeTip(hoverA);
    },
    { passive: true, capture: true }
  );
  addEventListener('blur', () => {
    ptr.x = ptr.y = -1;
    hideTip();
  });

  // ───────────────────────── toast ─────────────────────────
  function toast(msg, bad = false) {
    const el = document.createElement('div');
    el.className = `kl-toast${bad ? ' kl-toast-bad' : ''}`;
    el.textContent = msg;
    document.documentElement.appendChild(el);
    requestAnimationFrame(() => el.classList.add('kl-show'));
    setTimeout(() => {
      el.classList.remove('kl-show');
      setTimeout(() => el.remove(), 400);
    }, 3500);
  }

  // ───────────────────────── panel ─────────────────────────
  const orb = document.createElement('button');
  orb.type = 'button';
  orb.className = 'kl-orb';
  orb.title = 'Kosmora Lens (Alt+L)';
  orb.innerHTML = `<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="14" class="kl-orb-track"/><circle cx="16" cy="16" r="14" class="kl-orb-prog" pathLength="100"/><path d="M16 6l2.2 5.8L24 14l-5.8 2.2L16 22l-2.2-5.8L8 14l5.8-2.2Z" class="kl-orb-star"/></svg><span class="kl-orb-dot"></span>`;

  const panel = document.createElement('aside');
  panel.className = 'kl-panel';
  panel.setAttribute('aria-label', 'Kosmora Lens');
  let tab = 'fusion';
  let fuseRarity = 'Common';
  let open = false;

  function togglePanel(force) {
    open = force ?? !open;
    panel.classList.toggle('kl-open', open);
    orb.classList.toggle('kl-active', open);
    if (open) {
      renderPanel();
      getFamilies().catch(() => {});
    }
  }
  orb.addEventListener('click', () => togglePanel());

  // Lens links and buttons that live inside the site's own app (lobby cards, card-page
  // section) can have their clicks swallowed by the app's click handling (seen in Firefox).
  // So Lens handles them first, in the capture phase: plain clicks navigate explicitly;
  // modified or middle clicks are left to the browser (new tab, etc.).
  window.addEventListener(
    'click',
    (e) => {
      const t = e.target;
      if (!t?.closest) return;
      const a = t.closest('.kl-lob a[href], .kl-panel a[href]');
      if (a) {
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        const href = a.getAttribute('href') || '';
        if (!href.startsWith('/')) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        // absolute URL: in Firefox, relative URLs used from an extension script resolve
        // against the extension, not the page
        window.location.href = new URL(href, document.location.origin).href;
        return;
      }
      const btn = t.closest('.kl-lob [data-kl-act]');
      if (btn) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!btn.disabled) plugins.some((p) => p.onAct?.(btn.dataset.klAct, btn));
      }
    },
    true
  );
  addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'l' || e.key === 'L' || e.code === 'KeyL')) {
      e.preventDefault();
      togglePanel();
    } else if (e.key === 'Escape' && open) togglePanel(false);
  });

  function updateOrb() {
    const prog = orb.querySelector('.kl-orb-prog');
    if (S.syncing && S.sync) {
      const pct = S.sync.expected ? Math.min(100, (S.sync.cards / S.sync.expected) * 100) : 50;
      prog.style.strokeDasharray = `${pct} 100`;
      orb.classList.add('kl-syncing');
    } else {
      prog.style.strokeDasharray = '0 100';
      orb.classList.remove('kl-syncing');
    }
    orb.classList.toggle('kl-stale', !S.collection);
  }

  const TABS = [
    ['fusion', 'Fusion'],
    ['settings', 'Settings'],
  ];

  const marketHref = (name) => `/market?q=${encodeURIComponent(name)}`;
  function syncBlock() {
    const pct = S.syncing && S.sync?.expected ? Math.min(100, (S.sync.cards / S.sync.expected) * 100) : null;
    const status = S.syncing
      ? `reading ${fmt(S.sync?.cards || 0)}${S.sync?.expected ? ` / ${fmt(S.sync.expected)}` : ''}`
      : S.collection
        ? `${fmt(S.collection.size)} cards · ${ago(S.collectionAt)}`
        : 'not read yet';
    return `<div class="kl-card">
      <div class="kl-row kl-between"><span title="Kept current from packs, market and your own actions. Lens resyncs by itself if its count drifts from the game's.">Collection · ${status}</span>
      <button class="kl-btn kl-ghost" data-act="sync" ${S.syncing ? 'disabled' : ''}>${S.collection ? 'Resync' : 'Read now'}</button></div>
      ${pct != null ? `<div class="kl-bar"><span style="width:${pct.toFixed(1)}%"></span></div>` : ''}
      ${S.sync?.error ? `<div class="kl-warn">Sync failed: ${esc(S.sync.error)}</div>` : ''}
    </div>`;
  }

  // ───────── fusion advisor ─────────
  // Only "good" fusions: no family loses a tier, nothing protected is touched, spare copies
  // go first (they earn nothing: income counts unique cards only), and the rest comes from
  // families with the most room above their tier.
  const FUSE_ORDER = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'];
  const NEAR_TIER = 2; // a family this close to its next tier keeps every card
  const plural = (r) => ({ Common: 'Commons', Uncommon: 'Uncommons', Rare: 'Rares', Epic: 'Epics', Legendary: 'Legendaries', Mythic: 'Mythics' })[r] || r;
  const fzCopied = new Set();
  let fusionMemo = null;

  function fusionAdvice() {
    const buffer = Math.max(0, Number(S.settings.fuseBuffer) || 0);
    const key = [S.rev, S.collection?.size, S.collectionAt, S.families?.t, S.fusion?.t, S.prod ? 1 : 0, buffer].join('|');
    if (fusionMemo?.key === key) return fusionMemo.v;
    const never = F.numberOne | F.veil | F.mods; // the game warns on #1; veiled/modded copies stay put
    const keepOne = F.locked | F.auction | F.albums; // spares may go, the last copy stays
    const slack = new Map();
    const famRoom = (fam) => {
      if (!slack.has(fam.id)) {
        const near = fam.nextMilestone && fam.nextMilestone - fam.collected <= NEAR_TIER;
        slack.set(fam.id, near ? 0 : Math.max(0, fam.collected - floorOf(fam.collected) - buffer));
      }
      return slack.get(fam.id);
    };
    const out = {};
    for (const r of FUSE_ORDER) out[r] = { r, spares: [], lasts: [], held: 0 };
    for (const x of S.collection.values()) {
      const o = out[x.r];
      if (!o) continue;
      if (x.f & never) {
        o.held += x.q;
        continue;
      }
      const u = Math.min(x.u ?? x.q, x.q);
      const spare = Math.min(x.q - 1, u);
      if (spare > 0) o.spares.push({ x, n: spare, spare: true });
      if (u >= x.q && !(x.f & keepOne)) o.lasts.push(x);
      else if (u < x.q || x.f & keepOne) o.held += x.q - spare;
    }
    // cheapest fuel claims family room first: Commons, then Uncommons, ...
    for (const r of FUSE_ORDER) {
      const o = out[r];
      const room = (x) => (!x.famId ? 1e9 : S.famById.has(x.famId) ? famRoom(S.famById.get(x.famId)) : -1);
      o.lasts.sort((a, b) => room(b) - room(a) || a.name.localeCompare(b.name));
      const take = [];
      for (const x of o.lasts) {
        if (!x.famId) take.push({ x, n: 1 });
        else {
          const fam = S.famById.get(x.famId);
          if (fam && famRoom(fam) > 0) {
            slack.set(fam.id, famRoom(fam) - 1);
            take.push({ x, n: 1 });
          } else o.held++;
        }
      }
      o.spares.sort((a, b) => b.n - a.n || a.x.name.localeCompare(b.x.name));
      o.items = [...o.spares, ...take];
      o.cost = fuseCost(r);
      o.copies = o.items.reduce((a, it) => a + it.n, 0);
      o.spareN = o.spares.reduce((a, it) => a + it.n, 0);
      o.fusions = Math.floor(o.copies / o.cost);
      delete o.lasts;
    }
    fusionMemo = { key, v: out };
    return out;
  }

  // the next batch: one "go" in the game (up to maxBatches fusions)
  function nextBatch(o) {
    const maxB = S.fusion?.maxBatches || 10;
    const fusions = Math.min(o.fusions, maxB);
    let need = fusions * o.cost;
    const cards = [];
    for (const it of o.items) {
      if (need <= 0) break;
      const n = Math.min(it.n, need);
      cards.push({ ...it, n });
      need -= n;
    }
    const lastN = cards.filter((c) => !c.spare).length;
    return { fusions, cards, lastN, spareN: fusions * o.cost - lastN, maxB };
  }

  let fusePicked = false; // the user chose a rarity themselves (don't auto-switch it)
  const fzAnyway = new Set(); // rarities where the user asked to see a money-losing batch
  const kosmo = (v) => fmt(v, v >= 100 ? 0 : 1);
  function viewFusion() {
    if (!S.fusion || Date.now() - S.fusion.t > FUSION_TTL) getFusion().catch(() => {});
    if (!S.mstats || Date.now() - S.mstats.t > MSTATS_TTL) getMarketStats().catch(() => {});
    if (!S.prod) getMe().catch(() => {});
    if (!S.collection) return syncBlock();
    if (!S.families) return `<div class="kl-skel"><i></i><i></i></div>`;
    const adv = fusionAdvice();
    const ready = FUSE_ORDER.filter((r) => adv[r].fusions > 0);
    if (!ready.length) return `<div class="kl-empty">Nothing safe to fuse.</div>`;
    const val = Object.fromEntries(FUSE_ORDER.map((r) => [r, fuseValue(r)]));
    const gains = ready.filter((r) => val[r] && val[r].net > 0);
    if (!ready.includes(fuseRarity) || (!fusePicked && gains.length && !gains.includes(fuseRarity))) fuseRarity = gains[0] || ready[0];
    const o = adv[fuseRarity];
    const v = val[fuseRarity];
    const to = S.fusion?.recipes?.[fuseRarity]?.to || RARITIES[rarityIdx(fuseRarity) + 1];
    const seg = FUSE_ORDER.map((r) => {
      const n = adv[r].fusions;
      const vr = val[r];
      const tag = n && vr ? `<i class="kl-fzv ${vr.net > 0 ? 'kl-pos' : 'kl-neg'}">${vr.net > 0 ? '+' : '−'}${kosmo(Math.abs(vr.net))}</i>` : '';
      const tip = n ? `${fmt(n)} safe fusion${n === 1 ? '' : 's'}${vr ? ` · ${vr.net > 0 ? '+' : '−'}${kosmo(Math.abs(vr.net))} each on the Market` : ''}` : 'None safe';
      return `<button class="kl-fzr${r === fuseRarity ? ' kl-on' : ''}${n ? '' : ' kl-off'}" data-act="fr" data-r="${r}" ${n ? '' : 'disabled'} title="${esc(tip)}">
        <span class="kl-gem ${rarityClass(r)}"></span><b>${n ? fmt(n) : '–'}</b><small>${r}</small>${tag}</button>`;
    }).join('');
    const eq = (left, right) =>
      `<div class="kl-fz-eq"><b>${fmt(left)}</b> ${left === 1 ? fuseRarity : plural(fuseRarity)}<span class="kl-fz-arrow">→</span><b>${fmt(right)}</b> ${right === 1 ? to : plural(to)}</div>`;
    // the fine print lives in hover titles, not on screen
    const why =
      `Lens skips #1, veiled, modded, listed, locked and album copies, and families within ${NEAR_TIER} of a tier. The new card is random.` +
      (v ? ` Market: ${v.cost} × ~${kosmo(v.each)} → ~${kosmo(v.get)} (7-day median sales).` : '');

    if (v && v.net <= 0 && !fzAnyway.has(fuseRarity)) {
      return `<div class="kl-fzseg">${seg}</div>
        <div class="kl-card kl-sell" title="${esc(why)}">
          <div class="kl-row kl-between"><div class="kl-lbl">Sell instead</div><b class="kl-neg">−${kosmo(-v.net)} per fusion</b></div>
          ${eq(v.cost, 1)}
          <button class="kl-link" data-act="fzany" data-r="${fuseRarity}">Show anyway</button>
        </div>`;
    }

    const b = nextBatch(o);
    const rest = o.fusions - b.fusions;
    const perCard = S.prod?.nextCardHourly?.[fuseRarity];
    const incomeTip = b.lastN === 0 ? ' Income unchanged: only spares.' : perCard != null ? ` Income −${fmt(b.lastN * perCard, 3)}/h until the new cards count.` : '';
    const meta = [
      v ? `<b class="${v.net > 0 ? 'kl-pos' : 'kl-neg'}">${v.net > 0 ? '+' : '−'}${kosmo(Math.abs(v.net))} each</b>` : '',
      rest > 0 ? `${fmt(rest)} more after` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const chips = b.cards
      .map((c) => {
        const done = fzCopied.has(c.x.id);
        const tag = c.spare ? `<i class="kl-fz-sp">${c.n > 1 ? `×${c.n} ` : ''}spare</i>` : '';
        return `<button class="kl-fzc${done ? ' kl-done' : ''}" data-act="fzcopy" data-id="${esc(c.x.id)}" data-name="${esc(c.x.name)}" title="Copy name${c.x.famName ? ` · ${esc(c.x.famName)}` : ''}">${done ? '✓ ' : ''}${esc(c.x.name)}${tag}</button>`;
      })
      .join('');
    return `<div class="kl-fzseg">${seg}</div>
      <div class="kl-card kl-hero" title="${esc(why + incomeTip)}">
        <div class="kl-row kl-between"><div class="kl-lbl">Next go · tap to copy</div><span class="kl-small kl-muted">${meta}</span></div>
        ${eq(b.fusions * o.cost, b.fusions)}
        <div class="kl-fz-cards">${chips}</div>
      </div>`;
  }

  function toggleRow(key, label, desc) {
    return `<label class="kl-toggle" title="${esc(desc)}"><input type="checkbox" data-set="${key}" ${S.settings[key] ? 'checked' : ''}><span class="kl-sw"></span><b>${label}</b></label>`;
  }
  function viewSettings() {
    return `${syncBlock()}<div class="kl-card">
      ${toggleRow('tooltip', 'Hover popup', 'Price history, your copies and family progress when you hover a card')}
      ${toggleRow('badges', 'Card badges', 'Small chips on card tiles')}
      ${toggleRow('newBadge', 'NEW badge', 'Cards you don’t own')}
      ${toggleRow('critical', '⚑ tier badge', 'Single copies a family tier depends on')}
      ${toggleRow('autoPrice', 'Auto-price cards on the page', 'Fetch prices for every card on the page, on-screen ones first, one at a time, so ≈ price badges appear without hovering. Cached for 2 hours.')}
      <label class="kl-inline">Hover delay <input type="number" class="kl-num" min="0" max="2000" step="50" data-input="hoverDelay" value="${S.settings.hoverDelay}"> ms</label>
      <label class="kl-inline" title="Extra cards Lens keeps above each family tier when picking fusions. 0 still never drops a tier.">Fusion cushion <input type="number" min="0" max="20" class="kl-num" data-input="buffer" value="${esc(S.settings.fuseBuffer)}"> cards</label>
    </div>
    <div class="kl-card"><div class="kl-row kl-between"><span>${fmt(Object.keys(S.prices).length)} cached prices</span><button class="kl-btn kl-ghost" data-act="clearprices">Clear</button></div>
    <div class="kl-row kl-between"><span>${fmt(Object.keys(S.obs).length)} observed listings</span><button class="kl-btn kl-ghost" data-act="clearobs">Clear</button></div>
    <div class="kl-row kl-between"><span>Collection snapshot</span><button class="kl-btn kl-ghost" data-act="clearcol">Forget</button></div></div>`;
  }

  function renderPanel() {
    if (!open) return;
    const views = { fusion: viewFusion, settings: viewSettings };
    for (const p of plugins) if (p.tab) views[p.tab.id] = p.tab.render;
    const focused = document.activeElement?.dataset?.input;
    const caret = focused ? document.activeElement.selectionStart : null;
    const scroll = panel.querySelector('.kl-body')?.scrollTop || 0;
    panel.innerHTML = `
      <header class="kl-head"><div class="kl-brand"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.6 6.9L22 12l-7.4 3.1L12 22l-2.6-6.9L2 12l7.4-3.1Z"/></svg>Kosmora <span>Lens</span></div>
        <button class="kl-x" data-act="close" aria-label="Close">×</button></header>
      <nav class="kl-tabs">${TABS.map(([k, l]) => `<button class="kl-tab${k === tab ? ' kl-on' : ''}" data-act="tab" data-tab="${k}">${l}</button>`).join('')}</nav>
      <div class="kl-body">${views[tab]()}</div>`;
    panel.querySelector('.kl-body').scrollTop = scroll;
    if (focused) {
      const el = panel.querySelector(`[data-input="${focused}"]`);
      if (el) {
        el.focus();
        try {
          if (caret != null) el.setSelectionRange(caret, caret);
        } catch {}
      }
    }
  }
  const renderPanelSoon = debounce(renderPanel, 120);

  panel.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (plugins.some((p) => p.onAct?.(act, b))) return;
    if (act === 'close') togglePanel(false);
    else if (act === 'tab') {
      tab = b.dataset.tab;
      panel.querySelector('.kl-body') && (panel.querySelector('.kl-body').scrollTop = 0);
      renderPanel();
      for (const p of plugins) p.onTab?.(tab);
    } else if (act === 'sync') syncCollection();
    else if (act === 'fzany') {
      fzAnyway.add(b.dataset.r);
      renderPanel();
    } else if (act === 'fr') {
      fuseRarity = b.dataset.r;
      fusePicked = true;
      renderPanel();
      getFusion().catch(() => {});
    } else if (act === 'fzcopy') {
      const name = b.dataset.name;
      const done = () => {
        fzCopied.add(b.dataset.id);
        toast(`Copied “${name}”`);
        renderPanel();
      };
      (navigator.clipboard?.writeText(name) || Promise.reject()).then(done, () => toast('Copy failed: select the name instead', true));
    } else if (act === 'clearprices') {
      S.prices = {};
      store.set('prices', {});
      bump();
    } else if (act === 'clearobs') {
      S.obs = {};
      store.set('obs', {});
      bump();
    } else if (act === 'clearcol') {
      S.collection = null;
      S.collectionAt = 0;
      ext.storage.local.remove('collection');
      bump();
    }
  });
  panel.addEventListener('input', (e) => {
    const k = e.target.dataset.input;
    if (plugins.some((p) => p.onInput?.(k, e.target))) return;
    if (k === 'buffer' || k === 'hoverDelay') {
      const v = Number(e.target.value);
      if (!isFinite(v)) return;
      S.settings[k === 'buffer' ? 'fuseBuffer' : 'hoverDelay'] = v;
      store.set('settings', S.settings);
      if (k === 'buffer') renderPanelSoon();
    }
  });
  panel.addEventListener('change', (e) => {
    const k = e.target.dataset.set;
    if (!k) return;
    S.settings[k] = e.target.checked;
    store.set('settings', S.settings);
    bump();
  });

  listeners.add((type) => {
    if (type === 'sync') updateOrb();
    if (open) renderPanelSoon();
  });

  // ───────────────────────── plugin API (shared with src/pulsar.js) ─────────────────────────
  // Content scripts of one extension share an isolated world: the page cannot see this object.
  const plugins = [];
  globalThis.__KL = {
    S,
    F,
    RARITIES,
    fmt,
    esc,
    ago,
    micro,
    debounce,
    rarityClass,
    store,
    apiGet,
    emit,
    listeners,
    bump,
    scheduleScan,
    toast,
    syncBlock,
    floorOf,
    intel,
    priceFresh,
    getPrice,
    ingestAny,
    saveObs,
    liveListings,
    marketHref,
    getFamilies,
    inGameZone,
    // fusion advisor (used by fusionpage.js on the game's Fusion page)
    FUSE_ORDER,
    NEAR_TIER,
    plural,
    kosmo,
    fusionAdvice,
    fuseValue,
    fuseCost,
    getFusion,
    getMarketStats,
    getMe,
    openTab(id, opts = {}) {
      if (opts.fuseRarity) {
        fuseRarity = opts.fuseRarity;
        fusePicked = true;
      }
      tab = id;
      togglePanel(true);
      renderPanel();
    },
    renderPanel: () => renderPanelSoon(),
    isPanelTab: (id) => open && tab === id,
    register(p) {
      plugins.push(p);
      if (p.tab && !TABS.some(([k]) => k === p.tab.id)) TABS.splice(TABS.length - 1, 0, [p.tab.id, p.tab.label]);
      p.init?.();
    },
  };

  // ───────────────────────── boot ─────────────────────────
  async function boot() {
    const [settings, prices, families, collection, obs, autoSyncAt, fusion, mstats] = await Promise.all([
      store.get('settings'),
      store.get('prices'),
      store.get('families'),
      store.get('collection'),
      store.get('obs'),
      store.get('autoSyncAt'),
      store.get('fusion'),
      store.get('mstats'),
    ]);
    if (fusion?.recipes && !S.fusion) S.fusion = fusion;
    if (mstats?.med && !S.mstats) S.mstats = mstats;
    S.autoSyncAt = autoSyncAt || 0;
    S.settings = { ...DEFAULTS, ...(settings || {}) };
    delete S.settings.autoPriceMarket; // replaced by autoPrice (on by default) in 0.7.0
    // merge: hook.js may already have relayed data before storage finished loading
    S.prices = mergeNewerInto(prices, S.prices);
    S.obs = mergeNewerInto(obs, S.obs);
    stored = true;
    // anything relayed before storage loaded gets written now
    savePrices();
    saveObs();
    // Other Kosmora tabs write the same keys. Fold their newer entries in, so this tab's next
    // full write keeps them instead of overwriting them.
    ext.storage?.onChanged?.addListener((ch, area) => {
      if (area !== 'local') return;
      for (const [key, cur] of [['prices', S.prices], ['obs', S.obs]]) {
        const nv = ch[key]?.newValue;
        if (!nv) continue;
        if (!Object.keys(nv).length) {
          // "Clear" in another tab
          for (const id of Object.keys(cur)) delete cur[id];
          continue;
        }
        if (mergeNewer(cur, nv)) S.rev++;
      }
    });
    if (families?.list) setFamilies(families);
    loadCollection(collection);
    // only now ask hook.js for buffered data, so early pack results meet a loaded snapshot
    window.postMessage({ __kosmoraLensReady: 1 }, location.origin);

    // Don't touch the page until the site's app has finished starting up (hydrating), so
    // Lens never causes React hydration mismatches. Data relayed by hook.js still flows meanwhile.
    await new Promise((resolve) => {
      const go = () => setTimeout(resolve, 600);
      if (document.readyState === 'complete') go();
      else addEventListener('load', go, { once: true });
    });

    // use the game's own font on every Lens surface
    try {
      const ff = getComputedStyle(document.body).fontFamily;
      if (ff) document.documentElement.style.setProperty('--kl-font', ff);
    } catch {}

    document.documentElement.append(orb, panel, tip);
    updateOrb();
    setInterval(updateOrb, 60e3);

    new MutationObserver((muts) => {
      for (const m of muts) {
        const t = m.target;
        if (t.nodeType === 1 && t.closest?.('.kl-badges, .kl-panel, .kl-tip, .kl-orb, .kl-toast, .kl-lob, .kl-opt')) continue;
        scheduleScan();
        return;
      }
    }).observe(document.body, { childList: true, subtree: true });
    scheduleScan();

    // first run: read the collection once, automatically (live sync keeps it current after)
    if (!S.collection)
      setTimeout(() => {
        if (S.collection || S.syncing || document.visibilityState !== 'visible') return;
        toast('Lens is reading your collection once (about a minute). It stays in sync after that.');
        syncCollection();
      }, 5000);

    // one light refresh of family counts per page load if stale
    if (!S.families || Date.now() - S.families.t > FAMILY_TTL) getFamilies().catch(() => {});
  }

  boot().catch((e) => console.error('[Kosmora Lens] boot failed', e));
})();
