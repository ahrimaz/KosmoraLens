/* Kosmora Lens: card page module.
 *
 * Adds a "Market" section to /card/{id}: every open listing of this exact card
 * (price, bids, time left, seller, yours marked), how the cheapest compares with
 * the 30-day median, and a link that opens the Market search for it.
 *
 * Cost: one GET per card page, the same search the Market runs when you type the
 * card's name (/api/auctions?q=…), cached for 60 s. Nothing is ever bid or bought.
 */
(() => {
  'use strict';
  const KL = globalThis.__KL;
  if (!KL || KL.cardpageLoaded) return;
  KL.cardpageLoaded = true;
  const { S, fmt, esc, apiGet, micro } = KL;

  const cache = new Map(); // subjectId -> { t, items, error }
  const inflight = new Set();
  const TTL = 60e3;

  const timeLeft = (ms) => {
    const s = Math.max(0, Math.round((ms - Date.now()) / 1000));
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    const h = Math.floor(s / 3600);
    return h < 48 ? `${h}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(h / 24)}d`;
  };

  function cardName(id) {
    return (
      document.querySelector('.cd-head h1')?.textContent.trim() ||
      S.collection?.get(id)?.name ||
      document.querySelector('.cd .kc-name')?.textContent.trim() ||
      ''
    );
  }

  // the Market search leaves out your own listings, so read those from the
  // "See auction" links the card page shows under your copies
  const ownAuctionIds = () => [
    ...new Set(
      [...document.querySelectorAll('section.cd-own a[href^="/market/"]')]
        .map((a) => a.getAttribute('href').split('/')[2])
        .filter((x) => /^[0-9a-f-]{36}$/.test(x || ''))
    ),
  ];

  async function load(id, name) {
    if (inflight.has(id)) return;
    inflight.add(id);
    try {
      const j = await apiGet(`/api/auctions?q=${encodeURIComponent(name)}&sort=match&offset=0`);
      const items = (j.items || []).filter((a) => String(a.card?.subjectId) === id && a.state === 'open');
      for (const aid of ownAuctionIds()) {
        if (items.some((a) => a.id === aid)) continue;
        try {
          const a = await apiGet(`/api/auctions/${aid}`);
          if (a?.state === 'open' && String(a.card?.subjectId) === id) items.push({ ...a, yours: true });
        } catch {}
      }
      KL.ingestAny([...(j.items || []), ...items]); // feeds the sale-rate observations too
      KL.saveObs();
      cache.set(id, { t: Date.now(), items, more: (j.total || 0) > (j.items || []).length });
    } catch (e) {
      cache.set(id, { t: Date.now(), items: [], error: e.message || 'failed' });
    } finally {
      inflight.delete(id);
      KL.scheduleScan();
    }
  }

  const headHtml = (name) =>
    `<div class="kl-lob-head"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l2.6 6.9L22 12l-7.4 3.1L12 22l-2.6-6.9L2 12l7.4-3.1Z"/></svg><span>Lens</span><em>Market</em>
      <a class="kl-lob-btn" href="${KL.marketHref(name)}">Open in Market</a></div><div class="kl-lob-content"></div>`;

  function render(id, name, c) {
    if (!c) return `<div class="kl-skel"><i></i><i></i></div>`;
    if (c.error) return `<div class="kl-lob-body kl-muted">Couldn't read the Market right now (${esc(c.error)}).</div>`;

    const p = KL.priceFresh(id);
    const med = p?.med ?? null;
    const items = c.items
      .map((a) => ({
        id: a.id,
        price: micro(a.bestBid ?? a.startPrice),
        next: micro(a.minimumBid),
        bids: a.bids || 0,
        ends: Date.parse(a.endsAt),
        seller: a.seller,
        yours: !!a.yours,
        lead: !!a.youLead,
      }))
      .sort((a, b) => a.price - b.price);

    if (!items.length) {
      return `<div class="kl-lob-body"><b>Not on the market right now.</b> <span class="kl-muted">${
        med != null ? `30-day median ${fmt(med)} over ${p.n} sale${p.n === 1 ? '' : 's'}.` : 'No recent sales either.'
      }</span></div>`;
    }

    const low = items[0];
    const vs = med != null && med > 0 ? (low.price - med) / med : null;
    const mine = items.filter((a) => a.yours).length;
    // other sellers listing at or below your cheapest listing
    const myLow = Math.min(...items.filter((a) => a.yours).map((a) => a.price));
    const competing = mine ? items.filter((a) => !a.yours && a.price <= myLow).length : 0;
    const rows = items
      .slice(0, 8)
      .map(
        (a) => `<tr class="${a.yours ? 'kl-hl-row' : ''}">
          <td><a class="kl-game" href="/market/${esc(a.id)}">${fmt(a.price)}</a>${a.bids ? '' : ' <small>start</small>'}</td>
          <td class="kl-num-c">${a.bids}<small> bid${a.bids === 1 ? '' : 's'}</small></td>
          <td class="kl-num-c">${timeLeft(a.ends)}</td>
          <td>${a.yours ? '<b class="kl-gold">you</b>' : esc(a.seller || '')}${a.lead ? ' <small class="kl-pos">you lead</small>' : ''}</td>
        </tr>`
      )
      .join('');
    return `
      <div class="kl-lob-grid kl-g3">
        <div><small>Listed now</small><b>${items.length}</b><span>${mine ? `${mine} yours${competing ? ` · ${competing} competing at ≤ your price` : ' · cheapest is yours'}` : 'none yours'}</span></div>
        <div><small>Cheapest</small><b>${fmt(low.price)}</b><span>${low.bids ? `${low.bids} bid${low.bids === 1 ? '' : 's'}` : 'no bids yet'} · ends ${timeLeft(low.ends)}</span></div>
        <div><small>vs 30-day median</small><b class="${vs == null ? '' : vs <= -0.15 ? 'kl-pos' : vs >= 0.25 ? 'kl-neg' : ''}">${vs == null ? '—' : `${vs >= 0 ? '+' : '−'}${Math.round(Math.abs(vs) * 100)}%`}</b><span>${med != null ? `median ${fmt(med)}` : 'no recent sales'}</span></div>
      </div>
      <table class="kl-tbl kl-mk"><thead><tr><th>Price</th><th class="kl-num-c">Bids</th><th class="kl-num-c">Ends</th><th>Seller</th></tr></thead><tbody>${rows}</tbody></table>
      ${items.length > 8 ? `<div class="kl-lob-note kl-muted">${items.length - 8} more in the Market.</div>` : ''}`;
  }

  function onScan() {
    const m = location.pathname.match(/^\/card\/(\d+)\/?$/);
    const existing = document.querySelector('.kl-lob[data-kind="card-market"]');
    const anchor = m && (document.querySelector('section.cd-own') || document.querySelector('[data-testid="card-sales"]'));
    if (!m || !anchor) return existing?.remove();
    const id = String(Number(m[1]));
    const name = cardName(id);
    if (!name) return;
    const c = cache.get(id);
    if ((!c || Date.now() - c.t > TTL) && !inflight.has(id)) load(id, name);
    // a price entry makes the "vs median" comparison possible; the page usually loads it for us
    if (!KL.priceFresh(id)) KL.getPrice(id).catch(() => {});

    let el = existing;
    if (!el) {
      el = document.createElement('section');
      el.className = 'kl-lob kl-lob-card';
      el.dataset.kind = 'card-market';
    }
    // sit right after "your copies" when it exists, else just before Recent sales
    if (anchor.matches('section.cd-own')) {
      if (el.previousElementSibling !== anchor) anchor.after(el);
    } else if (el.nextElementSibling !== anchor) anchor.before(el);
    // The header (with the button) is built once per card and never replaced, so a click
    // can't be lost to a redraw; only the content below it refreshes as data arrives.
    if (el.dataset.card !== id) {
      el.dataset.card = id;
      el.dataset.sig = '';
      el.innerHTML = headHtml(name);
    }
    const sig = `${c?.t}|${KL.priceFresh(id)?.t}|${Math.floor(Date.now() / 30e3)}`;
    if (el.dataset.sig !== sig) {
      el.dataset.sig = sig;
      el.querySelector('.kl-lob-content').innerHTML = render(id, name, c);
    }
  }

  KL.register({ onScan });
})();
