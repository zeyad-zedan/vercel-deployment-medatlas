import path from 'node:path';
import fs from 'node:fs';
import {
  executeScheduledBackup,
  testRestoreBackup,
  DEFAULT_BACKUP_RETENTION_DAYS,
} from '../src/lib/backup-service.ts';
import { resolveBackupStorageProvider } from '../src/lib/backup-storage.ts';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  switch (command) {
    case 'create': {
      console.log('🔄 Initiating full encrypted database backup...');
      const retentionDays = args[1] ? Number.parseInt(args[1], 10) : DEFAULT_BACKUP_RETENTION_DAYS;
      const result = await executeScheduledBackup({ retentionDays });
      console.log(`✅ Backup created successfully: ${result.backupId}`);
      console.log(`📦 Storage destination: ${result.storageProvider} (${result.isDurableStorage ? 'Durable Off-site' : 'Local Ephemeral'})`);
      console.log(`📍 Location: ${result.location}`);
      console.log(`📊 Tables backed up: ${Object.keys(result.metadata.tables).length}`);
      console.log(`⏱️ Duration: ${result.durationMs}ms`);
      console.log(`🧪 Restore verification status: ${result.verificationResult.status}`);
      if (result.prunedCount > 0) {
        console.log(`🧹 Pruned ${result.prunedCount} expired backups (> ${retentionDays} days)`);
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
          console.error('❌ No local backups directory found. Pass a backup file path or run "npm run backup:create" first.');
          process.exit(1);
        }
        const files = fs.readdirSync(backupDir).filter((f) => f.endsWith('.enc.json')).sort().reverse();
        if (files.length === 0) {
          console.error('❌ No encrypted backup archives found in backups/');
          process.exit(1);
        }
        backupPath = path.join(backupDir, files[0]);
      }

      console.log(`🔍 Running genuine isolated restore verification on: ${backupPath}`);
      const result = await testRestoreBackup(backupPath);

      if (result.status === 'verified') {
        console.log('✅ Genuine isolated restore test VERIFIED!');
        console.log(`🏛️ Tested isolated schema: ${result.isolatedSchemaTested}`);
        console.log(`⏱️ Duration: ${result.durationMs}ms`);
        console.log(`📦 Verified total records: ${result.totalRecords}`);
        console.log('📊 Table record counts:');
        for (const [table, count] of Object.entries(result.tableCounts)) {
          console.log(`   - ${table}: ${count}`);
        }
      } else if (result.status === 'incomplete') {
        console.warn('⚠️ Restore verification INCOMPLETE (not failed):');
        console.warn(`Reason: ${result.reason}`);
      } else {
        console.error('❌ Restore verification FAILED!');
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'prune': {
      const days = args[1] ? Number.parseInt(args[1], 10) : DEFAULT_BACKUP_RETENTION_DAYS;
      console.log(`🧹 Pruning off-site backups older than ${days} days...`);
      const storage = await resolveBackupStorageProvider();
      const cutoffTime = Date.now() - days * 24 * 60 * 60 * 1000;
      const remoteObjects = await storage.list('medatlas_backup_');
      let pruned = 0;
      for (const obj of remoteObjects) {
        if (obj.lastModified.getTime() < cutoffTime) {
          await storage.delete(obj.key);
          pruned++;
        }
      }
      console.log(`Pruned ${pruned} backup(s) from ${storage.name}.`);
      break;
    }

    case 'help':
    default: {
      console.log(`
MedAtlas Automated Backup & Disaster Recovery CLI

Usage:
  tsx scripts/backup-cli.ts create [retentionDays]
      Creates a consistent snapshot (Repeatable Read), encrypts with BACKUP_ENCRYPTION_KEY,
      uploads to durable off-site storage, runs genuine restore verification, and prunes old backups.

  tsx scripts/backup-cli.ts verify [backupFilePath]
      Decrypts, checks SHA-256 checksums, and executes a real restore verification in a disposable schema.
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
