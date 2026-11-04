import { servePdfPortalPage } from './pdf-portal.ts';
import { handleMcqPortalRequest, readPortalBody } from './mcq-portal.ts';
/**
 * Standalone Local PDF Management & Compression Tool for MedAtlas
 *
 * Runs ONLY locally (not exposed on public site, not deployed to Vercel).
 * Connects directly to your database and provides a dedicated UI to view all lectures
 * and upload/replace PDFs with ILovePDF compression enabled by default.
 */

import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import 'dotenv/config';
import { db } from '../src/db/index.ts';
import { lectures, subjects, modules, lectureFiles } from '../src/db/schema.ts';
import { eq, desc, asc } from 'drizzle-orm';
import { uploadPdfToTelegram, isTelegramConfigured } from '../src/lib/telegram-storage.ts';
import { isPdfPortalOriginAllowed } from '../src/lib/pdf-portal-access.ts';
import { protectDocumentFields, protectDocumentReference } from '../src/lib/protected-document-reference.ts';

const PORT = 4050;

function getLocalNetworkIp(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        if (!iface.address.startsWith('169.254.')) {
          return iface.address;
        }
      }
    }
  }
  return 'localhost';
}

// ============================================================================
// 1. ILovePDF Compression Engine
// ============================================================================
interface CompressionResult {
  compressedBuffer: Buffer;
  originalSize: number;
  compressedSize: number;
  savingsPercent: number;
  durationMs: number;
  usedCompression: boolean;
  remainingCredits?: number | null;
  remainingFiles?: number | null;
  notes?: string;
}

async function compressWithILovePdf(
  fileBuffer: Buffer,
  fileName: string,
  options: {
    publicKey: string;
    compressionLevel: 'low' | 'recommended' | 'extreme';
  }
): Promise<CompressionResult> {
  const startTime = Date.now();
  const originalSize = fileBuffer.length;

  if (!options.publicKey || !options.publicKey.trim()) {
    return {
      compressedBuffer: fileBuffer,
      originalSize,
      compressedSize: originalSize,
      savingsPercent: 0,
      durationMs: 0,
      usedCompression: false,
      notes: 'No ILovePDF Public Key provided. Stored original uncompressed PDF.',
    };
  }

  try {
    // Step 1: Authenticate with ILovePDF API
    const authRes = await fetch('https://api.ilovepdf.com/v1/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_key: options.publicKey.trim() }),
    });

    if (!authRes.ok) {
      const errText = await authRes.text();
      throw new Error(`ILovePDF Auth Failed (${authRes.status}): ${errText}`);
    }

    const authData = (await authRes.json()) as { token: string };
    const token = authData.token;

    // Step 2: Start compress task
    const startRes = await fetch('https://api.ilovepdf.com/v1/start/compress', {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!startRes.ok) {
      const errText = await startRes.text();
      throw new Error(`ILovePDF Start Task Failed (${startRes.status}): ${errText}`);
    }

    const taskData = (await startRes.json()) as { server: string; task: string };
    const server = taskData.server;
    const task = taskData.task;

    // Step 3: Upload file to ILovePDF task server
    const formData = new FormData();
    formData.append('task', task);
    const blob = new Blob([new Uint8Array(fileBuffer)], { type: 'application/pdf' });
    formData.append('file', blob, fileName);

    const uploadRes = await fetch(`https://${server}/v1/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error(`ILovePDF File Upload Failed (${uploadRes.status}): ${errText}`);
    }

    const uploadData = (await uploadRes.json()) as { server_filename: string };

    // Step 4: Process task with requested compression level
    const processRes = await fetch(`https://${server}/v1/process`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        task,
        tool: 'compress',
        compression_level: options.compressionLevel || 'recommended',
        files: [
          {
            server_filename: uploadData.server_filename,
            filename: fileName,
          },
        ],
      }),
    });

    if (!processRes.ok) {
      const errText = await processRes.text();
      throw new Error(`ILovePDF Processing Failed (${processRes.status}): ${errText}`);
    }

    // Step 5: Download compressed PDF
    const downloadRes = await fetch(`https://${server}/v1/download/${task}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!downloadRes.ok) {
      const errText = await downloadRes.text();
      throw new Error(`ILovePDF Download Failed (${downloadRes.status}): ${errText}`);
    }

    const arrayBuf = await downloadRes.arrayBuffer();
    const compressedBuffer = Buffer.from(arrayBuf);
    const compressedSize = compressedBuffer.length;
    const savingsPercent = Math.round(((originalSize - compressedSize) / originalSize) * 100);
    const durationMs = Date.now() - startTime;

    // Check remaining credits after compression
    let remainingCredits: number | null = null;
    let remainingFiles: number | null = null;
    try {
      const infoRes = await fetch('https://api.ilovepdf.com/v1/info', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (infoRes.ok) {
        const infoData = (await infoRes.json()) as { remaining_credits?: number };
        if (typeof infoData.remaining_credits === 'number') {
          remainingCredits = infoData.remaining_credits;
          remainingFiles = Math.floor(remainingCredits / 10);
        }
      }
    } catch {
      // ignore info query error
    }

    return {
      compressedBuffer,
      originalSize,
      compressedSize,
      savingsPercent: Math.max(0, savingsPercent),
      durationMs,
      usedCompression: true,
      remainingCredits,
      remainingFiles,
      notes: `Compressed via ILovePDF (${options.compressionLevel}) in ${(durationMs / 1000).toFixed(1)}s`,
    };
  } catch (error: any) {
    console.warn('[ILovePDF Warning]', error.message);
    return {
      compressedBuffer: fileBuffer,
      originalSize,
      compressedSize: originalSize,
      savingsPercent: 0,
      durationMs: Date.now() - startTime,
      usedCompression: false,
      notes: `Compression skipped due to API error: ${error.message}. Original PDF saved intact.`,
    };
  }
}

// ============================================================================
// 2. Storage & Database Operations
// ============================================================================
async function saveAndAttachPdf(
  lectureId: number,
  fileBuffer: Buffer,
  originalFileName: string
) {
  if (!isTelegramConfigured()) throw new Error('Telegram PDF storage is required.');
  const [existing] = await db.select({ id: lectures.id }).from(lectures).where(eq(lectures.id, lectureId)).limit(1);
  if (!existing) throw new Error('Lecture not found.');
  const safeBase = path.basename(originalFileName).replace(/\.pdf$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'lecture';
  const uniqueFileName = `${Date.now()}-${safeBase}.pdf`;
  const relativeUrl = `/lectures/${uniqueFileName}`;
  // Upload first: a Telegram failure leaves the existing attachment untouched.
  const uploaded = await uploadPdfToTelegram(uniqueFileName, fileBuffer, `MedAtlas Lecture PDF - Lecture ${lectureId}`);
  const telegramFileId = uploaded.fileId;
  const updatedLecture = await db.transaction(async (tx) => {
    await tx.insert(lectureFiles).values({ fileName: uniqueFileName, mimeType: 'application/pdf',
      fileSize: fileBuffer.length, dataBase64: '', url: relativeUrl, telegramFileId });
    const [updated] = await tx.update(lectures).set({ pdfUrl: relativeUrl, updatedAt: new Date() })
      .where(eq(lectures.id, lectureId)).returning();
    return updated;
  });

  return {
    lecture: protectDocumentFields(updatedLecture),
    url: protectDocumentReference(relativeUrl),
    fileName: uniqueFileName,
    fileSize: fileBuffer.length,
  };
}

// ============================================================================
// 3. Local Web Server & HTML Interface
// ============================================================================
// ============================================================================
// 4. HTTP Request Handler
// ============================================================================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (url.pathname !== '/api/health') {
    if (!isPdfPortalOriginAllowed(req.headers.origin, req.headers.host) ||
        (url.pathname.startsWith('/api/') && req.headers['sec-fetch-site'] === 'cross-site')) {
      res.writeHead(403); res.end('Cross-site access denied.'); return;
    }
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (await handleMcqPortalRequest(req, res, url)) return;

  if (await servePdfPortalPage(req, res, url)) return;

  // 1.5. Health Check Endpoint
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'medatlas-upload-portal', time: Date.now() }));
    return;
  }

  // Original documents must never be served by the tunnel, even to the portal owner.
  if (url.pathname.startsWith('/lectures/')) {
    res.writeHead(410); res.end('Direct PDF delivery is disabled. View lectures in MedAtlas.'); return;
  }

  // 3. API: List all available lectures
  if (url.pathname === '/api/lectures' && req.method === 'GET') {
    try {
      const allSubjects = await db.select().from(subjects);
      const allModules = await db.select().from(modules);
      const allLectures = await db
        .select()
        .from(lectures)
        .orderBy(asc(lectures.subjectId), asc(lectures.lectureNumber));

      const subjMap = new Map(allSubjects.map((s) => [s.id, s]));
      const modMap = new Map(allModules.map((m) => [m.id, m]));

      const enriched = allLectures.map((l) => {
        const subj = subjMap.get(l.subjectId);
        const mod = subj?.moduleId ? modMap.get(subj.moduleId) : null;
        return {
          id: l.id,
          title: l.title,
          description: l.description,
          lectureNumber: l.lectureNumber,
          contentType:l.contentType,
          pdfUrl: l.pdfUrl ? protectDocumentReference(l.pdfUrl) : null,
          subjectId: l.subjectId,
          subjectTitle: subj?.title || 'Unknown Subject',
          moduleCode: mod?.code || null,
        };
      });

      const localIp = getLocalNetworkIp();
      const address = server.address();
      const networkAvailable = address && typeof address === 'object' && ['0.0.0.0','::'].includes(address.address);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          lectures: enriched,
          compressionConfigured: Boolean(process.env.ILOVEPDF_PUBLIC_KEY?.trim()),
          tabletUrl: networkAvailable ? `http://${localIp}:${PORT}` : null,
        })
      );
      return;
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'The lecture library could not load. Please refresh and retry.' }));
      return;
    }
  }

  // 3.5. API: Verify ILovePDF Public Key
  if (url.pathname === '/api/test-ilovepdf' && req.method === 'POST') {
    try {
      await readPortalBody(req, 16 * 1024);
      const keyToTest = (process.env.ILOVEPDF_PUBLIC_KEY || '').trim();

      if (!keyToTest) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'No Public Key provided.' }));
        return;
      }

      const authRes = await fetch('https://api.ilovepdf.com/v1/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_key: keyToTest }),
      });

      if (!authRes.ok) {
        const errText = await authRes.text();
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: `ILovePDF Auth Failed (${authRes.status}): ${errText}` }));
        return;
      }

      const authData = (await authRes.json()) as { token: string };
      let remainingCredits: number | null = null;
      let remainingFiles: number | null = null;

      try {
        const infoRes = await fetch('https://api.ilovepdf.com/v1/info', {
          headers: { Authorization: `Bearer ${authData.token}` },
        });
        if (infoRes.ok) {
          const infoData = (await infoRes.json()) as { remaining_credits?: number };
          if (typeof infoData.remaining_credits === 'number') {
            remainingCredits = infoData.remaining_credits;
            remainingFiles = Math.floor(remainingCredits / 10);
          }
        }
      } catch {
        // ignore info error
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          message: 'ILovePDF Public Key is active and verified!',
          remainingCredits,
          remainingFiles,
          totalMonthlyFiles: 250,
        })
      );
      return;
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
      return;
    }
  }

  // 4. API: Upload & Compress PDF for a specific lecture
  if (url.pathname === '/api/upload' && req.method === 'POST') {
    try {
      // Parse multipart form data
      const rawBody = await readPortalBody(req, 101 * 1024 * 1024);
      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
      const boundary = boundaryMatch ? boundaryMatch[1] || boundaryMatch[2] : null;

      if (!boundary) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid multipart form request.' }));
        return;
      }

      const parsed = parseMultipart(rawBody, boundary);
      const lectureId = Number(parsed.fields['lectureId']);
      const compressEnabled = parsed.fields['compress'] !== 'false';
      const requestedLevel = parsed.fields['compressionLevel'];
      const compressionLevel = (['low','recommended','extreme'].includes(requestedLevel) ? requestedLevel : 'recommended') as 'low'|'recommended'|'extreme';
      const publicKey = process.env.ILOVEPDF_PUBLIC_KEY || '';

      const uploadedFile = parsed.files['file'];
      if (!uploadedFile || !uploadedFile.data || uploadedFile.data.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No PDF file was uploaded.' }));
        return;
      }

      if (!Number.isInteger(lectureId) || lectureId <= 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Valid lectureId is required.' }));
        return;
      }

      if (uploadedFile.data.subarray(0, 5).toString() !== '%PDF-') {
        res.writeHead(400, {'Content-Type':'application/json'});res.end(JSON.stringify({error:'Choose a valid PDF document.'}));return;
      }
      if (uploadedFile.data.length > 100 * 1024 * 1024) {
        res.writeHead(413, {'Content-Type':'application/json'});res.end(JSON.stringify({error:'The source PDF must be no larger than 100 MB.'}));return;
      }
      const [destination] = await db.select({id:lectures.id}).from(lectures).where(eq(lectures.id,lectureId)).limit(1);
      if (!destination) {res.writeHead(404, {'Content-Type':'application/json'});res.end(JSON.stringify({error:'This lecture no longer exists. Refresh the library.'}));return;}

      console.log(
        `[Local PDF Tool] Received "${uploadedFile.filename}" (${(uploadedFile.data.length / (1024 * 1024)).toFixed(2)} MB) for Lecture #${lectureId}`
      );

      // Execute compression if enabled
      let finalBuffer = uploadedFile.data;
      let compressionMeta: CompressionResult | null = null;

      if (compressEnabled && publicKey) {
        console.log(`[Local PDF Tool] Compressing via ILovePDF (${compressionLevel})...`);
        compressionMeta = await compressWithILovePdf(
          uploadedFile.data,
          uploadedFile.filename,
          {
            publicKey,
            compressionLevel,
          }
        );
        finalBuffer = compressionMeta.compressedBuffer;
      }

      if (finalBuffer.length > 50 * 1024 * 1024) {
        res.writeHead(413, {'Content-Type':'application/json'});res.end(JSON.stringify({error:'The PDF exceeds Telegram’s 50 MB file limit after compression. Try stronger compression or split the file.'}));return;
      }
      // Upload PDF contents to Telegram and attach metadata in PostgreSQL.
      const result = await saveAndAttachPdf(lectureId, finalBuffer, uploadedFile.filename);

      console.log(`[Local PDF Tool] ✅ Attached to Lecture #${lectureId} -> ${result.url}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          lecture: result.lecture,
          url: result.url,
          fileName: result.fileName,
          fileSize: result.fileSize,
          compression: compressionMeta ? {...compressionMeta, compressedBuffer:undefined} : null,
        })
      );
      return;
    } catch (err: any) {
      console.error('[Local PDF Tool Error]', err);
      res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.statusCode ? err.message : 'The PDF could not be stored. Please retry or check the Telegram connection.' }));
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// Helper for parsing multipart/form-data
function parseMultipart(
  body: Buffer,
  boundary: string
): { fields: Record<string, string>; files: Record<string, { filename: string; data: Buffer }> } {
  const fields: Record<string, string> = {};
  const files: Record<string, { filename: string; data: Buffer }> = {};

  const boundaryBuffer = Buffer.from(`--${boundary}`);
  let startIndex = 0;

  while (startIndex < body.length) {
    const nextBoundary = body.indexOf(boundaryBuffer, startIndex);
    if (nextBoundary === -1) break;

    const partStart = nextBoundary + boundaryBuffer.length;
    const nextPartEnd = body.indexOf(boundaryBuffer, partStart);
    const partBuffer = nextPartEnd === -1 ? body.slice(partStart) : body.slice(partStart, nextPartEnd);

    startIndex = nextPartEnd === -1 ? body.length : nextPartEnd;

    // Find headers and body within part
    const headerEndIndex = partBuffer.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEndIndex === -1) continue;

    const headersStr = partBuffer.slice(0, headerEndIndex).toString('utf-8');
    const content = partBuffer.slice(headerEndIndex + 4, partBuffer.length - 2); // strip trailing \r\n

    const nameMatch = headersStr.match(/name="([^"]+)"/);
    if (!nameMatch) continue;
    const fieldName = nameMatch[1];

    const filenameMatch = headersStr.match(/filename="([^"]+)"/);
    if (filenameMatch) {
      files[fieldName] = {
        filename: filenameMatch[1],
        data: content,
      };
    } else {
      fields[fieldName] = content.toString('utf-8');
    }
  }

  return { fields, files };
}

// Start server on 0.0.0.0 (enables access from PC, tablet, or phone on local Wi-Fi)
export { server, PORT };

export function startPdfServer(openBrowser = true): Promise<http.Server> {
  return new Promise((resolve) => {
    if (server.listening) {
      resolve(server);
      return;
    }

    const localIp = getLocalNetworkIp();
    server.listen(PORT, '0.0.0.0', () => {
      const localUrl = `http://localhost:${PORT}`;
      const tabletUrl = `http://${localIp}:${PORT}`;
      console.log(`\n======================================================`);
      console.log(`  MedAtlas Local PDF Manager & Compression Tool`);
      console.log(`  💻 PC Browser:     ${localUrl}`);
      console.log(`  📱 Tablet Browser: ${tabletUrl}`);
      console.log(`  (Make sure your tablet is connected to the same Wi-Fi)`);
      console.log(`======================================================\n`);

      if (openBrowser && process.platform === 'win32') {
        exec(`start ${localUrl}`);
      }
      resolve(server);
    });
  });
}

// Auto-start if run directly from CLI
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('local-pdf-tool.ts') ||
  process.argv[1].endsWith('local-pdf-tool.js')
);

if (isDirectRun) {
  startPdfServer(true);
}
