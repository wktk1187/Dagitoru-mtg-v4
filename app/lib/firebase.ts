import { initializeApp, cert, App } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";

// Vercel環境では、デプロイごとにインスタンスが初期化される可能性があるため、
// グローバルスコープでAppインスタンスを保持し、重複初期化を防ぐ。
let firebaseApp: App;

if (!global._firebaseApp) {
  const serviceAccountBase64 = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!serviceAccountBase64) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON environment variable is not set.");
  }
  try {
    const decodedJsonString = Buffer.from(serviceAccountBase64, 'base64').toString('utf-8');
    const serviceAccount = JSON.parse(decodedJsonString);

    if (!serviceAccount.project_id) {
        console.warn('project_id not found in Firebase service account, attempting to use GCP_PROJECT_ID env var');
        serviceAccount.project_id = process.env.GCP_PROJECT_ID || 'dagitoru-mtg';
    }

    firebaseApp = initializeApp({
      credential: cert(serviceAccount),
      // projectId: serviceAccount.project_id // 必要に応じて projectId を initializeApp に渡すことも検討
    });
    global._firebaseApp = firebaseApp;
  } catch (error) {
    console.error("Failed to initialize Firebase Admin SDK:", error);
    throw new Error("Firebase Admin SDK initialization failed. Check GOOGLE_APPLICATION_CREDENTIALS_JSON.");
  }
} else {
  firebaseApp = global._firebaseApp;
}

export const db: Firestore = getFirestore(firebaseApp); 