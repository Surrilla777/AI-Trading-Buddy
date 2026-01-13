// Firebase Configuration
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyAgfBV-YPkq7lJSEECw2b8zowCIKhuTGf8",
    authDomain: "ai-trading-buddy-dc686.firebaseapp.com",
    projectId: "ai-trading-buddy-dc686",
    storageBucket: "ai-trading-buddy-dc686.firebasestorage.app",
    messagingSenderId: "803599636392",
    appId: "1:803599636392:web:16d7be694fc35cef822f9d"
};

// VAPID Key for Web Push (Get from Firebase Console > Project Settings > Cloud Messaging > Web Push certificates)
const VAPID_KEY = "BHymg8ldstiZgySMQ3HObQzv3l1YJ-k8PXK4svUR3mMZLSQXsd39QjQ22HreIJUUX-0bIQm7hVAQGLZBlh4JHfY";

// Export for use in app
if (typeof window !== 'undefined') {
    window.FIREBASE_CONFIG = FIREBASE_CONFIG;
    window.VAPID_KEY = VAPID_KEY;
}
