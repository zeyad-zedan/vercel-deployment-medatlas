import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface StorageObjectMeta {
  key: string;
  size: number;
  lastModified: Date;
  sha256?: string;
}

export interface BackupStorageProvider {
  name: string;
  isDurable: boolean;
  upload(params: {
    key: string;
    data: Buffer | string;
    contentType?: string;
    metadata?: Record<string, string>;
  }): Promise<{ key: string; location: string; etag?: string }>;
  download(key: string): Promise<Buffer>;
  list(prefix?: string): Promise<StorageObjectMeta[]>;
  delete(key: string): Promise<void>;
  verify(key: string, expectedSha256?: string): Promise<boolean>;
}

// ============================================================================
// 1. S3-Compatible Storage Provider (AWS S3, Cloudflare R2, MinIO, Wasabi)
// Uses lightweight SigV4 with Node.js built-in crypto & fetch (no heavy SDK)
// ============================================================================
export interface S3Config {
  bucket: string;
  endpoint?: string; // e.g. "https://<account-id>.r2.cloudflarestorage.com"
  region?: string;   // default "auto" or "us-east-1"
  accessKeyId: string;
  secretAccessKey: string;
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function hashSha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export class S3CompatibleStorageProvider implements BackupStorageProvider {
  name = 's3-compatible';
  isDurable = true;
  private config: S3Config;
  private baseUrl: string;
  private region: string;

  constructor(config: S3Config) {
    if (!config.bucket || !config.accessKeyId || !config.secretAccessKey) {
      throw new Error('S3 Storage Provider requires bucket, accessKeyId, and secretAccessKey.');
    }
    this.config = config;
    this.region = config.region || 'auto';

    if (config.endpoint) {
      const trimmed = config.endpoint.replace(/\/+$/, '');
      this.baseUrl = `${trimmed}/${config.bucket}`;
    } else {
      this.baseUrl = `https://${config.bucket}.s3.${this.region === 'auto' ? 'us-east-1' : this.region}.amazonaws.com`;
    }
  }

  private signHeaders(method: string, pathUrl: string, payloadHash: string, query = ''): Record<string, string> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const service = 's3';
    const host = new URL(this.baseUrl).host;

    const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

    const canonicalRequest = `${method}\n${pathUrl}\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
    const credentialScope = `${dateStamp}/${this.region}/${service}/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${hashSha256(canonicalRequest)}`;

    const kDate = hmacSha256(`AWS4${this.config.secretAccessKey}`, dateStamp);
    const kRegion = hmacSha256(kDate, this.region);
    const kService = hmacSha256(kRegion, service);
    const kSigning = hmacSha256(kService, 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

    const authorization = `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
      Host: host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      Authorization: authorization,
    };
  }

  async upload(params: {
    key: string;
    data: Buffer | string;
    contentType?: string;
  }): Promise<{ key: string; location: string; etag?: string }> {
    const buf = Buffer.isBuffer(params.data) ? params.data : Buffer.from(params.data, 'utf8');
    const payloadHash = hashSha256(buf);
    const pathUrl = `/${encodeURIComponent(params.key)}`;
    const fullUrl = `${this.baseUrl}${pathUrl}`;

    const headers = {
      ...this.signHeaders('PUT', pathUrl, payloadHash),
      'Content-Type': params.contentType || 'application/json',
      'Content-Length': String(buf.length),
    };

    const res = await fetch(fullUrl, {
      method: 'PUT',
      headers,
      body: new Uint8Array(buf),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`S3 upload failed (${res.status} ${res.statusText}): ${errText}`);
    }

    const etag = res.headers.get('etag')?.replace(/"/g, '') || undefined;
    return { key: params.key, location: fullUrl, etag };
  }

  async download(key: string): Promise<Buffer> {
    const pathUrl = `/${encodeURIComponent(key)}`;
    const fullUrl = `${this.baseUrl}${pathUrl}`;
    const emptyHash = hashSha256('');
    const headers = this.signHeaders('GET', pathUrl, emptyHash);

    const res = await fetch(fullUrl, { method: 'GET', headers });
    if (!res.ok) {
      throw new Error(`S3 download failed for ${key} (${res.status} ${res.statusText})`);
    }

    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  async list(prefix = ''): Promise<StorageObjectMeta[]> {
    const query = prefix ? `list-type=2&prefix=${encodeURIComponent(prefix)}` : 'list-type=2';
    const emptyHash = hashSha256('');
    const headers = this.signHeaders('GET', '/', emptyHash, query);
    const fullUrl = `${this.baseUrl}/?${query}`;

    const res = await fetch(fullUrl, { method: 'GET', headers });
    if (!res.ok) {
      throw new Error(`S3 list failed (${res.status} ${res.statusText})`);
    }

    const xml = await res.text();
    const results: StorageObjectMeta[] = [];
    const keyMatches = [...xml.matchAll(/<Key>(.*?)<\/Key>.*?<Size>(\d+)<\/Size>.*?<LastModified>(.*?)<\/LastModified>/gs)];

    for (const match of keyMatches) {
      results.push({
        key: match[1],
        size: Number.parseInt(match[2], 10),
        lastModified: new Date(match[3]),
      });
    }

    return results;
  }

  async delete(key: string): Promise<void> {
    const pathUrl = `/${encodeURIComponent(key)}`;
    const fullUrl = `${this.baseUrl}${pathUrl}`;
    const emptyHash = hashSha256('');
    const headers = this.signHeaders('DELETE', pathUrl, emptyHash);

    const res = await fetch(fullUrl, { method: 'DELETE', headers });
    if (!res.ok && res.status !== 404) {
      throw new Error(`S3 delete failed for ${key} (${res.status} ${res.statusText})`);
    }
  }

  async verify(key: string, expectedSha256?: string): Promise<boolean> {
    try {
      const data = await this.download(key);
      if (expectedSha256) {
        const actualSha256 = hashSha256(data);
        return actualSha256 === expectedSha256;
      }
      return data.length > 0;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// 2. Supabase Storage Provider (Private Bucket)
// Compatible with existing Supabase integration in MedAtlas
// ============================================================================
export class SupabasePrivateStorageProvider implements BackupStorageProvider {
  name = 'supabase-private-storage';
  isDurable = true;
  private bucket: string;
  private client: any;

  constructor(bucket: string, client: any) {
    this.bucket = bucket;
    this.client = client;
  }

  async upload(params: {
    key: string;
    data: Buffer | string;
    contentType?: string;
  }): Promise<{ key: string; location: string; etag?: string }> {
    const buf = Buffer.isBuffer(params.data) ? params.data : Buffer.from(params.data, 'utf8');
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .upload(params.key, buf, {
        contentType: params.contentType || 'application/json',
        upsert: true,
      });

    if (error) {
      throw new Error(`Supabase Storage upload failed for ${params.key}: ${error.message}`);
    }

    return { key: params.key, location: `${this.bucket}/${params.key}`, etag: data?.id };
  }

  async download(key: string): Promise<Buffer> {
    const { data, error } = await this.client.storage.from(this.bucket).download(key);
    if (error || !data) {
      throw new Error(`Supabase Storage download failed for ${key}: ${error?.message || 'Empty response'}`);
    }
    const arrayBuf = await data.arrayBuffer();
    return Buffer.from(arrayBuf);
  }

  async list(prefix = ''): Promise<StorageObjectMeta[]> {
    const { data, error } = await this.client.storage.from(this.bucket).list(prefix, {
      sortBy: { column: 'name', order: 'desc' },
    });

    if (error) {
      throw new Error(`Supabase Storage list failed: ${error.message}`);
    }

    return (data || []).map((item: any) => ({
      key: prefix ? `${prefix}/${item.name}` : item.name,
      size: item.metadata?.size || 0,
      lastModified: item.updated_at ? new Date(item.updated_at) : new Date(item.created_at || Date.now()),
    }));
  }

  async delete(key: string): Promise<void> {
    const { error } = await this.client.storage.from(this.bucket).remove([key]);
    if (error) {
      throw new Error(`Supabase Storage delete failed for ${key}: ${error.message}`);
    }
  }

  async verify(key: string, expectedSha256?: string): Promise<boolean> {
    try {
      const data = await this.download(key);
      if (expectedSha256) {
        return hashSha256(data) === expectedSha256;
      }
      return data.length > 0;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// 3. Local Filesystem Provider (Development and Unit Tests ONLY)
// ============================================================================
export class LocalFsStorageProvider implements BackupStorageProvider {
  name = 'local-filesystem';
  isDurable = false; // Local disk is NOT durable on Vercel serverless!
  private dir: string;

  constructor(dir?: string) {
    this.dir = dir || path.resolve(process.cwd(), 'backups');
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    }
  }

  async upload(params: {
    key: string;
    data: Buffer | string;
  }): Promise<{ key: string; location: string }> {
    const targetPath = path.join(this.dir, path.basename(params.key));
    const buf = Buffer.isBuffer(params.data) ? params.data : Buffer.from(params.data, 'utf8');
    fs.writeFileSync(targetPath, buf, { mode: 0o600 });
    return { key: params.key, location: targetPath };
  }

  async download(key: string): Promise<Buffer> {
    const targetPath = path.join(this.dir, path.basename(key));
    if (!fs.existsSync(targetPath)) {
      throw new Error(`Local file not found: ${key}`);
    }
    return fs.readFileSync(targetPath);
  }

  async list(): Promise<StorageObjectMeta[]> {
    if (!fs.existsSync(this.dir)) return [];
    const files = fs.readdirSync(this.dir);
    const results: StorageObjectMeta[] = [];

    for (const f of files) {
      const p = path.join(this.dir, f);
      try {
        const stat = fs.statSync(p);
        if (stat.isFile()) {
          results.push({
            key: f,
            size: stat.size,
            lastModified: stat.mtime,
          });
        }
      } catch {}
    }

    return results;
  }

  async delete(key: string): Promise<void> {
    const targetPath = path.join(this.dir, path.basename(key));
    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
    }
  }

  async verify(key: string, expectedSha256?: string): Promise<boolean> {
    try {
      const data = await this.download(key);
      if (expectedSha256) {
        return hashSha256(data) === expectedSha256;
      }
      return data.length > 0;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// Storage Resolver
// ============================================================================
export async function resolveBackupStorageProvider(): Promise<BackupStorageProvider> {
  const env = process.env;

  // 1. Check for S3 / Cloudflare R2 / MinIO configuration
  if (env.BACKUP_S3_BUCKET && env.BACKUP_S3_ACCESS_KEY_ID && env.BACKUP_S3_SECRET_ACCESS_KEY) {
    return new S3CompatibleStorageProvider({
      bucket: env.BACKUP_S3_BUCKET,
      endpoint: env.BACKUP_S3_ENDPOINT,
      region: env.BACKUP_S3_REGION || 'auto',
      accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID,
      secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY,
    });
  }

  // 2. Check for Supabase Private Storage configuration
  if (
    env.SUPABASE_URL &&
    (env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY) &&
    env.SUPABASE_BACKUP_BUCKET
  ) {
    const { createClient } = await import('@supabase/supabase-js');
    const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY!;
    const supabase = createClient(env.SUPABASE_URL, key);
    return new SupabasePrivateStorageProvider(env.SUPABASE_BACKUP_BUCKET, supabase);
  }

  // 3. Fallback to local filesystem
  const isProduction = env.NODE_ENV === 'production' || Boolean(env.VERCEL);
  if (isProduction) {
    console.warn(
      '[CRITICAL_WARNING] Production environment lacks off-site durable storage configuration (BACKUP_S3_BUCKET or SUPABASE_BACKUP_BUCKET). Backups on local ephemeral disk will NOT survive serverless redeployments.'
    );
  }

  return new LocalFsStorageProvider();
}
