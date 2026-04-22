const CACHE_NAME = 'chess-coach-v1';
const ASSETS = ['./index.html', './app.js', './manifest.json'];

// ── Install: cache shell ──────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

// ── Activate: clean old caches ────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: serve from cache, fallback to network ──────────────────────────────
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ── Background Sync: poll Chess.com for new games ─────────────────────────────
self.addEventListener('periodicsync', e => {
  if (e.tag === 'poll-chess-games') {
    e.waitUntil(pollForNewGames());
  }
});

// ── Message from main thread: manual poll trigger ─────────────────────────────
self.addEventListener('message', e => {
  if (e.data?.type === 'POLL_NOW') {
    pollForNewGames();
  }
});

async function pollForNewGames() {
  try {
    // Read stored settings from IndexedDB via a workaround using Cache API for simplicity
    const settingsCache = await caches.open('chess-coach-settings');
    const settingsResp = await settingsCache.match('/settings');
    if (!settingsResp) return;
    const settings = await settingsResp.json();
    const { username, lastGameUrl, apiKey } = settings;
    if (!username) return;

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const url = `https://api.chess.com/pub/player/${username}/games/${year}/${month}`;

    const res = await fetch(url, { headers: { 'User-Agent': 'ChessCoachPWA/1.0' } });
    if (!res.ok) return;
    const data = await res.json();
    const games = data.games || [];
    if (!games.length) return;

    const latest = games[games.length - 1];
    if (latest.url === lastGameUrl) return; // no new game

    // Save new lastGameUrl
    settings.lastGameUrl = latest.url;
    const newSettingsResp = new Response(JSON.stringify(settings), {
      headers: { 'Content-Type': 'application/json' }
    });
    await settingsCache.put('/settings', newSettingsResp);

    // Notify all clients
    const clients = await self.clients.matchAll({ type: 'window' });
    for (const client of clients) {
      client.postMessage({ type: 'NEW_GAME', game: latest });
    }

    // Push notification if app is in background
    if (clients.length === 0 || clients.every(c => c.visibilityState === 'hidden')) {
      await self.registration.showNotification('New game detected! ♟', {
        body: `Tap to get your AI coaching breakdown`,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: 'new-game',
        data: { gameUrl: latest.url },
        actions: [{ action: 'analyze', title: 'Analyze Now' }]
      });
    }
  } catch (err) {
    console.error('[SW] Poll error:', err);
  }
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      if (clients.length > 0) {
        clients[0].focus();
        clients[0].postMessage({ type: 'OPEN_LATEST' });
      } else {
        self.clients.openWindow('/');
      }
    })
  );
});
