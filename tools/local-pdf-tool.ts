/**
 * Standalone Local PDF Management & Compression Tool for MedAtlas
 *
 * Runs ONLY locally (not exposed on public site, not deployed to Vercel).
 * Connects directly to your database and provides a dedicated UI to view all lectures
 * and upload/replace PDFs with ILovePDF compression enabled by default.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { exec } from 'node:child_process';
import 'dotenv/config';
import { db } from '../src/db/index.ts';
import { lectures, subjects, modules, lectureFiles } from '../src/db/schema.ts';
import { eq, desc, asc } from 'drizzle-orm';
import { uploadPdfToTelegram, isTelegramConfigured } from '../src/lib/telegram-storage.ts';

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
    lecture: updatedLecture,
    url: relativeUrl,
    telegramFileId,
    fileName: uniqueFileName,
    fileSize: fileBuffer.length,
  };
}

// ============================================================================
// 3. Local Web Server & HTML Interface
// ============================================================================
const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MedAtlas - Local PDF Manager</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .drop-active { border-color: #0284c7 !important; background-color: #f0f9ff !important; }
  </style>
</head>
<body class="bg-slate-50 text-slate-800 min-h-screen">
  <div class="max-w-6xl mx-auto px-4 py-8 space-y-6">

    <!-- Header -->
    <header class="bg-white rounded-2xl border border-slate-200 p-6 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
      <div>
        <div class="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-full text-xs font-bold bg-sky-50 text-sky-800 border border-sky-200 mb-1.5">
          <span>⚡ Local Standalone Tool</span>
          <span>·</span>
          <span>Zero Payload Limits</span>
        </div>
        <h1 class="text-2xl font-black text-slate-900 tracking-tight">
          MedAtlas Local PDF Manager
        </h1>
        <p class="text-xs text-slate-500 mt-0.5">
          Upload and attach slide decks directly to specific lectures. Supports ILovePDF cloud compression.
        </p>
      </div>

      <div class="flex flex-col sm:flex-row sm:items-center gap-3">
        <!-- Tablet access pill -->
        <div class="flex items-center gap-2 p-2 px-3 bg-sky-50 border border-sky-200 rounded-xl text-xs text-sky-950">
          <span class="text-base shrink-0">📱</span>
          <div class="min-w-0">
            <span class="font-bold text-[11px] block text-sky-900">Tablet Wi-Fi Link:</span>
            <code id="tabletUrlDisplay" class="font-mono text-xs font-bold text-[#0284c7] truncate block">http://192.168.1.222:4050</code>
          </div>
          <button onclick="copyTabletUrl()" id="copyBtn" class="px-2 py-1 text-[11px] font-semibold text-slate-700 bg-white border border-sky-200 hover:bg-sky-100 rounded-lg cursor-pointer ml-1">
            Copy
          </button>
          <button onclick="toggleQrModal()" class="px-2 py-1 text-[11px] font-semibold text-white bg-[#0284c7] hover:bg-[#0369a1] rounded-lg cursor-pointer">
            QR Code
          </button>
        </div>

        <button onclick="loadLectures()" class="px-3.5 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors cursor-pointer shrink-0">
          ↻ Refresh
        </button>
      </div>
    </header>

    <!-- QR Code Modal for Tablet -->
    <div id="qrModal" class="hidden fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4">
      <div class="bg-white rounded-2xl max-w-sm w-full p-6 text-center space-y-4 shadow-2xl border border-slate-200 animate-in fade-in">
        <div class="flex items-center justify-between border-b border-slate-100 pb-2">
          <h3 class="font-bold text-sm text-slate-900">Scan on your Tablet</h3>
          <button onclick="toggleQrModal()" class="text-slate-400 hover:text-slate-600 font-bold p-1">&times;</button>
        </div>
        <p class="text-xs text-slate-500">
          Point your iPad or Android tablet camera at this QR code to open the PDF manager on your tablet:
        </p>
        <div class="p-3 bg-white border border-slate-200 rounded-xl inline-block mx-auto shadow-xs">
          <img id="qrCodeImg" src="" alt="Tablet QR Code" class="w-48 h-48 mx-auto" />
        </div>
        <p id="qrUrlText" class="text-xs font-mono font-bold text-[#0284c7] break-all"></p>
        <p class="text-[11px] text-slate-400">
          Make sure your tablet is connected to the same Wi-Fi network as your PC.
        </p>
        <button onclick="toggleQrModal()" class="w-full py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl">
          Close
        </button>
      </div>
    </div>

    <!-- Settings Card: ILovePDF Compression Options -->
    <section class="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs space-y-4">
      <div class="flex items-center justify-between border-b border-slate-100 pb-3">
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 rounded-lg bg-red-50 text-red-600 flex items-center justify-center font-bold text-xs">
            PDF
          </div>
          <div>
            <h2 class="text-sm font-bold text-slate-900">ILovePDF Compression Engine</h2>
            <p class="text-[11px] text-slate-500">Reduce slide deck file size before uploading to database & storage</p>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <label class="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" id="compressToggle" checked class="sr-only peer" onchange="toggleCompress()">
            <div class="w-11 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[#0284c7]"></div>
            <span class="ml-2.5 text-xs font-bold text-slate-800" id="toggleLabel">Compression Active</span>
          </label>
        </div>
      </div>

      <div id="compressionSettings" class="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
        <div>
          <label class="block font-semibold text-slate-700 mb-1">Compression Shape / Level</label>
          <select id="compressionLevel" onchange="saveSettings()" class="w-full px-3 py-2 text-xs rounded-xl border border-slate-300 bg-white focus:ring-2 focus:ring-[#0284c7]">
            <option value="recommended" selected>Recommended (Balanced speed, high quality - Default)</option>
            <option value="extreme">Extreme (Maximum compression, smallest file size)</option>
            <option value="low">Low (Mild compression, highest resolution)</option>
          </select>
          <p class="text-[10px] text-slate-400 mt-1">Recommended preserves crystal clear text while cutting file size by 50-80%.</p>
        </div>

        <div class="sm:col-span-2">
          <div class="flex items-center justify-between mb-1">
            <label class="block font-semibold text-slate-700">
              ILovePDF Public Key
              <a href="https://developer.ilovepdf.com" target="_blank" class="text-[#0284c7] font-normal hover:underline ml-1">
                (Get free API key at developer.ilovepdf.com &nearr;)
              </a>
            </label>
            <button type="button" onclick="verifyApiKey()" class="px-2.5 py-1 text-[11px] font-bold text-sky-700 bg-sky-50 hover:bg-sky-100 border border-sky-200 rounded-lg transition-colors cursor-pointer">
              🔍 Verify Key
            </button>
          </div>
          <input type="text" id="ilovepdfKey" placeholder="project_public_xxxxxxxxxxxxxxxx..." onchange="saveSettings(); verifyApiKey();" class="w-full px-3 py-2 text-xs font-mono rounded-xl border border-slate-300 bg-white focus:ring-2 focus:ring-[#0284c7]">
          <div id="apiKeyStatus" class="text-[11px] font-semibold mt-1.5 hidden"></div>
          <p class="text-[10px] text-slate-400 mt-1">Pre-loaded from .env. Free tier provides 250 files/month.</p>
        </div>
      </div>

      <!-- Real-Time Free Compression Tracker (250 Files/Month) -->
      <div class="mt-2 pt-3 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
        <div class="flex items-center gap-2.5">
          <div class="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></div>
          <div>
            <div class="flex items-center gap-2">
              <span class="font-bold text-slate-800">Monthly Free Compressions Left:</span>
              <span id="creditBadge" class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-sky-100 text-sky-800 border border-sky-300">
                Checking balance...
              </span>
            </div>
            <p id="creditSubtext" class="text-[10px] text-slate-400 mt-0.5">Free allowance: 250 files / month (2,500 API credits)</p>
          </div>
        </div>

        <div class="flex items-center gap-2.5 w-full sm:w-60">
          <div class="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden border border-slate-200">
            <div id="creditProgressBar" class="bg-gradient-to-r from-emerald-500 to-teal-500 h-2.5 rounded-full transition-all duration-500" style="width: 100%;"></div>
          </div>
          <span id="creditPercentText" class="text-[11px] font-mono font-bold text-slate-700 shrink-0">100%</span>
        </div>
      </div>
    </section>

    <!-- Floating Global Toast Notifications Container -->
    <div id="toastContainer" class="fixed bottom-6 right-6 z-50 flex flex-col gap-2 max-w-md w-full pointer-events-none px-4"></div>

    <!-- Lectures List & Search -->
    <section class="space-y-4">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <input type="text" id="searchInput" oninput="filterLectures()" placeholder="Search lectures by title, subject, or number..." class="px-3.5 py-2 text-xs rounded-xl border border-slate-300 bg-white w-72 focus:ring-2 focus:ring-[#0284c7]">
          <select id="statusFilter" onchange="filterLectures()" class="px-3 py-2 text-xs rounded-xl border border-slate-300 bg-white">
            <option value="all">All Lectures</option>
            <option value="missing">Missing PDF Only</option>
            <option value="has_pdf">Has PDF Attached</option>
          </select>
        </div>
        <div id="metricsBar" class="text-xs text-slate-500 font-mono">
          Loading lectures...
        </div>
      </div>

      <!-- Lectures Grid -->
      <div id="lecturesContainer" class="grid grid-cols-1 gap-3">
        <div class="p-8 text-center text-xs text-slate-400 bg-white rounded-2xl border border-slate-200">
          Loading available lectures from database...
        </div>
      </div>
    </section>
  </div>

  <script>
    let allLectures = [];
    let currentTabletUrl = '';

    // Floating Toast Notification System
    function showToast(title, message, type = 'info', durationMs = 6000) {
      const container = document.getElementById('toastContainer');
      if (!container) return;

      const toast = document.createElement('div');
      toast.className = 'pointer-events-auto transform transition-all duration-300 ease-out translate-y-2 opacity-0 p-4 rounded-2xl shadow-xl border flex items-start gap-3 text-xs';

      if (type === 'success') {
        toast.className += ' bg-emerald-950 text-emerald-100 border-emerald-700/60 shadow-emerald-950/20';
      } else if (type === 'warning') {
        toast.className += ' bg-amber-950 text-amber-100 border-amber-700/60 shadow-amber-950/20';
      } else if (type === 'error') {
        toast.className += ' bg-rose-950 text-rose-100 border-rose-700/60 shadow-rose-950/20';
      } else {
        toast.className += ' bg-slate-900 text-slate-100 border-slate-700 shadow-slate-950/30';
      }

      let icon = '⚡';
      if (type === 'success') icon = '🎉';
      else if (type === 'warning') icon = '⚠️';
      else if (type === 'error') icon = '❌';

      toast.innerHTML =
        '<div class="mt-0.5 text-base shrink-0">' + icon + '</div>' +
        '<div class="space-y-0.5 min-w-0 flex-1">' +
        '<p class="font-bold text-[13px] leading-tight">' + title + '</p>' +
        '<p class="opacity-90 leading-relaxed">' + message + '</p>' +
        '</div>' +
        '<button onclick="this.parentElement.remove()" class="text-white/60 hover:text-white shrink-0 font-bold ml-1 text-sm">&times;</button>';

      container.appendChild(toast);
      requestAnimationFrame(() => {
        toast.classList.remove('translate-y-2', 'opacity-0');
      });

      if (durationMs > 0) {
        setTimeout(() => {
          toast.classList.add('opacity-0', 'translate-y-2');
          setTimeout(() => toast.remove(), 300);
        }, durationMs);
      }
      return toast;
    }

    function updateCreditTracker(remainingFiles, remainingCredits, totalFiles = 250) {
      const badge = document.getElementById('creditBadge');
      const bar = document.getElementById('creditProgressBar');
      const pctText = document.getElementById('creditPercentText');
      const subtext = document.getElementById('creditSubtext');

      if (!badge || !bar || !pctText) return;

      if (remainingFiles === null || remainingFiles === undefined) {
        badge.textContent = 'API not connected';
        badge.className = 'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-slate-100 text-slate-600 border border-slate-200';
        bar.style.width = '0%';
        pctText.textContent = '0%';
        return;
      }

      const safeTotal = totalFiles || 250;
      const pct = Math.min(100, Math.max(0, Math.round((remainingFiles / safeTotal) * 100)));
      badge.textContent = remainingFiles + ' / ' + safeTotal + ' files left';
      pctText.textContent = pct + '%';
      bar.style.width = pct + '%';

      if (pct > 50) {
        badge.className = 'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300';
        bar.className = 'bg-gradient-to-r from-emerald-500 to-teal-500 h-2.5 rounded-full transition-all duration-500';
      } else if (pct > 20) {
        badge.className = 'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-300';
        bar.className = 'bg-gradient-to-r from-amber-500 to-yellow-500 h-2.5 rounded-full transition-all duration-500';
      } else {
        badge.className = 'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-rose-100 text-rose-800 border border-rose-300';
        bar.className = 'bg-rose-500 h-2.5 rounded-full transition-all duration-500';
      }

      if (subtext) {
        subtext.textContent = (remainingCredits !== undefined && remainingCredits !== null)
          ? remainingCredits.toLocaleString() + ' API credits remaining (resets automatically every month)'
          : 'Free allowance: ' + safeTotal + ' files / month';
      }
    }

    async function verifyApiKey() {
      const statusEl = document.getElementById('apiKeyStatus');
      const key = (document.getElementById('ilovepdfKey').value || '').trim();

      if (!key) {
        statusEl.className = 'text-[11px] font-semibold mt-1.5 text-amber-600 block';
        statusEl.textContent = 'ℹ️ No key entered yet. Original PDFs will be uploaded uncompressed.';
        updateCreditTracker(null, null);
        return;
      }

      statusEl.className = 'text-[11px] font-semibold mt-1.5 text-sky-600 block animate-pulse';
      statusEl.textContent = '⏳ Testing connection to ILovePDF API...';

      try {
        const res = await fetch('/api/test-ilovepdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ publicKey: key }),
        });
        const data = await res.json();

        if (res.ok && data.success) {
          statusEl.className = 'text-[11px] font-bold mt-1.5 text-emerald-600 block';
          statusEl.textContent = '✅ Connected! ILovePDF API key is valid and active.';
          if (data.remainingFiles !== undefined) {
            updateCreditTracker(data.remainingFiles, data.remainingCredits, data.totalMonthlyFiles);
          }
          showToast('ILovePDF Connected', 'Your API Public Key is verified. ' + (data.remainingFiles ?? 250) + ' free compressions left this month.', 'success', 4000);
        } else {
          statusEl.className = 'text-[11px] font-bold mt-1.5 text-red-600 block';
          statusEl.textContent = '❌ Key verification failed: ' + (data.error || 'Invalid key');
          updateCreditTracker(null, null);
          showToast('Key Error', data.error || 'Could not verify ILovePDF key', 'error', 6000);
        }
      } catch (err) {
        statusEl.className = 'text-[11px] font-bold mt-1.5 text-red-600 block';
        statusEl.textContent = '❌ Connection error: ' + err.message;
        updateCreditTracker(null, null);
      }
    }

    async function loadLectures() {
      try {
        const res = await fetch('/api/lectures');
        const data = await res.json();
        allLectures = data.lectures || [];
        if (data.defaultPublicKey && !document.getElementById('ilovepdfKey').value) {
          document.getElementById('ilovepdfKey').value = data.defaultPublicKey;
          setTimeout(verifyApiKey, 400);
        }
        if (data.tabletUrl) {
          currentTabletUrl = data.tabletUrl;
          document.getElementById('tabletUrlDisplay').textContent = data.tabletUrl;
          document.getElementById('qrUrlText').textContent = data.tabletUrl;
          document.getElementById('qrCodeImg').src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(data.tabletUrl);
        }
        renderLectures();
      } catch (err) {
        document.getElementById('lecturesContainer').innerHTML =
          '<div class="p-6 text-center text-xs text-red-600 bg-red-50 rounded-2xl border border-red-200">Failed to load lectures from database. Check server terminal.</div>';
      }
    }

    function copyTabletUrl() {
      const url = currentTabletUrl || document.getElementById('tabletUrlDisplay').textContent;
      navigator.clipboard.writeText(url);
      const btn = document.getElementById('copyBtn');
      btn.textContent = '✓ Copied!';
      setTimeout(() => btn.textContent = 'Copy', 2000);
    }

    function toggleQrModal() {
      const modal = document.getElementById('qrModal');
      modal.classList.toggle('hidden');
    }

    function toggleCompress() {
      const isChecked = document.getElementById('compressToggle').checked;
      document.getElementById('toggleLabel').textContent = isChecked ? 'Compression Active' : 'Compression Turned Off';
      document.getElementById('compressionSettings').style.opacity = isChecked ? '1' : '0.4';
      saveSettings();
    }

    function saveSettings() {
      const settings = {
        enabled: document.getElementById('compressToggle').checked,
        level: document.getElementById('compressionLevel').value,
        key: document.getElementById('ilovepdfKey').value.trim()
      };
      localStorage.setItem('medatlas_pdf_tool_settings', JSON.stringify(settings));
    }

    function loadSavedSettings() {
      try {
        const raw = localStorage.getItem('medatlas_pdf_tool_settings');
        if (raw) {
          const s = JSON.parse(raw);
          if (s.enabled !== undefined) {
            document.getElementById('compressToggle').checked = s.enabled;
            document.getElementById('toggleLabel').textContent = s.enabled ? 'Compression Active' : 'Compression Turned Off';
            document.getElementById('compressionSettings').style.opacity = s.enabled ? '1' : '0.4';
          }
          if (s.level) document.getElementById('compressionLevel').value = s.level;
          if (s.key) document.getElementById('ilovepdfKey').value = s.key;
        }
      } catch {}
    }

    function filterLectures() {
      renderLectures();
    }

    function renderLectures() {
      const query = (document.getElementById('searchInput').value || '').toLowerCase().trim();
      const status = document.getElementById('statusFilter').value;

      const filtered = allLectures.filter(l => {
        const matchText = !query ||
          l.title.toLowerCase().includes(query) ||
          (l.subjectTitle || '').toLowerCase().includes(query) ||
          String(l.lectureNumber).includes(query);

        const matchStatus =
          status === 'all' ||
          (status === 'missing' && !l.pdfUrl) ||
          (status === 'has_pdf' && Boolean(l.pdfUrl));

        return matchText && matchStatus;
      });

      const total = allLectures.length;
      const withPdf = allLectures.filter(l => Boolean(l.pdfUrl)).length;
      const missingPdf = total - withPdf;

      document.getElementById('metricsBar').textContent =
        total + ' Total Lectures · ' + withPdf + ' with PDF · ' + missingPdf + ' Missing';

      if (filtered.length === 0) {
        document.getElementById('lecturesContainer').innerHTML =
          '<div class="p-8 text-center text-xs text-slate-400 bg-white rounded-2xl border border-slate-200">No matching lectures found.</div>';
        return;
      }

      let html = '';
      filtered.forEach(l => {
        const hasPdf = Boolean(l.pdfUrl);
        html += '<div id="card-' + l.id + '" class="p-4 rounded-2xl border border-slate-200 bg-white hover:border-slate-300 transition-all flex flex-col md:flex-row md:items-center justify-between gap-3 shadow-xs" ' +
          'ondragover="handleCardDragOver(event, ' + l.id + ')" ' +
          'ondragleave="handleCardDragLeave(event, ' + l.id + ')" ' +
          'ondrop="handleCardDrop(event, ' + l.id + ')">';

        // Info
        html += '<div class="space-y-1 min-w-0 flex-1">';
        html += '<div class="flex flex-wrap items-center gap-2">';
        html += '<span class="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold font-mono bg-teal-50 text-teal-800 border border-teal-200">' + (l.moduleCode ? '[' + l.moduleCode + '] ' : '') + (l.subjectTitle || 'Subject') + '</span>';
        html += '<span class="text-[10px] font-mono-tabular font-bold text-slate-400">#' + l.id + '</span>';
        if (hasPdf) {
          html += '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-50 text-emerald-700 border border-emerald-200">✓ PDF Attached</span>';
        } else {
          html += '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-50 text-amber-700 border border-amber-200">No PDF</span>';
        }

        // Live Compression Badge
        if (l.lastUploadStats) {
          if (l.lastUploadStats.usedCompression) {
            html += '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-900 border border-emerald-300 shadow-2xs">' +
              '⚡ Compressed: ' + l.lastUploadStats.originalMb + 'MB → ' + l.lastUploadStats.compressedMb + 'MB (-' + l.lastUploadStats.savings + '%)</span>';
          } else {
            html += '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-slate-100 text-slate-700 border border-slate-200">' +
              '📄 Original (' + l.lastUploadStats.sizeKb + ' KB)</span>';
          }
        }

        html += '</div>';

        html += '<h3 class="font-bold text-sm text-slate-900 truncate">Lecture ' + (l.lectureNumber || 1) + ': ' + l.title + '</h3>';

        html += '<p class="text-xs text-slate-500 font-mono-tabular">';
        html += (l.questionCount || 0) + ' MCQs attached';
        if (hasPdf) {
          html += ' · <span class="text-emerald-700 font-sans font-medium">' + l.pdfUrl + '</span>';
        }
        html += '</p>';

        // Status feedback line
        html += '<div id="status-' + l.id + '" class="text-xs font-medium pt-1 hidden"></div>';
        html += '</div>';

        // Actions
        html += '<div class="flex items-center gap-2 shrink-0">';
        if (hasPdf) {
          html += '<a href="' + l.pdfUrl + '" target="_blank" class="px-3 py-1.5 text-xs font-semibold text-[#0284c7] bg-sky-50 hover:bg-sky-100 border border-sky-200 rounded-xl transition-colors cursor-pointer">Preview PDF</a>';
        }

        html += '<label class="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-xl transition-colors cursor-pointer shadow-xs ' +
          (hasPdf ? 'text-slate-700 bg-slate-100 hover:bg-slate-200' : 'text-white bg-[#0284c7] hover:bg-[#0369a1]') + '">';
        html += '<input type="file" accept=".pdf,application/pdf" class="hidden" onchange="uploadFileForLecture(' + l.id + ', this.files[0])">';
        html += '<span>' + (hasPdf ? 'Replace PDF' : 'Upload PDF') + '</span>';
        html += '</label>';
        html += '</div>';

        html += '</div>';
      });

      document.getElementById('lecturesContainer').innerHTML = html;
    }

    function handleCardDragOver(e, id) {
      e.preventDefault();
      document.getElementById('card-' + id).classList.add('drop-active');
    }

    function handleCardDragLeave(e, id) {
      document.getElementById('card-' + id).classList.remove('drop-active');
    }

    function handleCardDrop(e, id) {
      e.preventDefault();
      document.getElementById('card-' + id).classList.remove('drop-active');
      const file = e.dataTransfer.files?.[0];
      if (file) uploadFileForLecture(id, file);
    }

    async function uploadFileForLecture(lectureId, file) {
      if (!file) return;
      if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
        alert('Please choose a valid .pdf file.');
        return;
      }

      const statusEl = document.getElementById('status-' + lectureId);
      statusEl.className = 'text-xs font-medium pt-1 text-[#0284c7] block';
      statusEl.innerHTML = '<span class="animate-pulse">⏳ Preparing upload...</span>';

      const compressEnabled = document.getElementById('compressToggle').checked;
      const compressionLevel = document.getElementById('compressionLevel').value;
      const publicKey = document.getElementById('ilovepdfKey').value.trim();

      const loadingToast = showToast(
        '⏳ Uploading Lecture #' + lectureId,
        compressEnabled && publicKey
          ? 'Compressing with ILovePDF (' + compressionLevel + ')... Please wait a few seconds.'
          : 'Uploading original PDF...',
        'info',
        45000
      );

      const formData = new FormData();
      formData.append('lectureId', String(lectureId));
      formData.append('file', file);
      formData.append('compress', String(compressEnabled));
      formData.append('compressionLevel', compressionLevel);
      formData.append('publicKey', publicKey);

      try {
        if (compressEnabled && publicKey) {
          statusEl.innerHTML = '<span class="animate-pulse text-amber-700">⚡ Compressing with ILovePDF (' + compressionLevel + ')... Please wait</span>';
        }

        const res = await fetch('/api/upload', {
          method: 'POST',
          body: formData,
        });

        const data = await res.json();
        if (loadingToast) loadingToast.remove();

        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Upload failed');
        }

        const target = allLectures.find(l => l.id === lectureId);
        if (target) {
          target.pdfUrl = data.url;
        }

        if (data.compression && data.compression.usedCompression) {
          const origMb = (data.compression.originalSize / (1024 * 1024)).toFixed(1);
          const compMb = (data.compression.compressedSize / (1024 * 1024)).toFixed(1);
          const savings = data.compression.savingsPercent;
          const sec = (data.compression.durationMs / 1000).toFixed(1);

          if (target) {
            target.lastUploadStats = {
              usedCompression: true,
              originalMb: origMb,
              compressedMb: compMb,
              savings: savings,
              duration: sec
            };
          }

          const tgInfo = data.telegramFileId ? ' • Synced to Telegram Bot Channel' : '';
          statusEl.className = 'text-xs font-semibold pt-1 text-emerald-700 block';
          statusEl.textContent = '✓ Compressed: ' + origMb + ' MB → ' + compMb + ' MB (-' + savings + '%) in ' + sec + 's!' + tgInfo;

          showToast(
            '🎉 Upload & Sync Successful!',
            'Lecture #' + lectureId + ': ' + origMb + ' MB → ' + compMb + ' MB (-' + savings + '%)' + (data.telegramFileId ? ' • Posted to Telegram Channel (Zero Supabase Egress)' : ''),
            'success',
            9000
          );

          if (data.compression && data.compression.remainingFiles !== undefined) {
            updateCreditTracker(data.compression.remainingFiles, data.compression.remainingCredits);
          }
        } else {
          const sizeKb = (data.fileSize / 1024).toFixed(0);
          const reason = data.compression?.notes || 'Stored original';

          if (target) {
            target.lastUploadStats = {
              usedCompression: false,
              sizeKb: sizeKb,
              notes: reason
            };
          }

          const tgInfo = data.telegramFileId ? ' • Synced to Telegram Bot Channel' : '';
          statusEl.className = 'text-xs font-semibold pt-1 text-emerald-700 block';
          statusEl.textContent = '✓ Saved intact (' + sizeKb + ' KB). ' + reason + tgInfo;

          showToast(
            '✓ PDF Attached & Synced',
            'Lecture #' + lectureId + ': Saved intact (' + sizeKb + ' KB)' + (data.telegramFileId ? ' • Posted to Telegram Channel (Zero Supabase Egress)' : ''),
            'success',
            7000
          );
        }

        setTimeout(() => {
          renderLectures();
        }, 1200);

      } catch (err) {
        if (loadingToast) loadingToast.remove();
        statusEl.className = 'text-xs font-semibold pt-1 text-red-600 block';
        statusEl.textContent = '✕ Error: ' + err.message;
        showToast('Upload Failed', err.message, 'error', 8000);
      }
    }

    loadSavedSettings();
    loadLectures();
  </script>
</body>
</html>`;

// ============================================================================
// 4. HTTP Request Handler
// ============================================================================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. Serve Home HTML UI
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML_PAGE);
    return;
  }

  // 1.5. Health Check Endpoint
  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', time: Date.now() }));
    return;
  }

  // 2. Serve static lecture PDFs for preview
  if (url.pathname.startsWith('/lectures/')) {
    const fileName = path.basename(url.pathname);
    const filePath = path.resolve(process.cwd(), 'public', 'lectures', fileName);
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'application/pdf' });
      fs.createReadStream(filePath).pipe(res);
      return;
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('PDF file not found on disk.');
      return;
    }
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
          pdfUrl: l.pdfUrl,
          subjectId: l.subjectId,
          subjectTitle: subj?.title || 'Unknown Subject',
          moduleCode: mod?.code || null,
        };
      });

      const localIp = getLocalNetworkIp();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          lectures: enriched,
          defaultPublicKey: process.env.ILOVEPDF_PUBLIC_KEY || '',
          tabletUrl: `http://${localIp}:${PORT}`,
        })
      );
      return;
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
  }

  // 3.5. API: Verify ILovePDF Public Key
  if (url.pathname === '/api/test-ilovepdf' && req.method === 'POST') {
    try {
      const buffers: Buffer[] = [];
      for await (const chunk of req) {
        buffers.push(chunk);
      }
      const raw = Buffer.concat(buffers).toString('utf-8');
      const body = raw ? JSON.parse(raw) : {};
      const keyToTest = (body.publicKey || process.env.ILOVEPDF_PUBLIC_KEY || '').trim();

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
      const buffers: Buffer[] = [];
      for await (const chunk of req) {
        buffers.push(chunk);
      }
      const rawBody = Buffer.concat(buffers);
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
      const compressionLevel = (parsed.fields['compressionLevel'] as any) || 'recommended';
      const publicKey =
        parsed.fields['publicKey'] || process.env.ILOVEPDF_PUBLIC_KEY || '';

      const uploadedFile = parsed.files['file'];
      if (!uploadedFile || !uploadedFile.data || uploadedFile.data.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No PDF file was uploaded.' }));
        return;
      }

      if (!lectureId || isNaN(lectureId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Valid lectureId is required.' }));
        return;
      }

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

      if (uploadedFile.data.subarray(0, 5).toString() !== '%PDF-') throw new Error('Only PDF files are accepted.');
      // Upload PDF contents to Telegram and attach metadata in PostgreSQL.
      const result = await saveAndAttachPdf(lectureId, finalBuffer, uploadedFile.filename);

      console.log(`[Local PDF Tool] ✅ Attached to Lecture #${lectureId} -> ${result.url}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          lecture: result.lecture,
          url: result.url,
          telegramFileId: result.telegramFileId,
          fileName: result.fileName,
          fileSize: result.fileSize,
          compression: compressionMeta,
        })
      );
      return;
    } catch (err: any) {
      console.error('[Local PDF Tool Error]', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Failed to process PDF upload.' }));
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
