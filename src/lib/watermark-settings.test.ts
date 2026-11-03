import 'dotenv/config';
import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {eq,inArray} from 'drizzle-orm';

process.env.NODE_ENV='test';
const {db,pool,users,appSettings,adminAuditLogs}=await import('../db/index.ts');
const {getDocumentSecuritySettings}=await import('../db/repository.ts');
const {createServerSessionToken}=await import('../middleware/auth.ts');
const {app}=await import('../../server.ts');
after(async()=>{await pool.end();});

test('settings survive backup restoration while older backups remain compatible',async()=>{
  const {createEncryptedBackup,decryptBackupPayload,testRestoreBackup,BACKUP_FORMAT_VERSION}=await import('./backup-service.ts');
  const tableNames=['users','modules','subjects','lectures','lectureFiles','questionBanks','questions','examSessions','questionAttempts','bookmarks','importBatches','adminAuditLogs','deletedAccounts','passwordResetTokens','rateLimitBuckets'];
  const tables=Object.fromEntries(tableNames.map(name=>[name,[]]));
  const legacy:any={format:BACKUP_FORMAT_VERSION,createdAt:new Date().toISOString(),database:'postgresql',tables};
  const encryptionKeySecret='watermark-backup-regression-secret-minimum-32-characters';
  const old=await createEncryptedBackup({snapshotOverride:legacy,encryptionKeySecret});
  assert.equal(decryptBackupPayload(old.envelope,old.key).tables.appSettings,undefined);
  const current={...legacy,tables:{...tables,appSettings:[{key:'pdf_watermarks_enabled',boolean_value:true,updated_by:null,updated_at:new Date().toISOString()}]}};
  const backup=await createEncryptedBackup({snapshotOverride:current,encryptionKeySecret});
  const result=await testRestoreBackup(backup.envelope,{encryptionKeySecret});
  assert.equal(result.status,'verified',result.error);
  assert.equal(result.tableCounts.appSettings,1);
});

test('only admins can persist watermark changes, and turning them off preserves protected PDF delivery',async()=>{
  const previous=await getDocumentSecuritySettings();
  const id=`watermark-test-${Date.now()}`;
  const fixtures=[{uid:id+'-admin',email:id+'-admin@example.test',displayName:'Settings test admin',role:'admin',emailVerified:true},
    {uid:id+'-student',email:id+'-student@example.test',displayName:'Settings test student',role:'student',emailVerified:true}];
  await db.insert(users).values(fixtures);
  const token=(index:number)=>createServerSessionToken({...fixtures[index],name:fixtures[index].displayName,tokenVersion:1,authType:'local'});
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const origin=`http://127.0.0.1:${(server.address() as any).port}`;
  const update=(body:unknown,auth?:string)=>fetch(origin+'/api/admin/document-security',{method:'PUT',headers:{'Content-Type':'application/json',...(auth?{Authorization:`Bearer ${auth}`}:{})},body:JSON.stringify(body)});
  try {
    assert.equal((await update({watermarksEnabled:true})).status,401);
    assert.equal((await update({watermarksEnabled:true},token(1))).status,403);
    assert.equal((await update({watermarksEnabled:'false'},token(0))).status,400);
    const enabled=await update({watermarksEnabled:true},token(0));
    assert.equal(enabled.status,200);assert.deepEqual(await enabled.json(),{documentSecurity:{watermarksEnabled:true}});
    assert.equal((await getDocumentSecuritySettings()).watermarksEnabled,true);
    const [stored]=await db.select().from(appSettings).where(eq(appSettings.key,'pdf_watermarks_enabled'));
    assert.equal(stored.booleanValue,true);assert.equal(stored.updatedBy,fixtures[0].uid);
    const disabled=await update({watermarksEnabled:false},token(0));
    assert.equal(disabled.status,200);assert.equal((await getDocumentSecuritySettings()).watermarksEnabled,false);
    assert.equal((await fetch(origin+'/lectures/anything.pdf')).status,410);
    const logs=await db.select({action:adminAuditLogs.action}).from(adminAuditLogs).where(eq(adminAuditLogs.adminUid,fixtures[0].uid));
    assert.equal(logs.length,2);
  } finally {
    await db.update(appSettings).set({booleanValue:previous.watermarksEnabled,updatedBy:null}).where(eq(appSettings.key,'pdf_watermarks_enabled'));
    await db.delete(adminAuditLogs).where(eq(adminAuditLogs.adminUid,fixtures[0].uid));
    await db.delete(users).where(inArray(users.uid,fixtures.map(f=>f.uid)));
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
});
