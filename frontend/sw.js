// VirtualBet — Service Worker para Web Push
// Recibe pushes y los muestra como notificaciones nativas del SO.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'VirtualBet', body: '', url: '/', icon: '/favicon.ico' };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) { /* payload no JSON, ignorar */ }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body:  data.body,
      icon:  data.icon,
      badge: data.icon,
      tag:   data.tag,
      data:  { url: data.url },
      vibrate: [120, 60, 120],
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
      // Si hay una pestaña abierta, focusearla y navegar
      for (const w of windows) {
        if ('focus' in w) {
          w.focus();
          if ('navigate' in w) w.navigate(url);
          return;
        }
      }
      // Si no, abrir nueva
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
