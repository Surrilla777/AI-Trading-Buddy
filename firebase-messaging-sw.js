// Firebase Messaging Service Worker
// This runs in the background even when the app/browser is closed

importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

// Firebase config - will be injected during build/deploy
// For now, placeholder that gets replaced
const firebaseConfig = {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_PROJECT.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_PROJECT.appspot.com",
    messagingSenderId: "YOUR_SENDER_ID",
    appId: "YOUR_APP_ID"
};

firebase.initializeApp(firebaseConfig);

const messaging = firebase.messaging();

// Handle background messages (when app is closed or in background)
messaging.onBackgroundMessage((payload) => {
    console.log('[SW] Background message received:', payload);

    const notificationTitle = payload.notification?.title || payload.data?.title || 'Trading Alert';
    const notificationOptions = {
        body: payload.notification?.body || payload.data?.body || 'Check your trading app',
        icon: '/icon-192.png',
        badge: '/badge-72.png',
        tag: payload.data?.alertId || 'trading-alert',
        requireInteraction: true, // Keep notification until user interacts
        vibrate: [200, 100, 200, 100, 200], // Vibration pattern
        data: {
            url: payload.data?.url || '/',
            alertId: payload.data?.alertId,
            ticker: payload.data?.ticker,
            type: payload.data?.type
        },
        actions: [
            {
                action: 'view',
                title: 'View Alert'
            },
            {
                action: 'dismiss',
                title: 'Dismiss'
            }
        ]
    };

    // Add ticker-specific styling
    if (payload.data?.ticker) {
        notificationOptions.body = `${payload.data.ticker}: ${notificationOptions.body}`;
    }

    // Different icons for different alert types
    if (payload.data?.type === 'price_above' || payload.data?.type === 'breakout') {
        notificationOptions.icon = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📈</text></svg>';
    } else if (payload.data?.type === 'price_below' || payload.data?.type === 'breakdown') {
        notificationOptions.icon = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📉</text></svg>';
    } else if (payload.data?.type === 'volume_spike') {
        notificationOptions.icon = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">🔊</text></svg>';
    } else if (payload.data?.type === 'news') {
        notificationOptions.icon = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">📰</text></svg>';
    }

    return self.registration.showNotification(notificationTitle, notificationOptions);
});

// Handle notification click
self.addEventListener('notificationclick', (event) => {
    console.log('[SW] Notification clicked:', event);

    event.notification.close();

    if (event.action === 'dismiss') {
        return;
    }

    // Open the app when notification is clicked
    const urlToOpen = event.notification.data?.url || '/';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then((windowClients) => {
                // Check if app is already open
                for (const client of windowClients) {
                    if (client.url.includes(self.location.origin)) {
                        // Focus existing window and send message
                        client.focus();
                        client.postMessage({
                            type: 'NOTIFICATION_CLICKED',
                            alertId: event.notification.data?.alertId,
                            ticker: event.notification.data?.ticker
                        });
                        return;
                    }
                }
                // Open new window if app not open
                return clients.openWindow(urlToOpen);
            })
    );
});

// Handle push subscription change
self.addEventListener('pushsubscriptionchange', (event) => {
    console.log('[SW] Push subscription changed');
    // Re-subscribe and update server
    event.waitUntil(
        self.registration.pushManager.subscribe({ userVisibleOnly: true })
            .then((subscription) => {
                // Send new subscription to server
                return fetch('/api/update-subscription', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(subscription)
                });
            })
    );
});

// Cache static assets for offline support
const CACHE_NAME = 'trading-buddy-v1';
const urlsToCache = [
    '/',
    '/index.html',
    '/manifest.json'
];

self.addEventListener('install', (event) => {
    console.log('[SW] Installing service worker...');
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[SW] Caching app shell');
                return cache.addAll(urlsToCache);
            })
    );
    // Activate immediately
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('[SW] Activating service worker...');
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('[SW] Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    // Take control immediately
    self.clients.claim();
});

console.log('[SW] Firebase Messaging Service Worker loaded');
