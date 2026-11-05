/* Kosmora Lens: the game's Fusion page.
 *
 * Info only. Nothing here clicks, selects or fills the tray, and the game's own controls
 * are never restyled:
 *  - under each rarity button: what one fusion is worth on the Market (+/−) and how many
 *    fusions are safe (no family loses a tier, no protected copy is used);
 *  - one Lens line above the tray for the rarity you're on: fuse, or sell instead;
 *  - "✓ safe" chips on the grid tiles that are good to fuse (only when fusing that rarity
 *    gains value), using the same chip slot as every other Lens badge.
 * Same data as the panel's Fusion tab: no extra requests beyond its cached GETs.
 */
(() => {
  'use strict';
  const KL = globalThis.__KL;
  if (!KL || KL.fusionpageLoaded) return;
  KL.fusionpageLoaded = true;
  const { S, fmt, esc } = KL;

  const ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.6 6.9L22 12l-7.4 3.1L12 22l-2.6-6.9L2 12l7.4-3.1Z"/></svg>`;
  const onPage = () => location.pathname === '/fusion';
  const article = (r) => (/^[AEIOU]/.test(r) ? 'an' : 'a');

  // the rarity the game is showing: its own selected recipe button
  function activeRarity() {
    const b = document.querySelector('.fu-recipe[aria-checked="true"]');
    return b ? KL.FUSE_ORDER.find((r) => b.classList.contains(`fu-r-${r.toLowerCase()}`)) || null : null;
  }

  let loading = 0;
  function ensureData() {
    if (Date.now() - loading < 30e3) return;
    loading = Date.now();
    KL.getFusion().catch(() => {});
    KL.getMarketStats().catch(() => {});
    if (!S.prod) KL.getMe().catch(() => {});
    if (!S.families) KL.getFamilies().catch(() => {});
  }

  const ready = () => S.collection && S.families;

  // which tiles get "✓ safe": the advisor's picks for that rarity, only if fusing it gains value
  function safeMap(r) {
    if (!ready()) return null;
    const v = KL.fuseValue(r);
    if (v && v.net <= 0) return null;
    const o = KL.fusionAdvice()[r];
    if (!o || !o.fusions) return null;
    if (o._safe) return o._safe;
    o._safe = new Map(o.items.map((it) => [it.x.id, it]));
    return o._safe;
  }

  // ── labels under the game's rarity buttons ──
  function labelRecipes() {
    const adv = ready() ? KL.fusionAdvice() : null;
    for (const btn of document.querySelectorAll('.fu-recipe')) {
      const r = KL.FUSE_ORDER.find((x) => btn.classList.contains(`fu-r-${x.toLowerCase()}`));
      if (!r) continue;
      const v = KL.fuseValue(r);
      const n = adv?.[r]?.fusions;
      const sig = `${S.rev}|${v?.net}|${n}`;
      let el = btn.querySelector(':scope > .kl-fu-lbl');
      if (el?.dataset.sig === sig) continue;
      if (v == null && n == null) {
        el?.remove();
        continue;
      }
      if (!el) {
        el = document.createElement('span');
        el.className = 'kl-fu-lbl';
        btn.appendChild(el);
      }
      el.dataset.sig = sig;
      const val = v ? `<b class="${v.net > 0 ? 'kl-pos' : 'kl-neg'}">${v.net > 0 ? '+' : '−'}${KL.kosmo(Math.abs(v.net))}</b>` : '';
      const safe = n != null ? `<span>${n ? `${fmt(n)} safe` : 'none safe'}</span>` : '';
      el.innerHTML = [val, safe].filter(Boolean).join('<i>·</i>');
      el.title = `${v ? `Each fusion ${v.net > 0 ? 'gains' : 'loses'} ~${KL.kosmo(Math.abs(v.net))} Kosmo on the Market (7-day median sales). ` : ''}${n != null ? `${fmt(n)} fusions keep every family tier.` : ''} (Lens)`;
    }
  }

  // ── one Lens line above the tray ──
  function lineHtml(r) {
    if (!S.collection) return `<span class="kl-muted">Reading your collection…</span>`;
    if (!S.families) return `<span class="kl-muted">Reading your families…</span>`;
    const o = KL.fusionAdvice()[r];
    const v = KL.fuseValue(r);
    const to = S.fusion?.recipes?.[r]?.to || KL.RARITIES[KL.RARITIES.indexOf(r) + 1];
    if (v && v.net <= 0) {
      const tip = `${v.cost} ${KL.plural(r)} sell for ~${KL.kosmo(v.put)}, ${article(to)} ${to} for ~${KL.kosmo(v.get)} (7-day median sales).`;
      return `<b class="kl-neg" title="${esc(tip)}">Sell instead</b>`;
    }
    if (!o?.fusions) return `<b>Nothing safe to fuse</b>`;
    return `<b class="kl-pos">Fuse</b> <span>the <span class="kl-chip-demo kl-safe">✓ safe</span> tiles</span>`;
  }

  function mountLine() {
    const r = activeRarity();
    const anchor = document.querySelector('.fu-talent') || document.querySelector('.fu-recipes');
    let el = document.querySelector('.kl-lob[data-kind="fusion-line"]');
    if (!r || !anchor) return el?.remove();
    if (!el) {
      el = document.createElement('section');
      el.className = 'kl-lob kl-lob-fusion';
      el.dataset.kind = 'fusion-line';
      el.innerHTML = `<div class="kl-fu-row">${ICON}<span class="kl-fu-brand">Lens</span><div class="kl-fu-text"></div>
        <button type="button" class="kl-lob-btn kl-ghostbtn" data-kl-act="fu-open" title="Your next batch, with card names to copy">Next batch</button></div>`;
    }
    if (el.previousElementSibling !== anchor) anchor.after(el);
    const sig = `${r}|${S.rev}|${!!S.collection}|${!!S.families}|${S.mstats?.t}|${S.fusion?.t}`;
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    el.querySelector('.kl-fu-text').innerHTML = lineHtml(r);
    // the panel's batch list only makes sense when fusing this rarity is a good idea
    el.querySelector('[data-kl-act="fu-open"]').hidden = !safeMap(r);
  }

  function onScan() {
    if (!onPage()) {
      document.querySelectorAll('.kl-lob[data-kind="fusion-line"], .kl-fu-lbl').forEach((e) => e.remove());
      return;
    }
    ensureData();
    labelRecipes();
    mountLine();
  }

  // ✓ safe on the grid tiles (the core calls this for every card it decorates)
  function chips(t) {
    if (!onPage() || !t.rarity) return [];
    const m = safeMap(t.rarity);
    const it = m?.get(t.id);
    if (!it) return [];
    const why = it.spare
      ? `${it.n} spare cop${it.n === 1 ? 'y' : 'ies'}: your income stays the same`
      : it.x.famName
        ? `${it.x.famName} keeps its tier`
        : 'no family tier at stake';
    return [`<span class="kl-chip kl-safe" data-g="✓" title="Safe to fuse (Lens): ${esc(why)}">✓ ${it.spare ? 'spare' : 'safe'}</span>`];
  }

  KL.register({
    onScan,
    chips,
    onAct(act) {
      if (act !== 'fu-open') return false;
      KL.openTab('fusion', { fuseRarity: activeRarity() });
      return true;
    },
  });
})();
