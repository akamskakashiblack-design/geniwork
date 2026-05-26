/* ═══════════════════════════════════════════════════════════════
   GENIWORK — Firebase Messaging Service Worker
   Reçoit les push notifications en arrière-plan (app fermée ou onglet inactif)
═══════════════════════════════════════════════════════════════ */

importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            'AIzaSyBodK0Tg5BSIYfLfhT-1ggV2kWXONsR3Ow',
  authDomain:        'geniwork-be35c.firebaseapp.com',
  databaseURL:       'https://geniwork-be35c-default-rtdb.europe-west1.firebasedatabase.app',
  projectId:         'geniwork-be35c',
  storageBucket:     'geniwork-be35c.firebasestorage.app',
  messagingSenderId: '180664489098',
  appId:             '1:180664489098:web:6c80d5ebd5f60d8c554973'
});

const messaging = firebase.messaging();

/* ── Notification reçue en arrière-plan ── */
messaging.onBackgroundMessage(function(payload) {
  var title   = (payload.notification && payload.notification.title) || (payload.data && payload.data.title) || 'Geniwork';
  var body    = (payload.notification && payload.notification.body)  || (payload.data && payload.data.body)  || '';
  var icon    = (payload.notification && payload.notification.icon)  || '/img/icon-192.png';

  self.registration.showNotification(title, {
    body:    body,
    icon:    icon,
    badge:   '/img/icon-96.png',
    vibrate: [200, 100, 200],
    tag:     payload.data ? (payload.data.tag || 'geniwork') : 'geniwork',
    data:    payload.data || {}
  });
});

/* ── Clic sur la notification → ouvre/focus l'app ── */
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url && 'focus' in list[i]) return list[i].focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});
