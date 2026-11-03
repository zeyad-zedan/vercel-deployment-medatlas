import 'dotenv/config';
import { test,after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { and,eq,inArray,like } from 'drizzle-orm';
import { getSampleJsonTemplate } from './json-import.ts';

process.env.NODE_ENV='test';
const enabled=/^postgres(?:ql)?:\/\/[^/]*@(?:localhost|127\.0\.0\.1):/.test(process.env.DATABASE_URL || '');
const {db,pool,subjects,lectures,users,questions,importBatches,adminAuditLogs,lectureFiles}=await import('../db/index.ts');
after(async()=>{await pool.end();});

test('bot portal opens without login and supports JSON, Telegram figures, tags, draft defaults and repeated import protection', {skip:!enabled},async()=>{
  const {server}=await import('../../tools/local-pdf-tool.ts');
  const {OWNER_ADMIN_EMAIL}=await import('../db/repository.ts');
  const marker=randomUUID(),uid='portal-test-'+marker;
  const [existing]=await db.select().from(users).where(eq(users.email,OWNER_ADMIN_EMAIL));
  if(!existing)await db.insert(users).values({uid,email:OWNER_ADMIN_EMAIL,displayName:'Portal test owner',role:'admin'});
  const [subject]=await db.insert(subjects).values({slug:uid,title:'Portal test '+marker,description:'Disposable test'}).returning();
  const [lecture]=await db.insert(lectures).values({subjectId:subject.id,title:'Upload portal fixture',description:'Disposable test'}).returning();
  const oldKey=process.env.ILOVEPDF_PUBLIC_KEY,oldToken=process.env.TELEGRAM_BOT_TOKEN,oldChannel=process.env.TELEGRAM_CHANNEL_ID;
  const compressionKey='test-only-compression-key-'+marker;
  process.env.ILOVEPDF_PUBLIC_KEY=compressionKey;process.env.TELEGRAM_BOT_TOKEN='123:test';process.env.TELEGRAM_CHANNEL_ID='test-channel';
  const realFetch=globalThis.fetch;
  const {createCanvas}=await import('@napi-rs/canvas');const canvas=createCanvas(24,24),ctx=canvas.getContext('2d');ctx.fillStyle='#'+marker.replaceAll('-','').slice(0,6);ctx.fillRect(0,0,24,24);const png=canvas.toBuffer('image/png');
  const {buildSimpleMultiPagePdf}=await import('./pdf-generator.ts');
  const pdf=buildSimpleMultiPagePdf({title:'Portal PDF test',module:'Fixture',lectureNumber:1,pages:[{pageNumber:1,heading:'Test slide',bulletPoints:['Disposable PDF upload fixture.']}]});
  let uploads=0;
  globalThis.fetch=(async(input:any,options?:any)=>{
    if(String(input).startsWith('https://api.telegram.org/')){
      uploads++;return Response.json({ok:true,result:{document:{file_id:'portal-image-'+marker}}});
    }
    const url=String(input);
    if(url==='https://api.ilovepdf.com/v1/auth'){assert.equal(JSON.parse(options.body).public_key,compressionKey);return Response.json({token:'test-compression-session'});}
    if(url==='https://api.ilovepdf.com/v1/start/compress')return Response.json({server:'compress.example.invalid',task:'test-task'});
    if(url.includes('compress.example.invalid/v1/upload'))return Response.json({server_filename:'uploaded-fixture.pdf'});
    if(url.includes('compress.example.invalid/v1/process'))return Response.json({status:'TaskSuccess'});
    if(url.includes('compress.example.invalid/v1/download/'))return new Response(new Uint8Array(pdf),{headers:{'content-type':'application/pdf'}});
    if(url==='https://api.ilovepdf.com/v1/info')return Response.json({remaining_credits:500});
    return realFetch(input,options);
  }) as typeof fetch;
  server.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  const origin=`http://127.0.0.1:${(server.address() as any).port}`;
  const request=(path:string,body?:unknown,headers:Record<string,string>={})=>fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json','X-MedAtlas-Portal':'1'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const batches:number[]=[];
  try {
    assert.equal((await fetch(origin+'/mcqs')).status,200);
    assert.equal((await fetch(origin+'/api/mcq/lectures')).status,200);
    const page=await request('/mcqs');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy')!,/script-src 'self'/);
    const html=await page.text();assert.match(html,/Save as draft/);assert.match(html,/Preview &amp; tagging/);
    const pdfPage=await request('/');assert.equal(pdfPage.headers.get('www-authenticate'),null);assert.match(await pdfPage.text(),/Upload PDFs/);
    const pdfBundle=await request('/pdf-assets/client.js');assert.equal(pdfBundle.status,200);assert.ok(!(await pdfBundle.text()).includes(compressionKey));
    const catalog=await(await request('/api/lectures')).json();assert.equal(catalog.compressionConfigured,true);assert.equal(catalog.defaultPublicKey,undefined);assert.ok(!JSON.stringify(catalog).includes(compressionKey));
    const bundle=await request('/mcq-assets/client.js');assert.equal(bundle.status,200);const js=await bundle.text();assert.ok(js.length>5000);assert.ok(!js.includes(compressionKey));
    assert.equal((await request('/api/mcq/template')).status,200);
    assert.equal((await request('/api/mcq/image-example')).headers.get('content-type'),'application/zip');
    assert.ok((await(await request('/api/mcq/lectures')).json()).lectures.some((l:any)=>l.id===lecture.id));
    assert.equal((await request('/api/mcq/preview',{}, {'X-MedAtlas-Portal':'0'})).status,403);
    assert.equal((await request('/api/mcq/preview',{}, {Origin:'https://other.invalid'})).status,403);
    assert.equal((await request('/api/mcq/preview')).status,405);
    const root=JSON.parse(getSampleJsonTemplate(true));root.questions[0].question_text+=' '+marker;
    const payload={fileName:marker+'.json',jsonContent:JSON.stringify(root),targetLectureId:lecture.id,imageFiles:[{name:'cell-diagram.png',id:createHash('sha256').update(png).digest('hex')}]};
    const preview=await(await request('/api/mcq/preview',payload)).json();assert.equal(preview.validCount,1);assert.equal(preview.rows[0].status,'draft');
    assert.equal((await request('/api/mcq/execute',payload)).status,400,'Missing Telegram upload cannot create incomplete questions.');
    const oversized=await fetch(origin+'/api/mcq/image?name=large.png',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-MedAtlas-Portal':'1'},body:new Uint8Array(2*1024*1024+1)});assert.equal(oversized.status,413);
    const upload=await fetch(origin+'/api/mcq/image?name=cell-diagram.png',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-MedAtlas-Portal':'1'},body:new Uint8Array(png)});
    assert.equal(upload.status,200);const image=await upload.json();assert.equal(image.telegramFileId,undefined);assert.ok(image.source);
    const imported=await request('/api/mcq/execute',{...payload,uploadedImages:{'cell-diagram.png':image},rowOverrides:{1:{specialTags:'Important, كتاب القسم',tags:'Anatomy, Cell biology'}}});
    const result=await imported.json();assert.equal(imported.status,200,JSON.stringify(result));batches.push(result.batch.id);
    assert.equal(uploads,1);assert.equal(result.batch.importedCount,1);
    const [stored]=await db.select().from(questions).where(eq(questions.lectureId,lecture.id));assert.equal(stored.status,'draft');assert.equal(stored.images[0].id,image.id);assert.equal(stored.specialTags,'Important, كتاب القسم');assert.equal(stored.tags,'Anatomy, Cell biology');
    assert.ok(!JSON.stringify(result).includes('portal-image-'+marker));
    assert.equal((await request('/api/mcq/execute',{...payload,uploadedImages:{'cell-diagram.png':image}})).status,409);
    const text=JSON.parse(getSampleJsonTemplate());text.questions[0].question_text+=' '+marker;
    const textImport=await request('/api/mcq/execute',{jsonContent:JSON.stringify(text),fileName:marker+'-text.json',targetLectureId:lecture.id,publication:'json'});
    assert.equal(textImport.status,200);batches.push((await textImport.json()).batch.id);
    assert.equal(uploads,1,'Text-only imports do not contact Telegram.');
    const published=await db.select().from(questions).where(and(eq(questions.lectureId,lecture.id),eq(questions.status,'published')));assert.equal(published.length,1);

    const form=new FormData();form.append('lectureId',String(lecture.id));form.append('file',new Blob([new Uint8Array(pdf)],{type:'application/pdf'}),marker+'.pdf');form.append('compress','true');
    const attached=await fetch(origin+'/api/upload',{method:'POST',body:form});const attachment=await attached.json();assert.equal(attached.status,200,JSON.stringify(attachment));
    assert.equal(attachment.compression.usedCompression,true);assert.equal(attachment.compression.compressedBuffer,undefined);assert.ok(JSON.stringify(attachment).length<10000,'Upload confirmations must not echo PDF bytes.');
    assert.equal(uploads,2);assert.equal((await request('/lectures/blocked.pdf')).status,410);
    const [file]=await db.select().from(lectureFiles).where(eq(lectureFiles.fileName,attachment.fileName));assert.ok(file.telegramFileId);assert.equal(file.dataBase64,'');
    await db.delete(lectureFiles).where(eq(lectureFiles.id,file.id));
  } finally {
    globalThis.fetch=realFetch;
    await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    for(const [key,value] of Object.entries({ILOVEPDF_PUBLIC_KEY:oldKey,TELEGRAM_BOT_TOKEN:oldToken,TELEGRAM_CHANNEL_ID:oldChannel})){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    await db.delete(adminAuditLogs).where(like(adminAuditLogs.details,'%'+marker+'%'));
    if(batches.length)await db.delete(importBatches).where(inArray(importBatches.id,batches));
    await db.delete(subjects).where(eq(subjects.id,subject.id));
    if(!existing)await db.delete(users).where(eq(users.uid,uid));
  }
});
