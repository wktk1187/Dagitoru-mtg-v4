import { initializeApp, cert, App } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";

// Vercel環境では、デプロイごとにインスタンスが初期化される可能性があるため、
// グローバルスコープでAppインスタンスを保持し、重複初期化を防ぐ。
let firebaseApp: App;

if (!global._firebaseApp) {
  const serviceAccountJson = process.env.GCP_SERVICE_ACCOUNT_KEY_JSON;
  if (!serviceAccountJson) {
    throw new Error("GCP_SERVICE_ACCOUNT_KEY_JSON environment variable is not set.");
  }
  try {
    const serviceAccount = JSON.parse(serviceAccountJson);
    firebaseApp = initializeApp({
      credential: cert(serviceAccount),
    });
    global._firebaseApp = firebaseApp;
  } catch (error) {
    console.error("Failed to initialize Firebase Admin SDK:", error);
    throw new Error("Firebase Admin SDK initialization failed. Check GCP_SERVICE_ACCOUNT_KEY_JSON.");
  }
} else {
  firebaseApp = global._firebaseApp;
}

export const db: Firestore = getFirestore(firebaseApp); 