import crypto from 'node:crypto';
import firebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };

export interface FirebaseStorageUploadResult {
  success: boolean;
  url: string;
  fileName: string;
  fileSize: number;
}

/**
 * Uploads a file buffer directly to Firebase Storage using the Firebase Storage REST API.
 * Uses the pre-configured project storage bucket and API key from firebase-applet-config.json.
 * Does NOT require any credit card or server service account credentials.
 */
export async function uploadPdfToFirebaseStorage(
  fileName: string,
  buffer: Buffer,
  mimeType = 'application/pdf'
): Promise<FirebaseStorageUploadResult> {
  const bucket =
    process.env.FIREBASE_STORAGE_BUCKET?.trim() ||
    firebaseConfig.storageBucket?.trim() ||
    `${firebaseConfig.projectId}.firebasestorage.app`;

  const apiKey =
    process.env.VITE_FIREBASE_API_KEY?.trim() ||
    firebaseConfig.apiKey?.trim();

  if (!bucket) {
    throw new Error('Firebase Storage bucket is not configured in firebase-applet-config.json.');
  }

  const safeStoragePath = `lectures/${fileName}`;
  const downloadToken = crypto.randomUUID();

  // Upload using the official Google Firebase Storage media upload REST API
  const uploadEndpoint = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(
    bucket
  )}/o?uploadType=media&name=${encodeURIComponent(safeStoragePath)}`;

  const headers: Record<string, string> = {
    'Content-Type': mimeType || 'application/pdf',
    'Content-Length': String(buffer.length),
  };

  if (apiKey) {
    headers['x-goog-api-key'] = apiKey;
  }

  const uploadRes = await fetch(uploadEndpoint, {
    method: 'POST',
    headers,
    body: new Uint8Array(buffer),
  });

  if (!uploadRes.ok) {
    const errorBody = await uploadRes.text().catch(() => '');
    throw new Error(
      `Firebase Storage upload failed (${uploadRes.status} ${uploadRes.statusText}): ${errorBody}`
    );
  }

  // Set download token metadata so the file has a permanent, public download link
  try {
    const metaEndpoint = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(
      bucket
    )}/o/${encodeURIComponent(safeStoragePath)}`;

    await fetch(metaEndpoint, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'x-goog-api-key': apiKey } : {}),
      },
      body: JSON.stringify({
        metadata: {
          firebaseStorageDownloadTokens: downloadToken,
        },
      }),
    });
  } catch (metaErr) {
    console.warn('[FIREBASE_STORAGE_METADATA_NOTICE] Could not attach download token metadata:', metaErr);
  }

  // Public Firebase CDN Download URL
  const publicDownloadUrl = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(
    bucket
  )}/o/${encodeURIComponent(safeStoragePath)}?alt=media&token=${downloadToken}`;

  return {
    success: true,
    url: publicDownloadUrl,
    fileName,
    fileSize: buffer.length,
  };
}

export function isFirebaseStorageConfigured(): boolean {
  return Boolean(firebaseConfig?.storageBucket || firebaseConfig?.projectId);
}
