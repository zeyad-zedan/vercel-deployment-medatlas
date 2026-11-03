import 'dotenv/config';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getSampleJsonTemplate } from './json-import.ts';

process.env.NODE_ENV='test';
const enabled=/^postgres(?:ql)?:\/\/[^/]*@(?:localhost|127\.0\.0\.1):/.test(process.env.DATABASE_URL || '');
const {db,pool,users,subjects,lectures,questions,examSessions,bookmarks,importBatches,adminAuditLogs}=await import('../db/index.ts');
after(async()=>{await pool.end();});

test('JSON + Telegram import roundtrips through API, sessions, review, bookmarks and encrypted backups', {skip:!enabled}, async()=>{
  const repo=await import('../db/repository.ts');await repo.ensureSeededDatabase();
  const {app}=await import('../../server.ts');
  const {createServerSessionToken}=await import('../middleware/auth.ts');
  const marker=randomUUID(),adminUid='json-admin-'+marker,studentUid='json-student-'+marker;
  const [subject]=await db.insert(subjects).values({slug:'json-test-'+marker,title:'JSON import test '+marker,description:'Disposable tests'}).returning();
  const [lecture]=await db.insert(lectures).values({subjectId:subject.id,title:'Image questions',description:'Disposable tests'}).returning();
  await db.insert(users).values([{uid:adminUid,email:adminUid+'@example.invalid',displayName:'JSON admin',role:'admin'}, {uid:studentUid,email:studentUid+'@example.invalid',displayName:'JSON student'}]);
  const token=(uid:string)=>createServerSessionToken({uid,email:uid+'@example.invalid',authType:'local',emailVerified:true});
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  const origin=`http://127.0.0.1:${(server.address() as any).port}`;
  const fetchReal=globalThis.fetch,oldToken=process.env.TELEGRAM_BOT_TOKEN,oldChannel=process.env.TELEGRAM_CHANNEL_ID;
  const {createCanvas}=await import('@napi-rs/canvas');const canvas=createCanvas(32,32);canvas.getContext('2d').fillRect(0,0,32,32);const png=canvas.toBuffer('image/png');
  const digest=createHash('sha256').update(png).digest('hex');
  let telegramUploads=0,telegramDownloads=0;
  process.env.TELEGRAM_BOT_TOKEN='123:test';process.env.TELEGRAM_CHANNEL_ID='test-channel';
  globalThis.fetch=(async(input:any,options?:any)=>{
    const url=String(input);
    if(url.startsWith('https://api.telegram.org/')){
      if(url.endsWith('/sendDocument')){telegramUploads++;return Response.json({ok:true,result:{document:{file_id:'integration-'+marker}}});}
      if(url.includes('/getFile?'))return Response.json({ok:true,result:{file_path:'images/test.png'}});
      telegramDownloads++;return new Response(new Uint8Array(png),{headers:{'content-type':'image/png'}});
    }
    return fetchReal(input,options);
  }) as typeof fetch;
  const request=(route:string,uid:string|null=adminUid,body?:any)=>fetch(origin+route,{method:body===undefined?'GET':'POST',headers:{...(uid?{Authorization:'Bearer '+token(uid)}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  const jsonRequest=async(route:string,uid:string,body?:any)=>{const response=await request(route,uid,body);const data=await response.json();assert.ok(response.ok,JSON.stringify(data));return data;};
  try{
    assert.equal((await request('/api/admin/import/preview',studentUid,{jsonContent:getSampleJsonTemplate()})).status,403);
    const root=JSON.parse(getSampleJsonTemplate(true));root.questions[0].explanation_images=['cell-diagram.png'];
    const jsonContent=JSON.stringify(root), imageFiles=[{name:'cell-diagram.png',id:digest}];
    const payload={jsonContent,targetLectureId:lecture.id,imageFiles};
    const preview=await jsonRequest('/api/admin/import/preview',adminUid,payload);assert.equal(preview.validCount,1);
    const noImage=await request('/api/admin/import/execute',adminUid,payload);assert.equal(noImage.status,400);
    assert.equal((await db.select().from(questions).where(eq(questions.lectureId,lecture.id))).length,0);
    const upload=await fetch(origin+'/api/admin/import/image?name=cell-diagram.png',{method:'POST',headers:{Authorization:'Bearer '+token(adminUid),'Content-Type':'application/octet-stream'},body:new Uint8Array(png)});
    assert.equal(upload.status,200);const image=await upload.json();assert.ok(image.source);assert.equal(image.telegramFileId,undefined);
    const results=await Promise.all([request('/api/admin/import/execute',adminUid,{...payload,uploadedImages:{'cell-diagram.png':image},rowOverrides:{1:{specialTags:'كتاب القسم, Important'}}}),request('/api/admin/import/execute',adminUid,{...payload,uploadedImages:{'cell-diagram.png':image}})]);
    assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.filter(r=>r.status===409).length,1);
    const [stored]=await db.select().from(questions).where(eq(questions.lectureId,lecture.id));assert.equal(stored.images[0].id,digest);assert.ok(stored.images[0].telegramFileId);assert.ok(JSON.stringify(stored.images).length<1000);
    const study=await jsonRequest('/api/sessions',studentUid,{mode:'study',lectureIds:[lecture.id],requestedCount:1});
    const q=study.session.questions[0];assert.ok(q.images[0].source);assert.ok(q.explanationImages[0].source);assert.ok(!JSON.stringify(q).includes('integration-'+marker));
    assert.equal(telegramDownloads,0,'Starting the session returns references; its client preloader requests image bytes.');
    assert.equal((await request(q.images[0].source,null)).status,401);
    assert.equal((await request(q.images[0].source+'tampered',studentUid)).status,404);
    const imageResponse=await request(q.images[0].source,studentUid);assert.equal(imageResponse.status,200);assert.match(imageResponse.headers.get('cache-control')!,/no-store/);assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()),png);
    await request(q.images[0].source,studentUid);assert.equal(telegramDownloads,1);assert.equal(telegramUploads,1);
    await jsonRequest('/api/bookmarks/toggle',studentUid,{questionId:q.id,bookmarked:true});
    const saved=await jsonRequest('/api/bookmarks?view=saved',studentUid);assert.equal(saved.bookmarks[0].images[0].id,digest);
    await jsonRequest(`/api/sessions/${study.session.id}/answer`,studentUid,{questionId:q.id,selectedOption:'B',lockAnswer:true,slim:true});
    const completed=await jsonRequest(`/api/sessions/${study.session.id}/complete`,studentUid,{elapsedSeconds:10});assert.equal(completed.session.questions[0].images[0].id,digest);
    const mock=await jsonRequest('/api/sessions',studentUid,{mode:'exam',lectureIds:[lecture.id],requestedCount:1});
    assert.equal('explanationImages' in mock.session.questions[0],false);
    const reviewed=await jsonRequest(`/api/sessions/${mock.session.id}/complete`,studentUid,{answers:[{questionId:q.id,selectedOption:'B'}],elapsedSeconds:10});assert.equal(reviewed.session.questions[0].explanationImages[0].id,digest);
    const {createEncryptedBackup,testRestoreBackup}=await import('./backup-service.ts');
    const {envelope}=await createEncryptedBackup();assert.equal((await testRestoreBackup(envelope)).status,'verified');
    // Stored reference metadata survives archived/deleted content in historical attempt snapshots.
    await db.delete(questions).where(eq(questions.id,q.id));
    const historic=await jsonRequest(`/api/sessions/${study.session.id}`,studentUid);assert.equal(historic.session.questions[0].images[0].id,digest);
  }finally{
    globalThis.fetch=fetchReal;
    if(oldToken===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=oldToken;
    if(oldChannel===undefined)delete process.env.TELEGRAM_CHANNEL_ID;else process.env.TELEGRAM_CHANNEL_ID=oldChannel;
    await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    await db.delete(bookmarks).where(eq(bookmarks.userUid,studentUid));
    await db.delete(examSessions).where(eq(examSessions.userUid,studentUid));
    await db.delete(adminAuditLogs).where(eq(adminAuditLogs.adminUid,adminUid));await db.delete(importBatches).where(eq(importBatches.adminUid,adminUid));
    await db.delete(subjects).where(eq(subjects.id,subject.id));
    await db.delete(users).where(eq(users.uid,studentUid));await db.delete(users).where(eq(users.uid,adminUid));
  }
});
