import 'dotenv/config';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { app } from '../server.ts';
import {
  getEgressStatus,
  recordPdfEgress,
  _resetEgressStateForTesting,
  EGRESS_THRESHOLD_BYTES,
  isPlanBActive,
} from '../src/lib/egress-monitor.ts';

async function verifyAll() {
  console.log('=== 1. Verifying Database RLS & Telegram Sync State ===');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const rlsRes = await pool.query(`
      SELECT tablename, rowsecurity
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);
    console.log('Public tables count:', rlsRes.rows.length);
    for (const row of rlsRes.rows) {
      assert.equal(row.rowsecurity, true, `RLS must be enabled on ${row.tablename}`);
    }
    console.log('✅ All', rlsRes.rows.length, 'public tables have RLS enabled.');

    const filesRes = await pool.query(
      'SELECT id, file_name, file_size, url, telegram_file_id FROM lecture_files ORDER BY id ASC'
    );
    assert.ok(filesRes.rows.length > 0, 'Must have lecture_files');
    const missingTg = filesRes.rows.filter((r) => !r.telegram_file_id);
    assert.equal(missingTg.length, 0, 'All lecture_files must have telegram_file_id populated');
    console.log('✅ All', filesRes.rows.length, 'lecture PDFs in database have valid Telegram file_ids.');

    const testFile = filesRes.rows.find((r) => r.file_size < 600000) || filesRes.rows[0];
    console.log('Testing with lecture PDF:', testFile.url, '(' + testFile.file_size + ' bytes)');

    console.log('\n=== 2. Verifying Live HTTP PDF Delivery (Normal Mode vs Plan B @ 85%) ===');
    _resetEgressStateForTesting();
    assert.equal(isPlanBActive(), false, 'Plan B should start inactive at 0% egress');

    const server = app.listen(0);
    const address = server.address() as any;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      // A. Normal Mode Request (< 85%)
      const normalRes = await fetch(baseUrl + testFile.url);
      assert.equal(normalRes.status, 200, 'Normal mode PDF request must return 200');
      const normalSource = normalRes.headers.get('x-medatlas-source');
      const normalBuf = Buffer.from(await normalRes.arrayBuffer());
      assert.equal(normalBuf.subarray(0, 4).toString(), '%PDF', 'Must be valid PDF binary');
      console.log(
        '✅ Normal Mode (<85% egress) served from:',
        normalSource,
        '| Size:',
        normalBuf.length,
        'bytes'
      );

      const statusAfterNormal = getEgressStatus();
      if (normalSource === 'telegram') {
        assert.equal(
          statusAfterNormal.currentBytes,
          0,
          'Telegram-first delivery must consume 0 bytes of local/database egress'
        );
        console.log('✅ Telegram-first delivery confirmed: 0 bytes drawn from database/local egress!');
      } else {
        assert.equal(
          statusAfterNormal.currentBytes,
          normalBuf.length,
          'Egress monitor must record exact bytes served when served locally'
        );
      }
      assert.equal(statusAfterNormal.isPlanBActive, false);
      console.log(
        '✅ Egress Monitor status:',
        statusAfterNormal.currentBytes,
        'bytes (' + statusAfterNormal.percentUsed + '%)'
      );

      // B. Simulate crossing 85% Egress Threshold (4.25 GB)
      recordPdfEgress(EGRESS_THRESHOLD_BYTES);
      assert.equal(isPlanBActive(), true, 'Plan B must activate automatically at >= 85% egress');

      const planBRes = await fetch(baseUrl + testFile.url);
      assert.equal(planBRes.status, 200, 'Plan B Telegram PDF request must return 200');
      const planBSource = planBRes.headers.get('x-medatlas-source');
      assert.equal(planBSource, 'telegram-plan-b', 'Source header must be telegram-plan-b');
      assert.equal(
        planBRes.headers.get('access-control-allow-origin'),
        '*',
        'CORS header must be present'
      );
      const planBBuf = Buffer.from(await planBRes.arrayBuffer());
      assert.equal(planBBuf.subarray(0, 4).toString(), '%PDF', 'Telegram stream must be valid PDF binary');
      assert.equal(planBBuf.length, normalBuf.length, 'Telegram PDF size must match original byte-for-byte');
      assert.equal(
        Buffer.compare(planBBuf, normalBuf),
        0,
        'Telegram PDF content must match original byte-for-byte'
      );
      console.log(
        '✅ Plan B Mode (>=85% egress) streamed from:',
        planBSource,
        '| Size:',
        planBBuf.length,
        'bytes | Byte-for-byte match verified!'
      );
    } finally {
      _resetEgressStateForTesting();
      server.close();
    }
  } finally {
    await pool.end();
  }
  console.log('\n🎉 ALL END-TO-END VERIFICATIONS PASSED!');
  process.exit(0);
}

verifyAll().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
