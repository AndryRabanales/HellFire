/* OnFire — service worker de AUTODESTRUCCIÓN.
   El escáner y su PWA se eliminaron. Este archivo solo existe para limpiar el
   service worker viejo en cualquier celular que lo haya instalado: borra su caché,
   se da de baja a sí mismo y recarga la página con el contenido nuevo del servidor.
   No intercepta nada (sin 'fetch'), así que deja de servir versiones cacheadas. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.navigate(c.url));
  })());
});
