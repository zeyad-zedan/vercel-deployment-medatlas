import path from 'node:path';
import fs from 'node:fs';
import {
  generateBackupArchive,
  testRestoreBackup,
  pruneOldBackups,
  DEFAULT_BACKUP_RETENTION_DAYS,
} from '../src/lib/backup-service.ts';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  switch (command) {
    case 'create': {
      console.log('🔄 Initiating full encrypted database backup...');
      const retentionDays = args[1] ? Number.parseInt(args[1], 10) : DEFAULT_BACKUP_RETENTION_DAYS;
      const { filePath, envelope, prunedFiles } = await generateBackupArchive({ retentionDays });
      console.log(`✅ Backup created successfully: ${filePath}`);
      console.log(`📊 Total tables backed up: ${Object.keys(envelope.metadata.tables).length}`);
      console.log('📈 Table breakdown:');
      for (const [table, count] of Object.entries(envelope.metadata.tables)) {
        console.log(`   - ${table}: ${count} records`);
      }
      if (prunedFiles.length > 0) {
        console.log(`🧹 Pruned ${prunedFiles.length} expired backups (> ${retentionDays} days):`, prunedFiles);
      }
      break;
    }

    case 'verify':
    case 'restore-test': {
      let backupPath = args[1];
      if (!backupPath) {
        // Find most recent backup in backups/
        const backupDir = path.resolve(process.cwd(), 'backups');
        if (!fs.existsSync(backupDir)) {
          console.error('❌ No backups directory found. Run "npm run backup:create" first.');
          process.exit(1);
        }
        const files = fs.readdirSync(backupDir).filter((f) => f.endsWith('.enc.json')).sort().reverse();
        if (files.length === 0) {
          console.error('❌ No encrypted backup archives found in backups/');
          process.exit(1);
        }
        backupPath = path.join(backupDir, files[0]);
      }

      console.log(`🔍 Running isolated non-destructive restore test on: ${backupPath}`);
      const result = await testRestoreBackup(backupPath);

      if (result.success) {
        console.log('✅ Integrity and non-destructive restore test PASSED!');
        console.log(`⏱️ Duration: ${result.durationMs}ms`);
        console.log(`📦 Verified total records: ${result.totalRecords}`);
        console.log('📊 Table record counts:');
        for (const [table, count] of Object.entries(result.tableCounts)) {
          console.log(`   - ${table}: ${count}`);
        }
      } else {
        console.error('❌ Restore verification FAILED!');
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'prune': {
      const days = args[1] ? Number.parseInt(args[1], 10) : DEFAULT_BACKUP_RETENTION_DAYS;
      const backupDir = path.resolve(process.cwd(), 'backups');
      console.log(`🧹 Pruning backups older than ${days} days...`);
      const pruned = pruneOldBackups({ backupDir, maxAgeDays: days });
      console.log(`Pruned ${pruned.length} backup(s).`);
      break;
    }

    case 'help':
    default: {
      console.log(`
MedAtlas Automated Backup & Disaster Recovery CLI

Usage:
  tsx scripts/backup-cli.ts create [retentionDays]
      Creates a full AES-256-GCM encrypted snapshot, generates SHA-256 integrity checksums,
      and prunes archives older than 30 days (or specified days).

  tsx scripts/backup-cli.ts verify [backupFilePath]
      Decrypts, checks SHA-256 checksums, and performs an isolated transactional dry-run restore.
      If no path is provided, tests the most recent backup in backups/.

  tsx scripts/backup-cli.ts restore-test [backupFilePath]
      Alias for verify.

  tsx scripts/backup-cli.ts prune [days]
      Prunes backups older than the specified retention window (default 30 days).
      `);
      break;
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal CLI Error:', err);
  process.exit(1);
});
