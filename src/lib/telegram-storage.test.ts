import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTelegramConfigured,
  uploadPdfToTelegram,
  getTelegramFileDownloadUrl,
  fetchTelegramPdfBuffer,
} from './telegram-storage.js';

test('isTelegramConfigured returns true when bot token and channel ID are present', () => {
  const origToken = process.env.TELEGRAM_BOT_TOKEN;
  const origChannel = process.env.TELEGRAM_CHANNEL_ID;

  try {
    process.env.TELEGRAM_BOT_TOKEN = '12345:test-token';
    process.env.TELEGRAM_CHANNEL_ID = '-1001234567890';
    assert.equal(isTelegramConfigured(), true);

    delete process.env.TELEGRAM_BOT_TOKEN;
    assert.equal(isTelegramConfigured(), false);

    process.env.TELEGRAM_BOT_TOKEN = '  ';
    assert.equal(isTelegramConfigured(), false);
  } finally {
    if (origToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = origToken;
    else delete process.env.TELEGRAM_BOT_TOKEN;
    if (origChannel !== undefined) process.env.TELEGRAM_CHANNEL_ID = origChannel;
    else delete process.env.TELEGRAM_CHANNEL_ID;
  }
});

test('uploadPdfToTelegram rejects files larger than 50MB', async () => {
  const hugeBuffer = Buffer.alloc(51 * 1024 * 1024);
  await assert.rejects(
    async () => {
      await uploadPdfToTelegram('large.pdf', hugeBuffer);
    },
    { message: /exceeds Telegram maximum upload limit of 50 MB/ }
  );
});

test('getTelegramFileDownloadUrl throws descriptive error on missing token', async () => {
  const origToken = process.env.TELEGRAM_BOT_TOKEN;
  try {
    delete process.env.TELEGRAM_BOT_TOKEN;
    await assert.rejects(
      async () => {
        await getTelegramFileDownloadUrl('mock-file-id');
      },
      { message: /Telegram Bot Token is missing/ }
    );
  } finally {
    if (origToken !== undefined) process.env.TELEGRAM_BOT_TOKEN = origToken;
  }
});
