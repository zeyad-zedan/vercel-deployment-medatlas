import { pool } from '../src/db/index.ts';

async function migrate() {
  console.log('Running modules schema migration...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS modules (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      display_order INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'published',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    ALTER TABLE subjects ADD COLUMN IF NOT EXISTS module_id INTEGER REFERENCES modules(id) ON DELETE CASCADE;

    -- Seed BSF 112 module if not exists
    INSERT INTO modules (code, title, description, display_order, status)
    VALUES ('BSF 112', 'Basic Structure & Function (BSF 112)', 'Integrated foundation module covering Physiology, Biochemistry, Anatomy & Histology.', 1, 'published')
    ON CONFLICT (code) DO NOTHING;

    -- Link existing Physiology subject to BSF 112
    UPDATE subjects
    SET module_id = (SELECT id FROM modules WHERE code = 'BSF 112' LIMIT 1),
        title = CASE WHEN title LIKE '%Physiology%' THEN 'Physiology' ELSE title END
    WHERE module_id IS NULL;

    -- Add Biochemistry under BSF 112 if not exists
    INSERT INTO subjects (module_id, slug, title, description, display_order, status)
    SELECT
      (SELECT id FROM modules WHERE code = 'BSF 112' LIMIT 1),
      'biochemistry-bsf112',
      'Biochemistry',
      'Medical Biochemistry & Molecular Biology in BSF 112',
      2,
      'published'
    WHERE NOT EXISTS (
      SELECT 1 FROM subjects WHERE title = 'Biochemistry' AND module_id = (SELECT id FROM modules WHERE code = 'BSF 112' LIMIT 1)
    );
  `);

  const modulesRes = await pool.query('SELECT * FROM modules');
  console.log('Modules in database:', modulesRes.rows);

  const subjectsRes = await pool.query('SELECT id, module_id, title FROM subjects');
  console.log('Subjects in database:', subjectsRes.rows);

  console.log('Migration completed successfully.');
  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
