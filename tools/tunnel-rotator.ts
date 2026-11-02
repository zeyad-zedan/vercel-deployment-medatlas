/**
 * Automated Cloudflare Tunnel Supervisor & Telegram Channel Bot for MedAtlas PDF Tool
 *
 * Functions:
 * 1. Ensures the local PDF tool is running on port 4050 (or auto-launches it).
 * 2. Starts a Cloudflare Tunnel pointing to http://localhost:4050.
 * 3. Captures the generated https://...trycloudflare.com URL.
 * 4. Posts the link to your Telegram channel with an inline quick-open button.
 * 5. Automatically rotates the tunnel every 12 hours (configurable) and sends the new link.
 * 6. Supports interactive console commands ('r' to rotate now, 't' to test Telegram, 'q' to quit).
 */

import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import 'dotenv/config';
import { startPdfServer, server as pdfServer } from './local-pdf-tool.ts';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required.');
let CHANNEL_ID = (process.env.TELEGRAM_CHANNEL_ID || '').trim();
const ROTATE_HOURS = Math.max(1, Number(process.env.TUNNEL_ROTATE_HOURS || 12));
const PORT = 4050;
const ENV_PATH = path.resolve(process.cwd(), '.env');

// Potential locations for cloudflared binary on Windows
const CLOUDFLARED_CANDIDATES = [
  'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  'C:\\Program Files\\cloudflared\\cloudflared.exe',
  path.resolve(process.cwd(), 'cloudflared.exe'),
  'cloudflared.exe',
];

function findCloudflared(): string {
  for (const candidate of CLOUDFLARED_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return 'cloudflared';
}

const CLOUDFLARED_BIN = findCloudflared();

// Process references
let pdfProcess: ChildProcess | null = null;
let tunnelProcess: ChildProcess | null = null;
let adoptedTunnelPid: number | undefined;
let rotationTimer: NodeJS.Timeout | null = null;
let currentTunnelUrl = '';
let isRotating = false;

// ---------------------------------------------------------------------------
// Telegram Bot API Helper
// ---------------------------------------------------------------------------
async function sendTelegramMessage(
  text: string,
  targetChatId: string = CHANNEL_ID,
  inlineButtonUrl?: string
): Promise<{ ok: boolean; description?: string; result?: any }> {
  try {
    const payload: any = {
      chat_id: targetChatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    };

    if (inlineButtonUrl) {
      payload.reply_markup = {
        inline_keyboard: [
          [
            {
              text: '🚀 Open MedAtlas PDF Portal 📚',
              url: inlineButtonUrl,
            },
          ],
        ],
      };
    }

    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data: any = await res.json();
    return data;
  } catch (err: any) {
    return { ok: false, description: err.message };
  }
}

// ---------------------------------------------------------------------------
// Save Channel ID to .env
// ---------------------------------------------------------------------------
function saveChannelIdToEnv(channelId: string) {
  try {
    let envContent = '';
    if (fs.existsSync(ENV_PATH)) {
      envContent = fs.readFileSync(ENV_PATH, 'utf-8');
    }

    if (envContent.includes('TELEGRAM_CHANNEL_ID=')) {
      envContent = envContent.replace(/TELEGRAM_CHANNEL_ID=.*(\r?\n|$)/g, `TELEGRAM_CHANNEL_ID="${channelId}"$1`);
    } else {
      envContent += `\n# Telegram Tunnel Bot Settings\nTELEGRAM_BOT_TOKEN="${BOT_TOKEN}"\nTELEGRAM_CHANNEL_ID="${channelId}"\nTUNNEL_ROTATE_HOURS="${ROTATE_HOURS}"\n`;
    }

    if (!envContent.includes('TELEGRAM_BOT_TOKEN=')) {
      envContent += `TELEGRAM_BOT_TOKEN="${BOT_TOKEN}"\n`;
    }

    fs.writeFileSync(ENV_PATH, envContent, 'utf-8');
    console.log(`💾 Saved TELEGRAM_CHANNEL_ID="${channelId}" to .env successfully!`);
  } catch (err: any) {
    console.warn(`⚠️ Could not auto-save to .env: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Interactive Channel Setup if Missing
// ---------------------------------------------------------------------------
async function ensureChannelConfig(): Promise<string> {
  if (CHANNEL_ID) {
    return CHANNEL_ID;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const question = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  console.log('\n=============================================================');
  console.log('📢 Telegram Channel Setup');
  console.log('=============================================================');
  console.log('Before we start the tunnel, we need your Telegram Channel.');
  console.log('');
  console.log('1. Open your Telegram Channel.');
  console.log('2. Go to Channel Settings -> Administrators -> Add Administrator.');
  console.log('3. Search for: @MedAtlas_pdf_bot and add it with "Post Messages" permission.');
  console.log('4. Enter your Channel Username (e.g. @YourChannelName) or Channel ID below:');
  console.log('=============================================================\n');

  while (true) {
    let input = (await question('👉 Channel Username or ID: ')).trim();

    if (!input) {
      console.log('❌ Please enter a channel username (e.g. @MedAtlasPortal) or numeric chat ID.');
      continue;
    }

    if (!input.startsWith('@') && !input.startsWith('-') && !/^\d+$/.test(input)) {
      input = '@' + input;
    }

    console.log(`⏳ Verifying channel with Telegram bot [${input}]...`);
    const testResult = await sendTelegramMessage(
      `🔔 <b>MedAtlas PDF Tool Connected!</b>\n\nThis channel is now configured to receive live access links. Tunnel rotation runs every ${ROTATE_HOURS} hours.`,
      input
    );

    if (testResult.ok) {
      console.log('✅ Connection confirmed! Verification message posted to your channel.');
      CHANNEL_ID = input;
      saveChannelIdToEnv(CHANNEL_ID);
      rl.close();
      return CHANNEL_ID;
    } else {
      console.log(`❌ Failed to send message to "${input}": ${testResult.description}`);
      console.log('👉 Make sure:');
      console.log('   1. You added @MedAtlas_pdf_bot as an ADMINISTRATOR in this channel.');
      console.log('   2. The channel username or ID is spelled correctly.');
      console.log('   3. The channel is public (or use the private ID if private).');
      console.log('Let\'s try again:');
    }
  }
}

// ---------------------------------------------------------------------------
// Check if Local PDF Server is Running
// ---------------------------------------------------------------------------
async function ensureLocalServer(): Promise<void> {
  if (pdfServer.listening) {
    console.log(`✅ Local PDF Server already running on http://127.0.0.1:${PORT}`);
    return;
  }

  console.log(`🚀 Starting local PDF Server...`);
  await startPdfServer(false);
  console.log(`✅ Local PDF Server is active and listening on http://127.0.0.1:${PORT}`);
}

// ---------------------------------------------------------------------------
// Cloudflare Tunnel Rotation
// ---------------------------------------------------------------------------
async function startTunnel(): Promise<string> {
  if (adoptedTunnelPid) {
    try { process.kill(adoptedTunnelPid); } catch {}
    adoptedTunnelPid = undefined;
  }
  if (tunnelProcess) {
    try {
      tunnelProcess.kill('SIGTERM');
      tunnelProcess.kill('SIGKILL');
    } catch {
      // ignore
    }
    tunnelProcess = null;
  }

  return new Promise((resolve, reject) => {
    console.log(`\n🌐 Spawning Cloudflare Tunnel to http://127.0.0.1:${PORT}...`);
    console.log(`   Binary: ${CLOUDFLARED_BIN}`);

    const args = ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'];
    tunnelProcess = spawn(CLOUDFLARED_BIN, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let detectedUrl = '';
    const urlRegex = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;

    const handleOutput = (chunk: Buffer) => {
      const text = chunk.toString();
      // Uncomment if you want raw cloudflared logs:
      // process.stdout.write(text);

      const match = text.match(urlRegex);
      if (match && !detectedUrl) {
        detectedUrl = match[0];
        resolve(detectedUrl);
      }
    };

    tunnelProcess.stdout?.on('data', handleOutput);
    tunnelProcess.stderr?.on('data', handleOutput);

    tunnelProcess.on('error', (err) => {
      console.error('❌ Cloudflared error:', err);
      reject(err);
    });

    tunnelProcess.on('exit', (code, signal) => {
      if (!detectedUrl) {
        reject(new Error(`Cloudflare tunnel exited early (code: ${code}, signal: ${signal})`));
      }
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!detectedUrl) {
        reject(new Error('Timeout waiting for Cloudflare tunnel URL (30s)'));
      }
    }, 30000);
  });
}

function calculateNextRotationTime(): { formatted: string; iso: string } {
  const nextDate = new Date(Date.now() + ROTATE_HOURS * 60 * 60 * 1000);
  return {
    formatted: nextDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) +
      ' (' + nextDate.toLocaleDateString() + ')',
    iso: nextDate.toISOString(),
  };
}

async function rotateTunnel() {
  if (isRotating) return;
  isRotating = true;

  try {
    console.log('\n=============================================================');
    console.log('🔄 ROTATING TUNNEL LINK...');
    console.log('=============================================================');

    const newUrl = await startTunnel();
    currentTunnelUrl = newUrl;

    const nextRotation = calculateNextRotationTime();

    console.log('\n=============================================================');
    console.log('🎉 NEW PUBLIC LINK GENERATED:');
    console.log(`👉 ${newUrl}`);
    console.log(`⏳ Next automatic rotation at: ${nextRotation.formatted}`);
    console.log('=============================================================');

    // Post to Telegram Channel
    const message = [
      `📚 <b>MedAtlas PDF Upload Portal — Active Link</b>`,
      ``,
      `🔗 <b>Direct Link:</b>`,
      `<a href="${newUrl}">${newUrl}</a>`,
      ``,
      `📋 <b>Tap to copy:</b>`,
      `<code>${newUrl}</code>`,
      ``,
      `⏱ <b>Generated:</b> ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
      `⏳ <b>Valid until:</b> ${nextRotation.formatted} (Auto-rotates every ${ROTATE_HOURS}h)`,
      ``,
      `💡 <i>Anyone with this link can upload and compress lecture PDFs directly from outside your home network. No login or installation needed.</i>`,
    ].join('\n');

    console.log(`📤 Posting new link to Telegram channel (${CHANNEL_ID})...`);
    const postResult = await sendTelegramMessage(message, CHANNEL_ID, newUrl);

    if (postResult.ok) {
      console.log('✅ Link successfully posted to Telegram Channel!');
    } else {
      console.error(`⚠️ Telegram post warning: ${postResult.description}`);
    }

    // Schedule next rotation
    if (rotationTimer) clearTimeout(rotationTimer);
    rotationTimer = setTimeout(() => {
      rotateTunnel().catch(console.error);
    }, ROTATE_HOURS * 60 * 60 * 1000);

  } catch (err: any) {
    console.error('❌ Error during tunnel rotation:', err.message);
    // Retry in 1 minute on failure
    if (rotationTimer) clearTimeout(rotationTimer);
    rotationTimer = setTimeout(() => {
      rotateTunnel().catch(console.error);
    }, 60000);
  } finally {
    isRotating = false;
  }
}

// ---------------------------------------------------------------------------
// Clean Shutdown
// ---------------------------------------------------------------------------
function cleanExit(signal?: string) {
  console.log(`\n🛑 Shutting down tunnel supervisor (${signal || 'EXIT'})...`);
  if (rotationTimer) clearTimeout(rotationTimer);

  if (tunnelProcess) {
    try {
      tunnelProcess.kill();
    } catch {}
    tunnelProcess = null;
  }

  try {
    pdfServer.close();
  } catch {}

  console.log('👋 Goodbye!');
  process.exit(0);
}

process.on('SIGINT', () => cleanExit('SIGINT'));
process.on('SIGTERM', () => cleanExit('SIGTERM'));

// ---------------------------------------------------------------------------
// Interactive Keyboard Commands (r = rotate, t = test, q = quit)
// ---------------------------------------------------------------------------
function setupKeyboardListener() {
  if (!process.stdin.isTTY) return;

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.setRawMode) {
    process.stdin.setRawMode(true);
  }

  console.log('\n⌨️  Keyboard Controls:');
  console.log('   [r] = Force rotate link right now');
  console.log('   [t] = Send test notification to Telegram');
  console.log('   [q] = Stop tunnel and quit');
  console.log('-------------------------------------------------------------\n');

  process.stdin.on('keypress', async (str, key) => {
    if (key.ctrl && key.name === 'c') {
      cleanExit('Ctrl+C');
    }

    if (key.name === 'r') {
      console.log('\nManual rotation requested...');
      await rotateTunnel();
    } else if (key.name === 't') {
      console.log('\nSending test message to channel...');
      const res = await sendTelegramMessage(
        `🧪 <b>MedAtlas Bot Test Notification</b>\n\nTunnel supervisor is running smoothly.\nCurrent link: ${currentTunnelUrl || 'Starting up...'}`
      );
      console.log(res.ok ? '✅ Test message sent!' : `❌ Test failed: ${res.description}`);
    } else if (key.name === 'q') {
      cleanExit('quit');
    }
  });
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------
async function main() {
  console.log('=============================================================');
  console.log('🚀 MedAtlas Cloudflare Tunnel & Telegram Channel Supervisor');
  console.log(`⏱  Rotation Interval: Every ${ROTATE_HOURS} hours`);
  console.log('=============================================================');

  // 1. Ensure channel config is present
  await ensureChannelConfig();

  // 2. Ensure local PDF tool is running
  await ensureLocalServer();

  // Preserve the existing public URL when restarting only the upload server.
  if (process.argv.includes('--reuse-tunnel')) {
    const pidArg = process.argv.find((arg) => arg.startsWith('--tunnel-pid='));
    adoptedTunnelPid = Number(pidArg?.split('=')[1]);
    if (!Number.isInteger(adoptedTunnelPid) || adoptedTunnelPid <= 0) throw new Error('Existing tunnel PID required.');
    const response = await fetch('http://127.0.0.1:20241/quicktunnel');
    const data = await response.json() as { hostname: string };
    if (!/^[a-z0-9-]+\.trycloudflare\.com$/.test(data.hostname)) throw new Error('Invalid tunnel hostname.');
    currentTunnelUrl = `https://${data.hostname}`;
    console.log(`Reusing existing tunnel: ${currentTunnelUrl}`);
    rotationTimer = setTimeout(() => rotateTunnel().catch(console.error), ROTATE_HOURS * 3600000);
  } else {
    await rotateTunnel();
  }

  // 4. Listen for interactive keys
  setupKeyboardListener();
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  cleanExit('FATAL');
});
