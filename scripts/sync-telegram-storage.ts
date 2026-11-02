import 'dotenv/config';
import { pool } from '../src/db/index.ts';
// Telegram-only validation. Never read PDF contents from PostgreSQL.
try {
  const result = await pool.query(`SELECT count(*) AS total,
    count(*) FILTER (WHERE telegram_file_id IS NULL OR telegram_file_id = '') AS missing
    FROM lecture_files`);
  console.log('Telegram PDF references:', result.rows[0]);
  if (Number(result.rows[0].missing)) {
    console.error('Re-upload missing PDFs from the original files through the upload portal. Database PDF fallback is disabled.');
    process.exitCode = 1;
  }
} finally { await pool.end(); }
