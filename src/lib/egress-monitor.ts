import fs from 'node:fs';
import path from 'node:path';
import { isTelegramConfigured } from './telegram-storage.js';

/**
 * Supabase Free Tier Egress Parameters
 * - Monthly Allowance: 5 GB (5,368,709,120 bytes)
 * - Emergency Plan B Trigger Threshold: 85% = 4.25 GB (4,563,402,752 bytes)
 */
export const SUPABASE_MONTHLY_QUOTA_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
export const EGRESS_THRESHOLD_RATIO = 0.85; // 85%
export const EGRESS_THRESHOLD_BYTES = Math.floor(SUPABASE_MONTHLY_QUOTA_BYTES * EGRESS_THRESHOLD_RATIO);

interface EgressState {
  month: string; // 'YYYY-MM'
  bytesServed: number;
  forcedOverride: boolean | null; // true = force Telegram, false = force disable, null = auto
  lastUpdated: string;
}

const STATE_FILE_PATH = path.resolve(process.cwd(), '.egress-tracker.json');

function getCurrentMonthKey(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function calculateDaysUntilReset(): number {
  const now = new Date();
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const diffMs = nextMonth.getTime() - now.getTime();
  return Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
}

let inMemoryState: EgressState = {
  month: getCurrentMonthKey(),
  bytesServed: 0,
  forcedOverride: null,
  lastUpdated: new Date().toISOString(),
};

// Load saved state from disk if exists
try {
  if (fs.existsSync(STATE_FILE_PATH)) {
    const raw = fs.readFileSync(STATE_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const currentMonth = getCurrentMonthKey();
      if (parsed.month === currentMonth) {
        inMemoryState = {
          month: currentMonth,
          bytesServed: Number(parsed.bytesServed) || 0,
          forcedOverride: typeof parsed.forcedOverride === 'boolean' ? parsed.forcedOverride : null,
          lastUpdated: parsed.lastUpdated || new Date().toISOString(),
        };
      } else {
        // New calendar month: automatically reset egress counter!
        inMemoryState = {
          month: currentMonth,
          bytesServed: 0,
          forcedOverride: null,
          lastUpdated: new Date().toISOString(),
        };
        saveStateToDisk();
      }
    }
  }
} catch {
  // Non-fatal if state file cannot be read
}

function saveStateToDisk(): void {
  try {
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(inMemoryState, null, 2), 'utf8');
  } catch {
    // Disk write error is non-fatal
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Checks and rolls over the month if the calendar month has changed.
 */
function ensureCurrentMonth(): void {
  const currentMonth = getCurrentMonthKey();
  if (inMemoryState.month !== currentMonth) {
    inMemoryState.month = currentMonth;
    inMemoryState.bytesServed = 0;
    inMemoryState.forcedOverride = null;
    inMemoryState.lastUpdated = new Date().toISOString();
    saveStateToDisk();
  }
}

/**
 * Records outbound PDF bytes served.
 * If this pushes egress past 85%, triggers Plan B Telegram fallback.
 */
export function recordPdfEgress(bytes: number): void {
  ensureCurrentMonth();
  const added = Math.max(0, Math.floor(bytes));
  const prevBytes = inMemoryState.bytesServed;
  inMemoryState.bytesServed += added;
  inMemoryState.lastUpdated = new Date().toISOString();
  saveStateToDisk();

  if (prevBytes < EGRESS_THRESHOLD_BYTES && inMemoryState.bytesServed >= EGRESS_THRESHOLD_BYTES) {
    console.warn(
      `⚠️ [EGRESS MONITOR ALERT] Monthly Supabase egress reached 85% (${formatBytes(inMemoryState.bytesServed)} / 5 GB). ` +
      `Plan B (Telegram CDN fallback) is now AUTOMATICALLY ACTIVE!`
    );
  }
}

/**
 * Returns whether Plan B (Telegram CDN) should be used for PDF delivery.
 * Triggered if:
 * 1. Telegram bot is configured, AND
 * 2. EITHER forcedOverride is true OR monthly egress >= 85% (4.25 GB)
 */
export function isPlanBActive(): boolean {
  if (!isTelegramConfigured()) {
    return false;
  }

  ensureCurrentMonth();

  // Environment variable override takes highest precedence
  if (process.env.FORCE_TELEGRAM_PDF_FALLBACK === 'true') {
    return true;
  }
  if (process.env.FORCE_TELEGRAM_PDF_FALLBACK === 'false') {
    return false;
  }

  // Programmatic admin override
  if (inMemoryState.forcedOverride === true) {
    return true;
  }
  if (inMemoryState.forcedOverride === false) {
    return false;
  }

  // Automatic 85% threshold trigger
  return inMemoryState.bytesServed >= EGRESS_THRESHOLD_BYTES;
}

/**
 * Allows an admin to force-enable, force-disable, or reset to auto (null).
 */
export function setPlanBOverride(override: boolean | null): void {
  ensureCurrentMonth();
  inMemoryState.forcedOverride = override;
  inMemoryState.lastUpdated = new Date().toISOString();
  saveStateToDisk();
}

/**
 * Returns a complete diagnostic summary of Supabase egress usage and Plan B status.
 */
export function getEgressStatus() {
  ensureCurrentMonth();

  const currentBytes = inMemoryState.bytesServed;
  const percentUsed = Math.min(100, (currentBytes / SUPABASE_MONTHLY_QUOTA_BYTES) * 100);
  const planBActive = isPlanBActive();
  const telegramAvailable = isTelegramConfigured();

  return {
    quotaBytes: SUPABASE_MONTHLY_QUOTA_BYTES,
    quotaFormatted: '5.00 GB',
    thresholdBytes: EGRESS_THRESHOLD_BYTES,
    thresholdFormatted: '4.25 GB (85%)',
    currentBytes,
    currentFormatted: formatBytes(currentBytes),
    percentUsed: Number(percentUsed.toFixed(2)),
    thresholdPercent: 85,
    isPlanBActive: planBActive,
    forcedOverride: inMemoryState.forcedOverride,
    telegramConfigured: telegramAvailable,
    month: inMemoryState.month,
    daysUntilReset: calculateDaysUntilReset(),
    statusMessage: planBActive
      ? 'Plan B Active: Lecture PDFs are being served via Telegram CDN (0 Supabase egress used).'
      : `Normal Operation: Lecture PDFs served normally (${percentUsed.toFixed(1)}% of 85% threshold).`,
  };
}

/**
 * For test assertions: reset internal state.
 */
export function _resetEgressStateForTesting(): void {
  inMemoryState = {
    month: getCurrentMonthKey(),
    bytesServed: 0,
    forcedOverride: null,
    lastUpdated: new Date().toISOString(),
  };
  saveStateToDisk();
}
