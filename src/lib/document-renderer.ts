import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const assetsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
const MAX_BYTES = 50 * 1024 * 1024;
const TTL = 5 * 60_000;
const sourceCache = new Map<string, { buffer: Buffer; expires: number }>();
let sourceBytes = 0;
const loads = new Map<string, Promise<Buffer>>();

export class DocumentViewError extends Error {
  constructor(message: string, public status = 503, public totalPages?: number) { super(message); }
}

type RenderedDocument = { totalPages: number; image?: Buffer };

/** Private process memory only. Access and watermark policy are checked before every lookup. */
export class DocumentPageCache {
  private entries = new Map<string, { value: RenderedDocument; expires: number }>();
  private pending = new Map<string, Promise<RenderedDocument>>();
  private bytes = 0;
  constructor(private maxBytes = 24 * 1024 * 1024, private maxPages = 128,
    private ttlMs = 10 * 60_000, private now = Date.now) {}

  private remove(key: string) {
    const entry = this.entries.get(key);
    if (entry) { this.bytes -= entry.value.image?.length || 0; this.entries.delete(key); }
  }

  getOrRender(key: string, render: () => Promise<RenderedDocument>): Promise<RenderedDocument> {
    const hit = this.entries.get(key);
    if (hit && hit.expires > this.now()) {
      this.entries.delete(key); this.entries.set(key, hit);
      return Promise.resolve(hit.value);
    }
    this.remove(key);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const loading = Promise.resolve().then(render).then(value => {
      const size = value.image?.length || 0;
      if (size > 0 && size <= this.maxBytes && this.maxPages > 0) {
        for (const [id, entry] of this.entries) if (entry.expires <= this.now()) this.remove(id);
        while (this.entries.size && (this.bytes + size > this.maxBytes || this.entries.size >= this.maxPages)) {
          this.remove(this.entries.keys().next().value!);
        }
        this.entries.set(key, { value, expires: this.now() + this.ttlMs }); this.bytes += size;
      }
      return value;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, loading);
    return loading;
  }
}

const pageCache = new DocumentPageCache();
const fingerprints = new WeakMap<Buffer, string>();
const pageCounts = new WeakMap<Buffer, number>();
const metadataLoads = new WeakMap<Buffer, Promise<RenderedDocument>>();
let pdfJs: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | undefined;

export function preloadDocumentRenderer() {
  if (!pdfJs) pdfJs = import('pdfjs-dist/legacy/build/pdf.mjs').catch(error => { pdfJs = undefined; throw error; });
  return pdfJs;
}

/** Telegram file IDs are immutable. A hit need not download or parse the source PDF. */
export function cachedUnwatermarkedDocumentPage(fileId: string, page: number, loadSource: () => Promise<Buffer>) {
  return pageCache.getOrRender(`telegram:${fileId}:${page}`, async () => renderUncachedDocument(await loadSource(), page));
}

export function renderDocument(source: Buffer, pageNumber?: number, viewerUid?: string, watermarksEnabled = false): Promise<RenderedDocument> {
  if (pageNumber === undefined) {
    const totalPages = pageCounts.get(source);
    if (totalPages) return Promise.resolve({ totalPages });
    const pending = metadataLoads.get(source);
    if (pending) return pending;
    const loading = renderUncachedDocument(source).finally(() => metadataLoads.delete(source));
    metadataLoads.set(source, loading);
    return loading;
  }
  if (!Number.isInteger(pageNumber) || pageNumber < 1) return Promise.reject(new DocumentViewError('Page not found.', 404));
  // Account-specific pixels must never use the shared, unwatermarked cache.
  if (watermarksEnabled) return renderUncachedDocument(source, pageNumber, viewerUid, true);
  let fingerprint = fingerprints.get(source);
  if (!fingerprint) { fingerprint = createHash('sha256').update(source).digest('hex'); fingerprints.set(source, fingerprint); }
  return pageCache.getOrRender(`${fingerprint}:${pageNumber}`, () => renderUncachedDocument(source, pageNumber));
}

/** Bounded waits absorb short bursts without increasing rendering concurrency. */
export class BoundedDocumentQueue {
  private active = 0;
  private waiting: Array<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }> = [];
  constructor(private limit = 2, private maxWaiting = 6, private waitMs = 5000) {}

  private acquire(): Promise<void> {
    if (this.active < this.limit) { this.active++; return Promise.resolve(); }
    if (this.waiting.length >= this.maxWaiting) return Promise.reject(new DocumentViewError('The viewer is busy. Please retry in a moment.', 429));
    return new Promise((resolve, reject) => {
      const entry = { resolve, timer: setTimeout(() => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new DocumentViewError('The viewer is busy. Please retry in a moment.', 429));
      }, this.waitMs) };
      this.waiting.push(entry);
    });
  }
  async run<T>(action: () => Promise<T>): Promise<T> {
    await this.acquire();
    try { return await action(); }
    finally {
      const next = this.waiting.shift();
      if (next) { clearTimeout(next.timer); next.resolve(); }
      else this.active--;
    }
  }
}
const sourceQueue = new BoundedDocumentQueue();
const renderQueue = new BoundedDocumentQueue();

export async function cachedDocumentSource(key: string, loader: () => Promise<Buffer>): Promise<Buffer> {
  const hit = sourceCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.buffer;
  if (loads.has(key)) return loads.get(key)!;
  const loading = sourceQueue.run(loader).then((buffer) => {
    if (buffer.length > MAX_BYTES || !buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
      throw new DocumentViewError('The document could not be opened.');
    }
    const previous = sourceCache.get(key);
    if (previous) { sourceBytes -= previous.buffer.length; sourceCache.delete(key); }
    while (sourceBytes + buffer.length > MAX_BYTES && sourceCache.size) {
      const oldestKey = sourceCache.keys().next().value!;
      sourceBytes -= sourceCache.get(oldestKey)!.buffer.length;
      sourceCache.delete(oldestKey);
    }
    sourceCache.set(key, { buffer, expires: Date.now() + TTL });
    sourceBytes += buffer.length;
    return buffer;
  }).finally(() => loads.delete(key));
  loads.set(key, loading);
  return loading;
}

// PDF bytes and PDF.js execute only on the server. There is no raw-file response.
async function renderUncachedDocument(source: Buffer, pageNumber?: number, viewerUid?: string, watermarksEnabled = false): Promise<RenderedDocument> {
  return renderQueue.run(async () => {
  let task: any;
  try {
    const { getDocument } = await preloadDocumentRenderer();
    task = getDocument({ data: new Uint8Array(source),
      cMapUrl: path.join(assetsRoot, 'cmaps').replaceAll('\\', '/') + '/', cMapPacked: true,
      standardFontDataUrl: path.join(assetsRoot, 'standard_fonts').replaceAll('\\', '/') + '/',
      wasmUrl: path.join(assetsRoot, 'wasm').replaceAll('\\', '/') + '/',
      useSystemFonts: false, enableXfa: false, maxImageSize: 24_000_000,
    });
    const doc = await task.promise;
    pageCounts.set(source, doc.numPages);
    if (!pageNumber) return { totalPages: doc.numPages };
    if (pageNumber < 1 || pageNumber > doc.numPages) throw new DocumentViewError('Page not found.', 404, doc.numPages);
    const page = await doc.getPage(pageNumber);
    const unit = page.getViewport({ scale: 1 });
    const scale = Math.min(1600 / unit.width, 2200 / unit.height, 3);
    const viewport = page.getViewport({ scale });
    const pair = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    try {
      await page.render({ canvasContext: pair.context, viewport, background: '#ffffff' }).promise;
      const ctx = pair.context;
      const { width, height } = pair.canvas;
      if (watermarksEnabled) {
        const viewer = createHash('sha256').update(`medatlas-viewer:${viewerUid}`).digest('hex').slice(0, 12).toUpperCase();
        const label = `MEDATLAS  /  ${viewer}  /  PERSONAL STUDY`;
        // Repeated, baked-in account watermark cannot be removed by editing the DOM.
        ctx.save();
        ctx.fillStyle = 'rgba(25, 44, 50, 0.14)';
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)'; ctx.lineWidth = 1.5;
        ctx.font = `${Math.max(13, Math.round(width / 64))}px sans-serif`;
        ctx.textAlign = 'center';
        for (let y = 90; y < height; y += 210) {
          for (let x = width / 4; x < width + width / 4; x += width / 2) {
            ctx.save(); ctx.translate(x, y); ctx.rotate(-Math.PI / 8);
            ctx.strokeText(label, 0, 0, width * .65); ctx.fillText(label, 0, 0, width * .65); ctx.restore();
          }
        }
        ctx.restore();
        ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillRect(0, height - 32, width, 32);
        ctx.fillStyle = '#4d636a'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(`MedAtlas | Viewer ${viewer} | Page ${pageNumber} of ${doc.numPages}`, width / 2, height - 11);
        }
      const image: Buffer = await pair.canvas.encode('webp', 88);
      return { totalPages: doc.numPages, image };
    } finally { doc.canvasFactory.destroy(pair); page.cleanup(); }
  } finally {
    await task?.destroy();
  }
  });
}
