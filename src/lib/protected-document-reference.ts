import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const PREFIX = '/api/documents/';
const SOURCE_PATH = /^\/lectures\/[A-Za-z0-9_.-]+\.pdf$/i;
function documentKey() {
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('Document protection requires the session secret.');
  return createHash('sha256').update(`medatlas-document-reference-v1:${secret}`).digest();
}

// Opaque references hide source names; they never replace authentication/authorization.
export function protectDocumentReference(source: string): string {
  if (!SOURCE_PATH.test(source)) throw new Error('Only Telegram-backed lecture documents are supported.');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', documentKey(), iv);
  const encrypted = Buffer.concat([cipher.update(source, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

export function resolveDocumentReference(reference: string): string {
  const token = reference.startsWith(PREFIX) ? reference.slice(PREFIX.length) : reference;
  if (!/^[A-Za-z0-9_-]{40,1600}$/.test(token)) throw new Error('Invalid document reference.');
  const payload = Buffer.from(token, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', documentKey(), payload.subarray(0, 12));
  decipher.setAuthTag(payload.subarray(12, 28));
  const source = Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8');
  if (!SOURCE_PATH.test(source)) throw new Error('Invalid document reference.');
  return source;
}

export function documentReferenceForStorage(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error('Invalid document reference.');
  const trimmed = value.trim();
  if (trimmed.startsWith(PREFIX)) return resolveDocumentReference(trimmed);
  if (SOURCE_PATH.test(trimmed)) return trimmed;
  throw new Error('Upload this PDF to Telegram before attaching it. External PDF links are not supported.');
}

export function protectDocumentFields(value: any, key = '', references = new Map<string, string>()): any {
  if (typeof value === 'string') {
    if (SOURCE_PATH.test(value)) {
      if (!references.has(value)) references.set(value, protectDocumentReference(value));
      return references.get(value);
    }
    if (key === 'pdfUrl' || key === 'lecturePdfUrl') {
      return value.startsWith(PREFIX) ? value : null;
    }
    if (/Json$/.test(key)) {
      try { return JSON.stringify(protectDocumentFields(JSON.parse(value), '', references)); } catch { return value; }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => protectDocumentFields(item, '', references));
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.entries(value)
      .filter(([name]) => name !== 'telegramFileId' && name !== 'dataBase64')
      .map(([name, item]) => [name, protectDocumentFields(item, name, references)]));
  }
  return value;
}
