/* Kosmora Lens: Pulsar module.
 *
 * Pre-round decision support for the six Pulsar games. Rules it follows:
 *  - Information only. It never clicks, selects, starts, plays or chooses anything,
 *    and its visuals never imitate the game's own "selected" state.
 *  - Lobbies only. Every card or tag is drawn only while that game's lobby marker
 *    is on screen; nothing appears inside a running round.
 *  - No in-round data. Inputs are lobby/hub payloads and finished-game histories the
 *    game itself loads (relayed by hook.js), plus your synced collection. A manual
 *    "Refresh" re-reads those same GET endpoints, queued 0.9 s apart.
 */
(() => {
  'use strict';
  const KL = globalThis.__KL;
  if (!KL || KL.pulsarLoaded) return;
  KL.pulsarLoaded = true;
  const { S, F, RARITIES, fmt, esc, ago, debounce, rarityClass, store, apiGet, floorOf } = KL;

  // ───────────────────────── data ─────────────────────────
  const KEYS = {
    '/api/games/today': 'today',
    '/api/constellation/hub': 'constellation',
    '/api/exploration/hub': 'horizon',
    '/api/timeline/lobby': 'aion',
    '/api/timeline/history': 'aionHistory',
    '/api/photon/lobby': 'photon',
    '/api/umbra/lobby': 'umbra',
    '/api/vortex/lobby': 'vortex',
  };
  const tz = () => encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const REFRESH = () => [
    '/api/games/today',
    `/api/constellation/hub?tz=${tz()}`,
    '/api/exploration/hub',
    '/api/timeline/lobby',
    '/api/timeline/history',
    '/api/photon/lobby',
    '/api/umbra/lobby',
    '/api/vortex/lobby',
  ];
  const DEFAULT_BONUS = { Common: 0, Uncommon: 0, Rare: 1, Epic: 3, Legendary: 5, Mythic: 10 };
  const GAME_NAMES = {
    constellation: 'Constellation',
    photon: 'Photon',
    umbra: 'Umbra',
    aion: 'Aion',
    horizon: 'Horizon',
    vortex: 'Vortex',
  };

  const P = {
    lob: {}, // key -> { t, data }
    photonRuns: {}, // id -> { stake, cleared, payout, at }
    horizonTrips: {}, // id -> { tier, kind, dist, points, payout, stake, dur, at }
    aionGames: {}, // id -> { won, kosmo, base, first, streak, flawless, rarity, mistakes, turns, at }
    umbra: { boards: {}, snap: null, lastBoard: null }, // boards: id -> { n, three, cleared, net }
  };
  let refreshing = false;
  let vxRarity = 'Common';

  const save = debounce(() => store.set('pulsar', P), 1500);
  const localDay = (t = Date.now()) => new Date(t).toLocaleDateString('en-CA');
  const fresh = (key) => !!P.lob[key] && localDay(P.lob[key].t) === localDay();
  const lob = (key) => P.lob[key]?.data || null;
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const signed = (n, d = 1) => (n == null ? '—' : `${n >= 0 ? '+' : '−'}${fmt(Math.abs(n), d)}`);

  function ingest(key, data) {
    if (!data || typeof data !== 'object') return;
    const now = Date.now();
    switch (key) {
      case 'photon':
        for (const r of data.recent || []) {
          if (!r?.id || r.practice || r.abandoned || r.phase === 'playing' || r.payout == null) continue;
          P.photonRuns[r.id] = { stake: +r.stake, cleared: +r.cleared || 0, payout: +r.payout || 0, at: Date.parse(r.at) || now };
        }
        P.lob.photon = { t: now, data: { ...data, recent: undefined, open: undefined } };
        break;
      case 'horizon':
        for (const h of data.history || []) {
          if (!h?.id || h.practice || h.state !== 'claimed') continue;
          const dep = Date.parse(h.departedAt);
          const ret = Date.parse(h.returnsAt);
          P.horizonTrips[h.id] = {
            tier: h.destination?.tier ?? null,
            kind: h.destination?.kind ?? null,
            dist: h.destination?.distance ?? null,
            points: h.points ?? null,
            payout: +h.payout || 0,
            stake: +h.stake || 100,
            dur: isFinite(ret - dep) ? (ret - dep) / 60e3 : null,
            at: Date.parse(h.closedAt) || now,
          };
        }
        P.lob.horizon = {
          t: now,
          data: { ...data, history: undefined, open: data.open ? { returnsAt: data.open.returnsAt, state: data.open.state } : null },
        };
        break;
      case 'aionHistory':
        for (const g of data.games || []) {
          const r = g?.result;
          if (!g?.id || g.practice || r?.practice || r?.abandoned || !r?.outcome || g.kind !== 'solo') continue;
          const w = r.reward || {};
          P.aionGames[g.id] = {
            won: r.outcome === 'won',
            kosmo: +w.kosmo || 0,
            base: +w.base || 0,
            first: !!w.firstWinOfDay,
            streak: +w.streakBonus || 0,
            flawless: +w.flawlessBonus || 0,
            rarity: +w.rarityBonus || 0,
            mistakes: +g.mistakes || 0,
            turns: +g.turns || 0,
            at: Date.parse(g.finishedAt) || now,
          };
        }
        break;
      case 'umbra':
        ingestUmbra(data);
        P.lob.umbra = { t: now, data };
        break;
      case 'vortex':
        P.lob.vortex = { t: now, data: { ...data, newest: undefined, seedHash: undefined } };
        break;
      default:
        P.lob[key] = { t: now, data };
    }
    save();
    KL.bump();
  }

  // Umbra exposes only lifetime totals, so per-board results come from how those totals
  // move between lobby visits, credited to the board that was selected in the lobby.
  function ingestUmbra(d) {
    const st = d.stats || {};
    const snap = {
      boards: +st.boards || 0,
      three: +st.threeStars || 0,
      cleared: +st.cleared || 0,
      net: +st.net || 0,
      firstDone: !!d.firstDone,
      day: localDay(),
    };
    const prev = P.umbra.snap;
    if (prev && snap.boards > prev.boards && P.umbra.lastBoard) {
      let dNet = snap.net - prev.net;
      if (!prev.firstDone && snap.firstDone && prev.day === snap.day) dNet -= +d.firstBonus || 0;
      const b = (P.umbra.boards[P.umbra.lastBoard] ||= { n: 0, three: 0, cleared: 0, net: 0 });
      b.n += snap.boards - prev.boards;
      b.three += Math.max(0, snap.three - prev.three);
      b.cleared += Math.max(0, snap.cleared - prev.cleared);
      b.net += dNet;
    }
    P.umbra.snap = snap;
  }

  async function refreshAll() {
    if (refreshing) return;
    refreshing = true;
    KL.renderPanel();
    for (const path of REFRESH()) {
      try {
        ingest(KEYS[path.split('?')[0]], await apiGet(path));
      } catch {}
    }
    refreshing = false;
    KL.toast('Pulsar data refreshed');
    KL.bump();
  }

  // ───────────────────────── models ─────────────────────────
  function bonusTable() {
    return { ...DEFAULT_BONUS, ...(lob('aion')?.rewards?.rarityBonus || {}) };
  }

  // Every model answers one question: "which option pays the most when I win?"
  // Nothing here is weighted by your own win/bust/3★ rate.

  function rarityStats(rows, bonus) {
    const n = rows.length;
    const by = Object.fromEntries(RARITIES.map((r) => [r, 0]));
    rows.forEach((x) => by[x.r] != null && by[x.r]++);
    const share = (r) => (n ? by[r] / n : 0);
    const ev = RARITIES.reduce((a, r) => a + share(r) * (bonus[r] || 0), 0);
    const pLM = share('Legendary') + share('Mythic');
    const top = [...RARITIES].reverse().find((r) => by[r] > 0) || null;
    return { n, by, ev, pLM, hit5: 1 - Math.pow(1 - pLM, 5), top, topN: top ? by[top] : 0, topBonus: top ? bonus[top] || 0 : 0 };
  }

  function _constellationModel() {
    const hub = lob('constellation');
    if (!S.collection || !hub) return null;
    const bonus = bonusTable();
    const st = hub.stats || {};
    const rw = hub.rewards || {};
    const win = rw.win ?? 10;
    const fee = rw.entryFee ?? 5;
    const streakMax = rw.streakBonus?.max ?? 10;
    const byDom = new Map();
    for (const x of S.collection.values()) {
      if (!byDom.has(x.dom)) byDom.set(x.dom, []);
      byDom.get(x.dom).push(x);
    }
    // a domain's value is purely what its cards add to a win: average rarity bonus, then ceiling
    const mk = (id, name, rows, eligible = true) => {
      const s = rarityStats(rows, bonus);
      const perWin = win + s.ev;
      return { id, name, s, perWin, net: perWin - fee, eligible, maxWin: win + s.topBonus };
    };
    const all = mk('all', 'All cards', [...S.collection.values()]);
    const doms = (hub.domains || []).map((d) => mk(d.id, d.name, byDom.get(d.id) || [], d.eligible)).filter((d) => d.s.n);
    const ranked = [all, ...doms.filter((d) => d.eligible)].sort((a, b) => b.perWin - a.perWin || b.maxWin - a.maxWin || b.s.pLM - a.s.pLM);
    ranked.forEach((d, i) => (d.rank = i + 1));
    const left = Math.max(0, (hub.soloRounds?.perDay ?? 50) - (hub.soloRounds?.today ?? 0));
    const firstLeft = !hub.todayFirstWinDone ? (rw.firstWinOfDay ?? 25) - win : 0;
    return { all, doms, ranked, best: ranked[0], left, firstLeft, fee, win, streakMax, bonus, played: st.played || 0, fresh: fresh('constellation') };
  }

  function _photonModel() {
    const L = lob('photon');
    if (!L?.stages) return null;
    const mults = L.stages.map((s) => +s.mult);
    const top = Math.max(...mults);
    const runs = Object.values(P.photonRuns);
    const stakes = (L.stakes || [5, 10, 25, 50]).map(Number);
    // net if you clear every light (payout = stake × last light cleared)
    const maxNet = (s) => s * (top - 1);
    const best = Math.max(...stakes);
    const left = Math.max(0, (L.paidRunsPerDay ?? 10) - (L.paidToday ?? 0));
    const realized = runs.length ? runs.reduce((a, r) => a + r.payout - r.stake, 0) : null;
    return { runs: runs.length, mults, top, stakes, maxNet, best, left, realized, fresh: fresh('photon') };
  }

  function _umbraModel() {
    const L = lob('umbra');
    if (!L?.boards) return null;
    const st = L.stats || {};
    const stake = +L.stake || 10;
    const boards = L.boards.map((b) => {
      const pay = (b.pay || [0, 0, 0]).map(Number);
      const name = { crescent: 'Crescent', half: 'Half Moon', full: 'Full Moon', total: 'Total Eclipse' }[b.id] || b.id;
      // net for each star result; the 3★ figure is the board's ceiling
      return { id: b.id, pairs: b.pairs, pay, nets: pay.map((x) => x - stake), maxNet: Math.max(...pay) - stake, name };
    });
    const best = boards.reduce((a, b) => (b.maxNet > a.maxNet ? b : a), boards[0]);
    const left = Math.max(0, (L.paidPerDay ?? 20) - (L.paidToday ?? 0));
    const firstLeft = !L.firstDone ? +L.firstBonus || 0 : 0;
    return { boards, best, left, firstLeft, stake, lifetime: st, fresh: fresh('umbra') };
  }

  function _aionModel() {
    const L = lob('aion');
    if (!L) return null;
    const games = Object.values(P.aionGames);
    const rw = L.rewards || {};
    const fee = rw.entryFee ?? 5;
    const win = rw.win ?? 20;
    const won = games.filter((g) => g.won);
    const flawlessBonus = +(rw.flawless ?? 5);
    const streakMax = +(rw.streakBonus?.max ?? 10);
    // rarity bonus a win actually carried, from finished games (what your cards add, not how often you win)
    const rarity = won.length ? mean(won.map((g) => g.rarity)) : 0;
    const rarityMax = won.length ? Math.max(...won.map((g) => g.rarity)) : 0;
    const cleanWin = win + flawlessBonus + rarity; // a flawless win, before streak and first-win extras
    const perDay = L.games?.perDay ?? 15;
    const left = Math.max(0, perDay - (L.games?.today ?? L.today?.played ?? 0));
    const firstLeft = (L.today?.wins ?? 0) === 0 ? (rw.firstWinOfDay ?? 40) - win : 0;
    const bestSeen = won.length ? Math.max(...won.map((g) => g.kosmo)) : null;
    return { win, flawlessBonus, streakMax, rarity, rarityMax, cleanWin, maxNet: cleanWin - fee, left, firstLeft, fee, bestSeen, n: games.length, fresh: fresh('aion') };
  }

  function _horizonModel() {
    const L = lob('horizon');
    if (!L) return null;
    const trips = Object.values(P.horizonTrips);
    const stake = +L.stake || 100;
    const pays = trips.map((t) => t.payout);
    const avg = pays.length ? mean(pays) : null;
    const ev = avg == null ? null : avg - stake;
    const durs = trips.map((t) => t.dur).filter((d) => d > 0);
    const dur = durs.length ? mean(durs) : 110;
    const byTier = {};
    trips.forEach((t) => (byTier[t.tier] ||= []).push(t.payout));
    const tiers = Object.entries(byTier)
      .map(([tier, a]) => ({ tier: +tier, n: a.length, avg: mean(a) }))
      .sort((a, b) => a.tier - b.tier);
    const left = Math.max(0, (L.paidPerDay ?? 6) - (L.paidToday ?? 0));
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    const busyUntil = L.open?.returnsAt ? Math.max(Date.now(), Date.parse(L.open.returnsAt)) : Date.now();
    const possible = busyUntil < midnight ? Math.floor((midnight - busyUntil) / (dur * 60e3)) + 1 : 0;
    return { n: trips.length, avg, ev, stake, dur, tiers, left, possible: Math.min(left, possible), busyUntil: L.open ? busyUntil : null, fresh: fresh('horizon') };
  }

  function _vortexModel() {
    const L = lob('vortex');
    if (!L) return null;
    return {
      spinsLeft: Math.max(0, (L.spinsPerDay ?? 30) - (L.today?.spins ?? 0)),
      legLeft: Math.max(0, (L.legendaryPerDay ?? 5) - (L.today?.legendary ?? 0)),
      odds: L.odds || {},
      pool: L.counts || {},
      stats: L.stats || {},
      fresh: fresh('vortex'),
    };
  }

  // Models are pure functions of the data revision, lobby payloads and journals, so each
  // is computed once per change instead of on every page update.
  const stamp = () =>
    `${S.rev}|${Math.floor(Date.now() / 60e3)}|${Object.values(P.lob)
      .map((l) => l.t)
      .join(',')}|${Object.keys(P.photonRuns).length}|${Object.keys(P.horizonTrips).length}|${Object.keys(P.aionGames).length}|${JSON.stringify(P.umbra.boards)}`;
  function memo(fn) {
    let key = null;
    let val;
    return () => {
      const k = stamp();
      if (k !== key) {
        key = k;
        val = fn();
      }
      return val;
    };
  }
  const constellationModel = memo(_constellationModel);
  const photonModel = memo(_photonModel);
  const umbraModel = memo(_umbraModel);
  const aionModel = memo(_aionModel);
  const horizonModel = memo(_horizonModel);
  const vortexModel = memo(_vortexModel);

  // cards that are safe to throw into the Vortex: spare copies first, then singles from
  // families with the most room above their tier (and furthest from their next tier)
  function throwList(rarity, limit = 40) {
    if (!S.collection) return [];
    const blocked = F.locked | F.auction | F.albums | F.numberOne | F.veil | F.mods;
    const out = [];
    for (const x of S.collection.values()) {
      if (x.r !== rarity || x.f & blocked) continue;
      if (x.q > 1) {
        out.push({ x, score: 1e6 + x.q, why: `${x.q - 1} spare cop${x.q - 1 === 1 ? 'y' : 'ies'}` });
        continue;
      }
      const fam = x.famId && S.famById.get(x.famId);
      if (!fam) continue;
      const slack = fam.collected - floorOf(fam.collected);
      if (slack <= 0) continue;
      const toNext = fam.nextMilestone ? fam.nextMilestone - fam.collected : 99;
      out.push({ x, score: slack * 10 + Math.min(toNext, 50), why: `${fam.name}: ${slack} above tier` });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // ───────────────────────── today checklist ─────────────────────────
  // One row per game: what to pick, what's left today, and an open first-win bonus.
  // No totals: nothing on screen assumes you win. Figures live in the row's title.
  const ORDER = ['constellation', 'umbra', 'photon', 'aion', 'horizon', 'vortex'];
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function todayPlan() {
    const rows = [];
    const c = constellationModel();
    if (c)
      rows.push({ id: 'constellation', left: c.left, unit: 'round', per: c.best.net, pick: c.best.name, bonus: c.firstLeft, fresh: c.fresh,
        tip: `Wins pay the most on ${c.best.name}: ${fmt(c.best.perWin, 2)} per win (${c.win} + your cards' rarity bonus), ${signed(c.best.net, 2)} after the ${c.fee} entry.` });
    const um = umbraModel();
    if (um)
      rows.push({ id: 'umbra', left: um.left, unit: 'board', per: um.best.maxNet, pick: um.best.name, bonus: um.firstLeft, fresh: um.fresh,
        tip: `${um.best.name} pays the most at 3★: ${signed(um.best.maxNet, 0)} after the ${um.stake} stake.` });
    const ph = photonModel();
    if (ph)
      rows.push({ id: 'photon', left: ph.left, unit: 'run', per: ph.maxNet(ph.best), pick: `Stake ${ph.best}`, fresh: ph.fresh,
        tip: `A run pays stake × the last light cleared, so every light pays the most at stake ${ph.best}.` });
    const ai = aionModel();
    if (ai)
      rows.push({ id: 'aion', left: ai.left, unit: 'game', per: ai.maxNet, pick: '', bonus: ai.firstLeft, fresh: ai.fresh,
        tip: `A flawless win pays ${fmt(ai.cleanWin, 0)}, ${signed(ai.maxNet, 0)} after the ${ai.fee} entry.` });
    const hz = horizonModel();
    if (hz)
      rows.push({ id: 'horizon', left: hz.possible, unit: 'trip', per: hz.ev, fresh: hz.fresh,
        pick: !hz.possible ? '' : hz.busyUntil ? `Relaunch ${clock(hz.busyUntil)}` : 'Launch now',
        tip: `${hz.left} trips left today, ${hz.possible} fit before midnight.${hz.avg != null ? ` Your trips return ${fmt(hz.avg, 0)} on a ${hz.stake} launch on average (${hz.n} trips, ~${fmt(hz.dur, 0)} min each).` : ''}` });
    const vx = vortexModel();
    if (vx)
      rows.push({ id: 'vortex', left: vx.spinsLeft, unit: 'spin', pick: 'Throw ✓ cards', fresh: vx.fresh,
        tip: `${vx.legLeft} Legendary spins left today. ✓ marks cards you can throw without losing a family tier.` });
    // open first wins first, then games with rounds left, finished games last
    const rank = (r) => (!r.left ? 2 : r.bonus ? 0 : 1);
    rows.sort((a, b) => rank(a) - rank(b) || ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
    // the most Kosmo still on the table today: every paid round left won with the Lens pick,
    // plus open first-win bonuses (Horizon has no win or loss, so it counts your average trip)
    const total = rows.reduce((a, r) => a + (r.per == null || !r.left ? 0 : Math.max(0, r.left * r.per + (r.bonus || 0))), 0);
    return { rows, total, stale: rows.some((r) => !r.fresh) };
  }

  function checklist(plan) {
    if (!plan.rows.length) return `<div class="kl-muted">Open the Pulsar hub once so Lens can read your game lobbies.</div>`;
    const row = (r) => `<li class="kl-pl-row${r.left ? '' : ' kl-done'}"${r.tip ? ` title="${esc(r.tip)}"` : ''}>
        <a href="/${r.id}" class="kl-game">${GAME_NAMES[r.id]}</a>
        <span class="kl-pl-pick">${r.left ? esc(r.pick) : 'Done today'}</span>
        <span class="kl-pl-tags">${r.left && r.bonus > 0 ? `<i class="kl-pl-first">1st win +${fmt(r.bonus, 0)}</i>` : ''}${r.fresh ? '' : '<i class="kl-stale" title="Read on an earlier day. Refresh for today\'s counts.">old</i>'}</span>
        <span class="kl-pl-left">${r.left ? `${r.left} ${r.unit}${r.left === 1 ? '' : 's'}` : ''}</span>
      </li>`;
    const tip = `Every paid round left, won with the Lens pick, plus open first-win bonuses. Horizon counts your average trip.\n${plan.rows
      .filter((r) => r.per != null && r.left)
      .map((r) => `${GAME_NAMES[r.id]}: ${r.left} × ${signed(r.per, 1)}${r.bonus > 0 ? ` + ${fmt(r.bonus, 0)}` : ''}`)
      .join('\n')}`;
    return `<ul class="kl-pl">${plan.rows.map(row).join('')}</ul>
      <div class="kl-pl-total" title="${esc(tip)}"><span>If you win every paid round left</span><b>${signed(plan.total, 0)}</b></div>`;
  }

  // ───────────────────────── lobby UI ─────────────────────────
  const ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.6 6.9L22 12l-7.4 3.1L12 22l-2.6-6.9L2 12l7.4-3.1Z"/></svg>`;
  const head = (title, extra = '', tip = '') =>
    `<div class="kl-lob-head"${tip ? ` title="${esc(tip)}"` : ''}>${ICON}<span>Lens</span>${title ? `<em>${title}</em>` : ''}${tip ? '<i class="kl-info" aria-hidden="true">i</i>' : ''}${extra}</div>`;

  // place (or update) one Lens card next to an anchor; returns nothing
  function mount(kind, anchor, where, html, sig) {
    let el = document.querySelector(`.kl-lob[data-owner="pulsar"][data-kind="${kind}"]`);
    if (!anchor) return el?.remove();
    if (!el) {
      el = document.createElement('div');
      el.className = `kl-lob kl-lob-${kind}`;
      el.dataset.kind = kind;
      el.dataset.owner = 'pulsar';
    }
    const target = where === 'before' ? anchor : anchor.nextSibling;
    if (el.parentNode !== anchor.parentNode || (where === 'before' ? el.nextSibling !== anchor : el.previousSibling !== anchor))
      anchor.parentNode.insertBefore(el, target);
    // redraw only when the content really changed, so buttons inside aren't swapped mid-click
    if (el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      if (el._klHtml !== html) {
        el._klHtml = html;
        el.innerHTML = html;
      }
    }
  }
  // only ever remove this module's own cards (other modules, e.g. the card page, own theirs)
  const unmountAll = (except) =>
    document.querySelectorAll('.kl-lob[data-owner="pulsar"]').forEach((el) => el.dataset.kind !== except && el.remove());

  // label inside a game option (never restyles the option itself)
  function optTag(opt, html, sig) {
    let tag = opt.querySelector('.kl-opt');
    if (tag && tag.dataset.sig === sig) return;
    if (!tag) {
      tag = document.createElement('span');
      tag.className = 'kl-opt';
      (opt.querySelector(':scope > span:not(.cs-scope-mark)') || opt).appendChild(tag);
    }
    tag.dataset.sig = sig;
    tag.innerHTML = html;
  }

  let hubFallbackAt = 0;
  function onScan() {
    const path = location.pathname.replace(/\/$/, '') || '/';
    const sig0 = `${S.rev}|${Object.values(P.lob).map((l) => l.t).join(',')}`;

    if (path === '/games' && document.querySelector('section.hub-bays')) {
      // sits right under the game's own "Today" box, styled to match it
      const today = document.querySelector('section.hub-today');
      const plan = todayPlan();
      mount('hub', today || document.querySelector('section.hub-bays'), today ? 'after' : 'before', hubCard(plan), `${sig0}|${refreshing}`);
      return unmountAll('hub');
    }
    if (path === '/constellation' && document.querySelector('button.cs-scope')) {
      const m = constellationModel();
      if (S.collection && !lob('constellation') && Date.now() - hubFallbackAt > 10 * 60e3) {
        hubFallbackAt = Date.now();
        setTimeout(() => !lob('constellation') && apiGet(`/api/constellation/hub?tz=${tz()}`).then((j) => ingest('constellation', j)).catch(() => {}), 1500);
      }
      const scope = document.querySelector('button.cs-scope b')?.textContent.trim() || 'All cards';
      mount('constellation', document.querySelector('button.cs-scope'), 'after', constellationCard(m, scope), `${sig0}|${scope}|${!!m}`);
      if (m) constellationOptions(m, sig0);
      return unmountAll('constellation');
    }
    if (path === '/photon' && document.querySelector('[data-testid="pho-start"]')) {
      const m = photonModel();
      mount('photon', document.querySelector('section.pho-action'), 'after', photonCard(m), sig0);
      return unmountAll('photon');
    }
    if (path === '/umbra' && document.querySelector('[data-testid="um-start"]')) {
      const m = umbraModel();
      // remember which board is selected, so a finished board can be credited to it
      const opts = [...document.querySelectorAll('button.um-lv')];
      const on = opts.findIndex((b) => b.classList.contains('on'));
      const id = lob('umbra')?.boards?.[on]?.id;
      if (id && P.umbra.lastBoard !== id) {
        P.umbra.lastBoard = id;
        save();
      }
      mount('umbra', document.querySelector('div.um-go'), 'after', umbraCard(m), sig0);
      if (m) umbraOptions(m, opts, sig0);
      return unmountAll('umbra');
    }
    if (path === '/aion' && document.querySelector('[data-testid="ai-play"]')) {
      // per-game rewards live in the history list, which the game only loads on demand
      if (!Object.keys(P.aionGames).length && Date.now() - (P.aionHistoryAt || 0) > 6 * 3600e3) {
        P.aionHistoryAt = Date.now();
        apiGet('/api/timeline/history').then((j) => ingest('aionHistory', j)).catch(() => {});
      }
      mount('aion', document.querySelector('div.ai-hero-actions'), 'after', aionCard(aionModel()), sig0);
      return unmountAll('aion');
    }
    if (path === '/horizon' && document.querySelector('[data-testid="hz-launch"]')) {
      mount('horizon', document.querySelector('div.hz-launch-block'), 'after', horizonCard(horizonModel()), sig0);
      return unmountAll('horizon');
    }
    if (path === '/vortex' && document.querySelector('[data-testid="vx-spin"]')) {
      mount('vortex', document.querySelector('div.vx-dock'), 'after', vortexCard(vortexModel()), sig0);
      return unmountAll('vortex');
    }
    unmountAll(null);
  }

  // ── hub ──
  // Same shape as the game's "Today" box above it: small-caps title, then the checklist.
  function hubCard(plan) {
    const btn = plan.stale ? `<button class="kl-hub-refresh" data-kl-act="pulsar-refresh" ${refreshing ? 'disabled' : ''}>${refreshing ? 'Refreshing…' : 'Refresh'}</button>` : '';
    return `<h2 class="kl-hub-title">${ICON}Lens · Today in Pulsar${btn}</h2>${checklist(plan)}`;
  }

  // ── lobbies: one Lens line each, same shape as the Fusion page ──
  // A line says what to pick and at most one number; everything else is in its title.
  const line = (text, tip = '') =>
    `<div class="kl-fu-row"${tip ? ` title="${esc(tip)}"` : ''}>${ICON}<span class="kl-fu-brand">Lens</span><div class="kl-fu-text">${text}</div></div>`;
  const muted = (t) => line(`<span class="kl-muted">${t}</span>`);
  const pick = (name) => `Pick <b class="kl-gold">${esc(name)}</b>`;

  // ── constellation ──
  function constellationCard(m, scope) {
    if (!S.collection) return muted('Sync your collection (Alt+L) so Lens can rank domains.');
    if (!m) return muted('Reading your Constellation stats…');
    const cur = scope === 'All cards' ? m.all : m.doms.find((d) => d.name === scope) || m.all;
    const best = m.best;
    const gain = best.perWin - cur.perWin;
    const desc = (d) => `${d.name}: ${fmt(d.perWin, 2)} per win (${m.win} + ${d.s.ev.toFixed(2)} rarity bonus), best win ${d.maxWin}, ${(d.s.pLM * 100).toFixed(1)}% Legendary+.`;
    const tip = `A win pays ${m.win} plus your cards' rarity bonus, so the domain with the richest cards pays the most. Streaks add up to +${m.streakMax} in any domain.\n${desc(best)}${cur !== best ? `\n${desc(cur)}` : ''}`;
    if (cur === best || gain < 0.005) return line(`<b class="kl-pos">✓ ${esc(cur.name)}</b> pays the most per win`, tip);
    return line(`${pick(best.name)}: wins pay <b class="kl-gold">+${fmt(gain, 2)}</b> more than ${esc(cur.name)}`, tip);
  }
  // only the best option is tagged; the others stay exactly as the game draws them
  function constellationOptions(m, sig0) {
    const byName = new Map([[m.all.name, m.all], ...m.doms.map((d) => [d.name, d])]);
    document.querySelectorAll('button.cs-scope-opt').forEach((opt) => {
      const d = byName.get(opt.querySelector('b')?.textContent.trim());
      if (d !== m.best) return opt.querySelector('.kl-opt')?.remove();
      optTag(opt, '<i class="kl-opt-tag">★ Lens best</i>', `${sig0}|${d.name}`);
      opt.querySelector('.kl-opt').title = `Wins pay the most here: ${fmt(d.perWin, 2)} per win (${m.win} + ${d.s.ev.toFixed(2)} rarity bonus).`;
    });
  }

  // ── photon ──
  function photonCard(m) {
    if (!m) return muted('Reading your Photon record…');
    const ladder = m.mults.map((x, k) => `light ${k + 1}: ${fmt(m.best * x, 0)}`).join(', ');
    const tip = `A run pays stake × the last light cleared, so every light pays the most at the top stake.\nPayout at stake ${m.best} by last light cleared: ${ladder}.${m.realized != null ? `\nYour ${m.runs} finished runs: net ${signed(m.realized, 0)}.` : ''}`;
    if (!m.left) return line('<span class="kl-muted">No paid runs left today</span>', tip);
    return line(`${pick(`stake ${m.best}`)}: every light pays the most there`, tip);
  }

  // ── umbra ──
  function umbraCard(m) {
    if (!m) return muted('Reading your Umbra record…');
    const tip = `Each board costs ${m.stake}. Net at 1★ / 2★ / 3★:\n${m.boards.map((b) => `${b.name}: ${b.nets.map((n) => signed(n, 0)).join(' / ')}`).join('\n')}${m.firstLeft ? `\nYour first board today adds +${m.firstLeft}.` : ''}`;
    if (!m.left) return line('<span class="kl-muted">No paid boards left today</span>', tip);
    return line(`${pick(m.best.name)}: 3★ pays <b class="kl-gold">${signed(m.best.maxNet, 0)}</b>`, tip);
  }
  function umbraOptions(m, opts, sig0) {
    opts.forEach((opt, i) => {
      const b = m.boards[i];
      if (b !== m.best) return opt.querySelector('.kl-opt')?.remove();
      optTag(opt, '<i class="kl-opt-tag">★ Lens best</i>', `${sig0}|${b.id}`);
      opt.querySelector('.kl-opt').title = `Pays the most at 3★: ${signed(b.maxNet, 0)} after the ${m.stake} stake.`;
    });
  }

  // ── aion ──
  function aionCard(m) {
    if (!m) return muted('Reading your Aion record…');
    const tip = `A win pays ${m.win}, +${m.flawlessBonus} if flawless, plus a rarity bonus${m.n ? ` (yours has averaged +${fmt(m.rarity, 1)})` : ''}. Streaks add up to +${m.streakMax} more.\nFlawless win: ${fmt(m.cleanWin, 0)}, ${signed(m.maxNet, 0)} after the ${m.fee} entry.${m.bestSeen != null ? `\nBest win so far: ${fmt(m.bestSeen, 0)}.` : ''}`;
    if (!m.left) return line('<span class="kl-muted">No paid games left today</span>', tip);
    if (m.firstLeft > 0) return line(`Your first win today pays <b class="kl-gold">+${fmt(m.firstLeft, 0)}</b> extra`, tip);
    return line(`A flawless win pays <b class="kl-gold">${signed(m.maxNet, 0)}</b>`, tip);
  }

  // ── horizon ──
  function horizonCard(m) {
    if (!m) return muted('Reading your expeditions…');
    const tiers = m.tiers.map((t) => `Tier ${t.tier}: ${fmt(t.avg, 0)} (${t.n})`).join(', ');
    const tip = `Trips run one at a time, so relaunching as soon as a crew returns fits the most into the day. ${m.left} left today, ${m.possible} fit before midnight.${m.avg != null ? `\nYour trips return ${fmt(m.avg, 0)} on a ${m.stake} launch on average (${m.n} trips, ~${fmt(m.dur, 0)} min each).` : ''}${tiers ? `\nBy tier: ${tiers}.` : ''}`;
    if (!m.possible) return line('<span class="kl-muted">No more trips fit before midnight</span>', tip);
    if (m.busyUntil) return line(`Relaunch at <b class="kl-gold">${clock(m.busyUntil)}</b>`, tip);
    return line(`<b class="kl-pos">Launch now</b>${m.ev != null ? `: trips net <b class="kl-gold">${signed(m.ev, 0)}</b> on average` : ''}`, tip);
  }

  // ── vortex ──
  function vortexCard(m) {
    const tip = m ? `${m.spinsLeft} spins left today (${m.legLeft} Legendary). Full throw list: Alt+L → Pulsar.` : '';
    return line(`<span class="kl-chip-demo kl-safe">✓</span> safe to throw · <span class="kl-chip-demo kl-crit">⚑</span> keep, a tier depends on it · <span class="kl-chip-demo kl-up">▲</span> completes a tier`, tip);
  }

  // ───────────────────────── panel tab ─────────────────────────
  function panelView() {
    const plan = todayPlan();
    const anyData = Object.keys(P.lob).length;
    const refreshBtn = `<button class="kl-btn kl-ghost" data-act="pulsar-refresh" ${refreshing ? 'disabled' : ''}>${refreshing ? 'Refreshing…' : 'Refresh'}</button>`;
    const newest = Math.max(0, ...Object.values(P.lob).map((l) => l.t));
    let html = `<div class="kl-card kl-hero">
        <div class="kl-row kl-between"><div class="kl-lbl" title="${anyData ? `Lobbies read ${ago(newest)}` : 'No lobby data yet'}">Today in Pulsar</div>${refreshBtn}</div>
        ${checklist(plan)}
      </div>`;

    // Constellation: the one ranking that uses information the game doesn't show
    const c = constellationModel();
    if (c) {
      const rows = c.ranked
        .slice(0, 6)
        .map(
          (d) => `<li class="kl-dom${d === c.best ? ' kl-hot' : ''}" title="${esc(`${d.name}: ${fmt(d.perWin, 2)} per win (${c.win} + ${d.s.ev.toFixed(2)} rarity bonus), best win ${d.maxWin}, ${(d.s.pLM * 100).toFixed(1)}% Legendary+.`)}"><div class="kl-row kl-between"><b><span class="kl-rank">${d.rank}</span>${esc(d.name)}</b><span class="kl-ev">${fmt(d.perWin, 2)}<small>/win</small></span></div>
          <div class="kl-strip">${RARITIES.map((r) => (d.s.by[r] ? `<span class="${rarityClass(r)}" style="flex:${d.s.by[r]}"></span>` : '')).join('')}</div></li>`
        )
        .join('');
      html += `<div class="kl-card"><div class="kl-lbl" title="Ranked by what a win pays (${c.win} + your cards' rarity bonus). Streaks add up to +${c.streakMax} anywhere.">Constellation · domains</div>
        <ul class="kl-list">${rows}</ul></div>`;
    } else if (!S.collection) html += KL.syncBlock();

    if (S.collection) {
      const list = throwList(vxRarity);
      html += `<div class="kl-card"><div class="kl-lbl">Vortex · safest throws</div>
        <div class="kl-seg">${['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary']
          .map((r) => `<button class="kl-segb${r === vxRarity ? ' kl-on' : ''}" data-act="pulsar-vx" data-r="${r}"><span class="kl-gem ${rarityClass(r)}"></span>${r}</button>`)
          .join('')}</div>
        <ul class="kl-list">${list.map((t) => `<li class="kl-item kl-throw" title="${esc(t.why)}"><a class="kl-card-link" href="/card/${esc(t.x.id)}"><span class="kl-gem ${rarityClass(t.x.r)}"></span>${esc(t.x.name)}</a>${t.x.q > 1 ? `<span class="kl-muted kl-small">×${t.x.q}</span>` : ''}</li>`).join('') || '<li class="kl-empty">No safe throws at this rarity.</li>'}</ul></div>`;
    }

    return html;
  }

  // ───────────────────────── extra chips (Vortex) ─────────────────────────
  function chips(t, i) {
    if (location.pathname !== '/vortex' || !i.own) return [];
    const blocked = F.locked | F.auction | F.albums | F.veil | F.mods;
    if (i.own.f & F.numberOne && i.own.q <= 1) return ['<span class="kl-chip kl-crit" data-g="#1" title="Your #1 copy">#1</span>'];
    if (i.own.f & blocked || i.critical) return [];
    const why = i.own.q > 1 ? `${i.own.q - 1} spare cop${i.own.q - 1 === 1 ? 'y' : 'ies'}` : i.fam ? `${i.fam.name} stays at its tier (${i.c - 1} ≥ ${i.floor})` : 'no family tier at stake';
    return [`<span class="kl-chip kl-safe" data-g="✓" title="Safe to throw: ${esc(why)}">✓ safe</span>`];
  }

  // ───────────────────────── wiring ─────────────────────────
  // buttons inside lobby cards (outside the panel)
  // buttons inside lobby cards are routed to onAct() by the core's capture-phase click handler

  KL.register({
    async init() {
      const saved = await store.get('pulsar');
      if (saved && typeof saved === 'object') {
        P.lob = { ...(saved.lob || {}), ...P.lob };
        P.photonRuns = { ...(saved.photonRuns || {}), ...P.photonRuns };
        P.horizonTrips = { ...(saved.horizonTrips || {}), ...P.horizonTrips };
        P.aionGames = { ...(saved.aionGames || {}), ...P.aionGames };
        if (saved.umbra) P.umbra = { ...saved.umbra, ...(P.umbra.snap ? { snap: P.umbra.snap } : {}) };
      }
      KL.scheduleScan();
    },
    onMessage(path, data) {
      const key = KEYS[path];
      if (!key) return false;
      ingest(key, data);
      return true;
    },
    onScan,
    chips,
    tab: { id: 'pulsar', label: 'Pulsar', render: panelView },
    onTab(id) {
      if (id === 'pulsar' && !Object.keys(P.lob).length) refreshAll();
    },
    onAct(act, el) {
      if (act === 'pulsar-refresh') return refreshAll(), true;
      if (act === 'pulsar-vx') {
        vxRarity = el.dataset.r;
        KL.renderPanel();
        return true;
      }
      return false;
    },
  });
})();
