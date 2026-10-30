/**
 * Telegram Storage Service (MedAtlas Plan B CDN)
 *
 * Provides completely free, unlimited file hosting and streaming via Telegram Bot API
 * when Supabase monthly egress exceeds the 85% threshold.
 *
 * Zero external dependencies: uses native Node.js fetch, FormData, and Blob.
 */

export interface TelegramUploadResult {
  fileId: string;
  fileUniqueId: string;
  messageId: number;
  fileName: string;
  fileSize: number;
}

export interface TelegramFileStream {
  buffer: Buffer;
  contentType: string;
  contentLength: number;
  fileName: string;
}

/**
 * Checks whether Telegram Bot credentials and Channel ID are configured.
 */
export function isTelegramConfigured(): boolean {
  return Boolean(
    process.env.TELEGRAM_BOT_TOKEN &&
    process.env.TELEGRAM_BOT_TOKEN.trim().length > 0 &&
    process.env.TELEGRAM_CHANNEL_ID &&
    process.env.TELEGRAM_CHANNEL_ID.trim().length > 0
  );
}

/**
 * Uploads a PDF buffer to the configured Telegram channel using the Bot API.
 */
export async function uploadPdfToTelegram(
  fileName: string,
  buffer: Buffer,
  caption?: string
): Promise<TelegramUploadResult> {
  // Telegram bot sendDocument max file size is 50MB for upload
  const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error(`PDF exceeds Telegram maximum upload limit of 50 MB (size: ${buffer.length} bytes).`);
  }

  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const channelId = process.env.TELEGRAM_CHANNEL_ID?.trim();

  if (!token || !channelId) {
    throw new Error('Telegram Bot Token or Channel ID is missing from environment variables.');
  }

  const formData = new FormData();
  formData.append('chat_id', channelId);
  formData.append(
    'caption',
    caption || `📄 MedAtlas Lecture: ${fileName}\n📅 ${new Date().toISOString()}`
  );
  formData.append(
    'document',
    new Blob([buffer], { type: 'application/pdf' }),
    fileName
  );

  const endpoint = `https://api.telegram.org/bot${token}/sendDocument`;
  const response = await fetch(endpoint, {
    method: 'POST',
    body: formData,
  });

  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.ok) {
    const errorMsg = data?.description || response.statusText || 'Unknown Telegram API error';
    throw new Error(`Telegram upload failed (${response.status}): ${errorMsg}`);
  }

  const doc = data.result?.document;
  if (!doc?.file_id) {
    throw new Error('Telegram API responded successfully but document file_id was missing.');
  }

  return {
    fileId: doc.file_id,
    fileUniqueId: doc.file_unique_id || '',
    messageId: data.result.message_id,
    fileName: doc.file_name || fileName,
    fileSize: doc.file_size || buffer.length,
  };
}

/**
 * Retrieves the temporary download URL for a file stored on Telegram.
 */
export async function getTelegramFileDownloadUrl(fileId: string): Promise<string> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    throw new Error('Telegram Bot Token is missing.');
  }

  const endpoint = `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const response = await fetch(endpoint);
  const data = await response.json().catch(() => null);

  if (!response.ok || !data?.ok || !data.result?.file_path) {
    const errorMsg = data?.description || response.statusText || 'Unable to retrieve file path';
    throw new Error(`Telegram getFile failed: ${errorMsg}`);
  }

  return `https://api.telegram.org/file/bot${token}/${data.result.file_path}`;
}

/**
 * Downloads a PDF buffer directly from Telegram CDN using its file_id.
 * Safe for server streaming to students without exposing bot tokens.
 */
export async function fetchTelegramPdfBuffer(fileId: string): Promise<TelegramFileStream> {
  const downloadUrl = await getTelegramFileDownloadUrl(fileId);
  const response = await fetch(downloadUrl);

  if (!response.ok) {
    throw new Error(`Failed to fetch file from Telegram CDN (${response.status}): ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = response.headers.get('content-type') || 'application/pdf';

  return {
    buffer,
    contentType,
    contentLength: buffer.length,
    fileName: downloadUrl.split('/').pop() || 'lecture.pdf',
  };
}
