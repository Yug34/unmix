/* Cross-origin isolation shim.
 *
 * SharedArrayBuffer -- and therefore multi-threaded WASM -- requires the COOP and
 * COEP headers. Some static hosts (GitHub Pages among them) cannot set response
 * headers at all. A service worker can re-serve responses with the headers
 * attached, which is enough to flip crossOriginIsolated on.
 *
 * Not needed when the server already sends the headers, as serve.py does.
 */

if (typeof window === 'undefined') {
  // --- service worker side ---
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

  self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;

    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.status === 0) return res;   // opaque; nothing to rewrite
          const headers = new Headers(res.headers);
          headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
          headers.set('Cross-Origin-Opener-Policy', 'same-origin');
          return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
        })
        .catch((err) => console.error(err)),
    );
  });
} else if (!window.crossOriginIsolated) {
  // --- page side: register, then reload once so the worker controls this page ---
  navigator.serviceWorker?.register(window.document.currentScript.src).then(
    (reg) => {
      reg.addEventListener('updatefound', () => window.location.reload());
      if (reg.active && !navigator.serviceWorker.controller) window.location.reload();
    },
    (err) => console.error('COI service worker failed to register:', err),
  );
}
