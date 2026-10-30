import 'dotenv/config';
import { Pool } from 'pg';
import { uploadPdfToTelegram, fetchTelegramPdfBuffer, isTelegramConfigured } from '../src/lib/telegram-storage.js';

async function main() {
  console.log('--- MedAtlas Telegram Plan B Storage Sync ---');

  if (!isTelegramConfigured()) {
    console.error('❌ Telegram is not configured in .env (TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID required)');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const { rows } = await pool.query(
      `SELECT id, file_name, file_size, data_base64, url, telegram_file_id 
       FROM lecture_files 
       ORDER BY id ASC`
    );

    console.log(`Found ${rows.length} total lecture PDF files in database.`);
    const pending = rows.filter((r) => !r.telegram_file_id);
    console.log(`Files needing sync to Telegram channel: ${pending.length}`);

    let successCount = 0;
    for (const file of pending) {
      console.log(`\nUploading [${file.id}] ${file.file_name} (${(file.file_size / 1024).toFixed(1)} KB)...`);
      if (!file.data_base64) {
        console.warn(`  ⚠️ Skipped: no base64 data found.`);
        continue;
      }

      const buffer = Buffer.from(file.data_base64, 'base64');
      try {
        const uploadRes = await uploadPdfToTelegram(
          file.file_name,
          buffer,
          `📄 MedAtlas Lecture PDF\nID: ${file.id}\nFile: ${file.file_name}`
        );

        await pool.query(
          `UPDATE lecture_files SET telegram_file_id = $1 WHERE id = $2`,
          [uploadRes.fileId, file.id]
        );

        console.log(`  ✅ Synced! Telegram fileId: ${uploadRes.fileId}`);
        successCount++;

        // Small delay between Telegram API calls to prevent rate limiting
        await new Promise((resolve) => setTimeout(resolve, 800));
      } catch (err: any) {
        console.error(`  ❌ Failed uploading ${file.file_name}:`, err.message);
      }
    }

    console.log(`\n========================================`);
    console.log(`Sync complete! Successfully synced ${successCount} files.`);

    // Quick verification test on the first available file
    const verifyRow = (await pool.query(`SELECT id, file_name, telegram_file_id FROM lecture_files WHERE telegram_file_id IS NOT NULL LIMIT 1`)).rows[0];
    if (verifyRow) {
      console.log(`\nVerifying streaming test for file #${verifyRow.id} (${verifyRow.file_name})...`);
      const stream = await fetchTelegramPdfBuffer(verifyRow.telegram_file_id);
      console.log(`✅ Verification passed! Successfully retrieved ${stream.contentLength} bytes from Telegram CDN.`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal error during sync:', err);
  process.exit(1);
});
