/* Kosmora Lens: page-world observer.
 *
 * Passes copies of data the game already loads to the Lens content scripts:
 *  - GET responses from an allow-list (market, prices, collection, pack results,
 *    Pulsar lobbies and finished-game histories);
 *  - the game's replies to collection-changing actions you take in the page
 *    (opening packs, fusing, Vortex, trades, transfers, listing cards), so the
 *    collection snapshot stays current;
 *  - events from the game's own live event stream that change your collection
 *    (pack openings, auctions, trades, transfers).
 *
 * It never sends a request of its own, never opens its own event stream, and hands
 * the page its original responses untouched. Nothing from inside a running Pulsar
 * round is relayed: those endpoints are deliberately not on any list.
 */
(() => {
  if (window.__klHook) return;
  window.__klHook = true;

  const GET_WATCH = new RegExp(
    '^/api/(' +
      [
        // market & cards
        'auctions(?:/[^/?]+)?',
        'me/auctions',
        'cards/[^/?]+/prices',
        // collection truth the game loads anyway
        'me',
        'collection',
        'collection/[^/?]+',
        'openings/[^/?]+',
        'fusion', // your talent-adjusted fusion recipes (the Fusion page loads it)
        // Pulsar: lobbies, hubs and finished-game histories only
        'games/today',
        'constellation/hub',
        'exploration/hub',
        'timeline/lobby',
        'timeline/history',
        'photon/lobby',
        'umbra/lobby',
        'vortex/lobby',
      ].join('|') +
      ')$'
  );
  // replies to your own collection-changing actions (read only; Pulsar rounds excluded)
  // (POST /api/fusion/quote is only the tray preview the game sends on every pick; skip it)
  const ACTION_WATCH = /^\/api\/(packs\/open|openings\/[^/?]+\/presented|fusions?(?!\/quote$)(\/[^?]*)?|talents3\/powers\/(golden|grand)-fusion(\/[^?]*)?|vortex\/(?!lobby$)[^?]+|trades?(\/[^?]*)?|transfers?(\/[^?]*)?|market\/(sell|listings)(\/[^?]*)?|copies\/[^?]+|auctions\/[^/?]+\/(cancel|relist|withdraw))$/;
  // live events that change what you own
  const EVENT_WATCH = /^(opening|auction|trade|transfer|pack)\./;

  const origFetch = window.fetch;
  let ready = false;
  const buffer = [];

  const send = (msg) => window.postMessage(msg, location.origin);
  const relay = (msg) => {
    if (ready) send(msg);
    else {
      buffer.push(msg);
      if (buffer.length > 80) buffer.shift();
    }
  };

  // the content scripts load later (document_idle); they say hello, then we flush
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.__kosmoraLensReady === 1 && !ready) {
      ready = true;
      buffer.splice(0).forEach(send);
    }
  });

  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    try {
      const req = args[0];
      const url = new URL(typeof req === 'string' ? req : req?.url || String(req), location.href);
      const method = (args[1]?.method || req?.method || 'GET').toUpperCase();
      if (url.origin === location.origin) {
        const isGet = method === 'GET' && GET_WATCH.test(url.pathname);
        const isAction = method !== 'GET' && ACTION_WATCH.test(url.pathname);
        if (isGet || isAction) {
          p.then((res) => {
            if (!res.ok) return;
            res
              .clone()
              .json()
              .then((data) => relay({ __kosmoraLens: 1, path: url.pathname, search: url.search, action: isAction, data }))
              .catch(() => {});
          }).catch(() => {});
        }
      }
    } catch {}
    return p;
  };

  // Tap the game's own EventSource: when the app subscribes to an event type that can
  // change your collection, add one extra copy-only listener for that same type.
  const ES = window.EventSource;
  if (ES && ES.prototype) {
    const origAdd = ES.prototype.addEventListener;
    const tapped = new WeakMap();
    ES.prototype.addEventListener = function (type, fn, opts) {
      try {
        if (typeof type === 'string' && EVENT_WATCH.test(type)) {
          let seen = tapped.get(this);
          if (!seen) tapped.set(this, (seen = new Set()));
          if (!seen.has(type)) {
            seen.add(type);
            origAdd.call(this, type, (ev) => {
              let data = null;
              try {
                data = JSON.parse(ev.data || 'null');
              } catch {}
              relay({ __kosmoraLens: 1, event: type, data });
            });
          }
        }
      } catch {}
      return origAdd.call(this, type, fn, opts);
    };
  }
})();
