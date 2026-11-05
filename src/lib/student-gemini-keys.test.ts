import 'dotenv/config';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {eq,inArray,sql} from 'drizzle-orm';
process.env.NODE_ENV='test';
process.env.STUDENT_API_KEY_ENCRYPTION_KEY=randomBytes(32).toString('hex');
const {db,pool,users,studentGeminiKeys}=await import('../db/index.ts');
const keys=await import('./student-gemini-keys.ts');
after(()=>pool.end());

test('key input supports long authorization keys without assuming a provider prefix or fixed length',()=>{
 for(const value of ['AIza'+'A'.repeat(35),'AQ.'+'B'.repeat(300),'new-format.'+'C'.repeat(80)])assert.equal(keys.validStudentGeminiKey(value),true);
 for(const value of ['',null,123,'short','AQ.'+'B'.repeat(4096),'AQ.'+'B'.repeat(30)+'\r\nheader:value','GEMINI_API_KEY='+'A'.repeat(50),'"AQ.'+'B'.repeat(100)+'"'])assert.equal(keys.validStudentGeminiKey(value),false);
});
test('student secrets use randomized authenticated encryption bound to their account',()=>{
 const value='AIza'+randomBytes(26).toString('base64url').slice(0,35);
 assert.equal(keys.validStudentGeminiKey(value),true);assert.equal(keys.validStudentGeminiKey('not-a-key'),false);
 const encrypted=keys.encryptStudentGeminiKey('student-one',value);
 assert.notEqual(encrypted,keys.encryptStudentGeminiKey('student-one',value));assert.ok(!encrypted.includes(value));
 assert.equal(keys.decryptStudentGeminiKey('student-one',encrypted),value);
 assert.throws(()=>keys.decryptStudentGeminiKey('student-two',encrypted));
 const parts=encrypted.split('.');parts[3]=Buffer.from('tampered').toString('base64url');
 assert.throws(()=>keys.decryptStudentGeminiKey('student-one',parts.join('.')));
 const secret=process.env.STUDENT_API_KEY_ENCRYPTION_KEY;delete process.env.STUDENT_API_KEY_ENCRYPTION_KEY;
 assert.equal(keys.studentKeyStorageAvailable(),false);assert.throws(()=>keys.encryptStudentGeminiKey('student-one',value));
 process.env.STUDENT_API_KEY_ENCRYPTION_KEY=secret;
});
test('authenticated key save/replace/remove persists per account without exposing secrets and survives backup restore', {skip:!/^postgres(?:ql)?:\/\/[^/]*@(?:localhost|127\.0\.0\.1):/.test(process.env.DATABASE_URL||'')},async()=>{
 const {createServerSessionToken}=await import('../middleware/auth.ts');
 const {app}=await import('../../server.ts');
 const uid='key-test-'+randomUUID(),other=uid+'-other';
 const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
 const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 const token=(id:string)=>createServerSessionToken({uid:id,email:id+'@example.invalid',emailVerified:true});
 const request=(id:string|null,method='GET',body?:any)=>fetch(origin+'/api/auth/gemini-key',{method,headers:{...(id?{Authorization:`Bearer ${token(id)}`} : {}),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 const key='AIza'+randomBytes(26).toString('base64url').slice(0,35),replacement='AQ.'+randomBytes(240).toString('base64url');
 try{
  await db.insert(users).values([uid,other].map(id=>({uid:id,email:id+'@example.invalid',displayName:'Disposable key test'})));
  assert.equal((await request(null)).status,401);
  assert.equal((await request(uid,'PUT',{apiKey:'invalid'})).status,400);
  const saved=await request(uid,'PUT',{apiKey:key,userUid:other});assert.equal(saved.status,200);assert.equal(saved.headers.get('cache-control'),'no-store');
  const response=await saved.text();assert.ok(!response.includes(key));assert.ok(!response.includes('encryptedKey'));assert.equal(JSON.parse(response).configured,true);
  assert.equal((await(await request(other)).json()).configured,false,'body-supplied owner must be ignored');
  const [row]=await db.select().from(studentGeminiKeys).where(eq(studentGeminiKeys.userUid,uid));
  assert.ok(!JSON.stringify(row).includes(key));assert.equal(await keys.readStudentGeminiKeyForGrading(uid),key);
  assert.equal((await(await request(uid)).json()).maskedKey,'••••'+key.slice(-4));
  assert.equal((await request(uid,'PUT',{apiKey:'  '+replacement+'\n'})).status,200);assert.equal(await keys.readStudentGeminiKeyForGrading(uid),replacement);
  const {createEncryptedBackup,testRestoreBackup}=await import('./backup-service.ts');
  const {envelope}=await createEncryptedBackup();assert.equal((await testRestoreBackup(envelope)).status,'verified');
  const secret=process.env.STUDENT_API_KEY_ENCRYPTION_KEY;delete process.env.STUDENT_API_KEY_ENCRYPTION_KEY;
  assert.equal((await request(uid,'PUT',{apiKey:key})).status,503);
  assert.equal((await request(uid,'DELETE')).status,200,'removal must work without the encryption secret');
  process.env.STUDENT_API_KEY_ENCRYPTION_KEY=secret;
  assert.equal((await(await request(uid)).json()).configured,false);assert.equal(await keys.readStudentGeminiKeyForGrading(uid),null);
  await keys.saveStudentGeminiKey(other,key);await db.delete(users).where(eq(users.uid,other));
  assert.equal((await db.select().from(studentGeminiKeys).where(eq(studentGeminiKeys.userUid,other))).length,0,'account deletion removes credentials');
  const security=await db.execute(sql`select relrowsecurity from pg_class where oid='public.student_gemini_keys'::regclass`);assert.equal(security.rows[0].relrowsecurity,true);
 }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await db.delete(users).where(inArray(users.uid,[uid,other]));}
});
