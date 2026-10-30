import crypto from 'node:crypto';

export interface R2Config {
  accountId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  bucketName?: string;
  publicUrl?: string; // e.g. https://pub-xxxx.r2.dev or https://slides.medatlas.com
  endpoint?: string;
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function hashSha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function getR2Config(): R2Config {
  const env = process.env;
  const accountId = (env.R2_ACCOUNT_ID || env.CLOUDFLARE_R2_ACCOUNT_ID || '').trim();
  const accessKeyId = (env.R2_ACCESS_KEY_ID || env.CLOUDFLARE_R2_ACCESS_KEY_ID || '').trim();
  const secretAccessKey = (env.R2_SECRET_ACCESS_KEY || env.CLOUDFLARE_R2_SECRET_ACCESS_KEY || '').trim();
  const bucketName = (env.R2_BUCKET_NAME || env.CLOUDFLARE_R2_BUCKET_NAME || 'medatlas-lectures').trim();
  const publicUrl = (env.R2_PUBLIC_URL || env.CLOUDFLARE_R2_PUBLIC_URL || '').trim().replace(/\/+$/, '');

  const endpoint =
    (env.R2_ENDPOINT || env.CLOUDFLARE_R2_ENDPOINT || '').trim().replace(/\/+$/, '') ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucketName,
    publicUrl,
    endpoint,
  };
}

export function isR2Configured(): boolean {
  const config = getR2Config();
  return Boolean(config.accessKeyId && config.secretAccessKey && config.endpoint && config.bucketName);
}

export function getR2PublicUrl(fileName: string): string | null {
  const config = getR2Config();
  if (!config.publicUrl) return null;
  const safeName = encodeURIComponent(fileName.trim());
  return `${config.publicUrl}/${safeName}`;
}

/**
 * Uploads a file buffer directly to Cloudflare R2 using AWS Signature Version 4.
 * Zero external dependencies, pure Node.js crypto.
 */
export async function uploadToR2(params: {
  fileName: string;
  data: Buffer;
  contentType?: string;
}): Promise<{ success: boolean; key: string; publicUrl: string | null }> {
  const config = getR2Config();
  if (!isR2Configured()) {
    throw new Error('Cloudflare R2 is not fully configured (missing R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, or R2_ACCOUNT_ID).');
  }

  const { accessKeyId, secretAccessKey, bucketName, endpoint, publicUrl } = config;
  const region = 'auto';
  const service = 's3';

  const baseUrl = `${endpoint}/${bucketName}`;
  const pathUrl = `/${encodeURIComponent(params.fileName)}`;
  const fullUrl = `${baseUrl}${pathUrl}`;

  const payloadHash = hashSha256(params.data);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const host = new URL(baseUrl).host;

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest = `PUT\n${pathUrl}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${hashSha256(canonicalRequest)}`;

  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const headers = {
    Host: host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    Authorization: authorization,
    'Content-Type': params.contentType || 'application/pdf',
    'Content-Length': String(params.data.length),
  };

  const response = await fetch(fullUrl, {
    method: 'PUT',
    headers,
    body: new Uint8Array(params.data),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Cloudflare R2 upload failed (${response.status} ${response.statusText}): ${errText}`);
  }

  const directPublicUrl = publicUrl ? `${publicUrl}/${encodeURIComponent(params.fileName)}` : null;

  return {
    success: true,
    key: params.fileName,
    publicUrl: directPublicUrl,
  };
}
