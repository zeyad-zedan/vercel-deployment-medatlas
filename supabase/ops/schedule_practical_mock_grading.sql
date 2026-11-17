-- Run on the production database after deploying the worker and creating its Vault secret.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

SELECT cron.schedule('medatlas-practical-mock-grading', '* * * * *', $schedule$
  WITH request_clock AS MATERIALIZED (
    SELECT floor(extract(epoch FROM statement_timestamp()))::bigint::text AS timestamp
  )
  SELECT net.http_get(
    url := 'https://medatlas-exam.vercel.app/api/cron/practical-mock-grading',
    headers := jsonb_build_object(
      'X-MedAtlas-Grading-Timestamp', request_clock.timestamp,
      'X-MedAtlas-Grading-Signature', encode(extensions.hmac(
        request_clock.timestamp, secret.decrypted_secret, 'sha256'
      ), 'hex')
    ),
    timeout_milliseconds := 100000
  )
  FROM request_clock CROSS JOIN vault.decrypted_secrets AS secret
  WHERE secret.name = 'medatlas_practical_grading_cron'
    AND EXISTS (
      SELECT 1 FROM practical_mock.attempts
      WHERE grades IS NULL AND grade_available_at <= statement_timestamp()
        AND (lease_until IS NULL OR lease_until <= statement_timestamp())
    );
$schedule$);
