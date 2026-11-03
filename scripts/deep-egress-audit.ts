import 'dotenv/config';
import { Pool } from 'pg';

async function audit() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log('=== DATABASE EGRESS AUDIT ===');

  // 1. Audit every table and TOAST size in postgres
  const tableSizes = await pool.query(`
    SELECT
      c.relname AS object_name,
      CASE c.relkind
        WHEN 'r' THEN 'table'
        WHEN 't' THEN 'toast'
        WHEN 'i' THEN 'index'
      END AS type,
      pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
      pg_total_relation_size(c.oid) AS bytes
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' OR c.relname LIKE 'pg_toast%'
    ORDER BY pg_total_relation_size(c.oid) DESC
    LIMIT 20;
  `);
  console.log('--- Top 20 Relations by Size ---');
  console.table(tableSizes.rows);

  // 2. Check question_attempts: total rows, total bytes of question_snapshot_json
  const qaAudit = await pool.query(`
    SELECT
      count(*) as total_rows,
      pg_size_pretty(sum(pg_column_size(question_snapshot_json))::numeric) as total_snapshot_bytes,
      sum(pg_column_size(question_snapshot_json)) as raw_snapshot_bytes,
      avg(pg_column_size(question_snapshot_json))::int as avg_snapshot_bytes
    FROM question_attempts;
  `);
  console.log('--- Question Attempts Snapshot Data ---');
  console.table(qaAudit.rows);

  // 3. Check exam_sessions: question_order_json size
  const sessAudit = await pool.query(`
    SELECT
      count(*) as total_sessions,
      pg_size_pretty(sum(pg_column_size(question_order_json))::numeric) as total_order_json_bytes,
      sum(pg_column_size(question_order_json)) as raw_order_bytes,
      avg(pg_column_size(question_order_json))::int as avg_order_bytes
    FROM exam_sessions;
  `);
  console.log('--- Exam Sessions Order JSON Data ---');
  console.table(sessAudit.rows);

  // 4. Check audit logs or import batches or backup records
  const auditLogs = await pool.query(`
    SELECT
      count(*) as log_count,
      pg_size_pretty(sum(pg_column_size(admin_audit_logs.*))::numeric) as size
    FROM admin_audit_logs;
  `);
  console.log('--- Admin Audit Logs ---');
  console.table(auditLogs.rows);

  await pool.end();
}
audit().catch(console.error);
