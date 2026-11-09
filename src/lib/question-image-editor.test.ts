import 'dotenv/config';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
process.env.NODE_ENV='test';
const enabled=/^postgres(?:ql)?:\/\/[^/]*@(?:localhost|127\.0\.0\.1):/.test(process.env.DATABASE_URL||'');
const {pool}=await import('../db/index.ts');after(()=>pool.end());

test('published questions accept Telegram image edits across MCQ, matching groups and short answers without changing progress', {skip:!enabled},async()=>{
 const {server}=await import('../../tools/local-pdf-tool.ts'),repo=await import('../db/repository.ts');
 const marker=randomUUID(),uid='image-editor-'+marker;
 const [owner]=(await pool.query('SELECT uid FROM public.users WHERE email=$1',[repo.OWNER_ADMIN_EMAIL])).rows;
 if(!owner)await pool.query("INSERT INTO public.users(uid,email,display_name,role) VALUES($1,$2,'Image editor fixture','admin')",[uid,repo.OWNER_ADMIN_EMAIL]);
 const actor={uid:owner?.uid??uid,email:repo.OWNER_ADMIN_EMAIL};
 const [subject]=(await pool.query("INSERT INTO public.subjects(slug,title,description) VALUES($1,$2,'Fixture') RETURNING id",[uid,uid])).rows;
 const [lecture]=(await pool.query("INSERT INTO public.lectures(subject_id,title,description,status) VALUES($1,'Image editing','Fixture','published') RETURNING id",[subject.id])).rows;
 const [other]=(await pool.query("INSERT INTO public.lectures(subject_id,title,description,status) VALUES($1,'Other lecture','Fixture','published') RETURNING id",[subject.id])).rows;
 const {createCanvas}=await import('@napi-rs/canvas');const canvas=createCanvas(32,32);canvas.getContext('2d').fillRect(0,0,32,32);const png=canvas.toBuffer('image/png'),hash=createHash('sha256').update(png).digest('hex');
 const realFetch=globalThis.fetch,oldToken=process.env.TELEGRAM_BOT_TOKEN,oldChannel=process.env.TELEGRAM_CHANNEL_ID;
 process.env.TELEGRAM_BOT_TOKEN='123:test';process.env.TELEGRAM_CHANNEL_ID='fixture';let uploads=0,downloads=0;
 globalThis.fetch=(async(input:any,init:any)=>{const url=String(input);if(url.startsWith('https://api.telegram.org/')){if(url.includes('/sendDocument')){uploads++;return Response.json({ok:true,result:{document:{file_id:'image-editor-'+marker}}});}if(url.includes('/getFile'))return Response.json({ok:true,result:{file_path:'fixture.png'}});downloads++;return new Response(new Uint8Array(png));}return realFetch(input,init);}) as typeof fetch;
 server.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const origin=`http://127.0.0.1:${(server.address() as any).port}`;
 const post=async(body:any,headers:Record<string,string>={})=>{const response=await fetch(origin+'/api/portal/questions',{method:'POST',headers:{'Content-Type':'application/json','X-MedAtlas-Portal':'1',...headers},body:JSON.stringify(body)});return {status:response.status,data:await response.json().catch(()=>null)};};
 const identity={type:'mcq',lectureId:lecture.id};let sessionId:number|undefined;
 try{
  const [mcq]=(await pool.query("INSERT INTO public.questions(subject_id,lecture_id,question_text,option_a,option_b,option_c,option_d,correct_answer,explanation,content_hash) VALUES($1,$2,'Published without photo','A','B','C','D','A','Original explanation',$3) RETURNING *",[subject.id,lecture.id,marker])).rows;
  const matching={groupId:marker,number:'1',prompt:'Match',choices:[{id:'c1',text:'Head'},{id:'c2',text:'Shaft'}],correctChoiceId:'c1'};
  const matches=[];for(const number of ['1','2']){matches.push((await pool.query("INSERT INTO public.questions(subject_id,lecture_id,question_text,option_a,option_b,option_c,option_d,correct_answer,explanation,matching) VALUES($1,$2,$3,'Correct','Wrong','None','None','A','Explanation',$4::jsonb) RETURNING id",[subject.id,lecture.id,'Match label '+number,JSON.stringify({...matching,number})])).rows[0]);}
  const definition={question_text:'Name bone functions',model_answer:'Support and protection',rubric:[{id:'p1',description:'Support',marks:1}],tags:['Bone'],status:'published'};
  const [sa]=(await pool.query("INSERT INTO public.short_answer_questions(lecture_id,definition,content_hash,max_score,status) VALUES($1,$2::jsonb,$3,1,'published') RETURNING *",[lecture.id,JSON.stringify(definition),marker])).rows;
  const savedShort=(await pool.query("INSERT INTO public.short_answer_attempts(user_uid,question_id,answer,answer_hash,snapshot) VALUES($1,$2,'Support',$3,$4::jsonb) RETURNING *",[actor.uid,sa.id,marker,JSON.stringify(definition)])).rows[0];
  const [session]=(await pool.query("INSERT INTO public.exam_sessions(user_uid,title,mode,total_questions,question_order_json) VALUES($1,'Image edit history','study',1,'[]') RETURNING id",[actor.uid])).rows;sessionId=session.id;
  await pool.query("INSERT INTO public.question_attempts(session_id,user_uid,question_id,correct_option_snapshot,question_snapshot_json,selected_option,is_correct) VALUES($1,$2,$3,'A',$4,'A',true)",[session.id,actor.uid,mcq.id,JSON.stringify(mcq)]);
  await pool.query('INSERT INTO public.bookmarks(user_uid,question_id) VALUES($1,$2)',[actor.uid,mcq.id]);
  const before=JSON.stringify((await pool.query('SELECT * FROM public.question_attempts WHERE session_id=$1',[session.id])).rows),bookmarkBefore=JSON.stringify((await pool.query('SELECT * FROM public.bookmarks WHERE question_id=$1',[mcq.id])).rows);
  assert.equal((await post({action:'list',...identity},{'X-MedAtlas-Portal':'0'})).status,403);
  assert.equal((await post({action:'list',...identity},{Origin:'https://foreign.invalid'})).status,403);
  const listing=await post({action:'list',...identity});assert.equal(listing.status,200);assert.equal(listing.data.questions.length,3);assert.equal(listing.data.questions.find((q:any)=>q.id===mcq.id).imageCount,0);assert.equal(uploads,0);
  assert.equal((await post({action:'get',...identity,id:mcq.id,lectureId:other.id})).status,404);
  const opened=await post({action:'get',...identity,id:mcq.id});assert.equal(opened.status,200);assert.deepEqual(opened.data.images,[]);
  const upload=await fetch(origin+'/api/mcq/image?name=bone.png',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-MedAtlas-Portal':'1'},body:new Uint8Array(png)});assert.equal(upload.status,200);const image=await upload.json();assert.equal(image.id,hash);assert.ok(!JSON.stringify(image).includes('telegramFileId'));
  assert.equal((await post({action:'save',...identity,id:mcq.id,revision:opened.data.revision,images:[{...image,source:image.source+'bad'}]})).status,400);
  const saved=await post({action:'save',...identity,id:mcq.id,revision:opened.data.revision,images:[{...image,alt:'Bone figure'}],explanationImages:[image]});assert.equal(saved.status,200,JSON.stringify(saved.data));
  const [after]=(await pool.query('SELECT * FROM public.questions WHERE id=$1',[mcq.id])).rows;assert.equal(after.id,mcq.id);assert.equal(after.status,'published');assert.equal(after.version,2);assert.equal(after.content_hash,marker);assert.equal(after.images[0].id,hash);assert.equal(after.correct_answer,'A');assert.equal(after.explanation,'Original explanation');
  assert.equal(JSON.stringify((await pool.query('SELECT * FROM public.question_attempts WHERE session_id=$1',[session.id])).rows),before);assert.equal(JSON.stringify((await pool.query('SELECT * FROM public.bookmarks WHERE question_id=$1',[mcq.id])).rows),bookmarkBefore);
  assert.equal((await post({action:'save',...identity,id:mcq.id,revision:opened.data.revision,images:[]})).status,409);
  const detail=await post({action:'get',...identity,id:mcq.id});assert.equal(detail.data.images[0].alt,'Bone figure');assert.ok(!JSON.stringify(detail.data).includes('telegramFileId'));
  const bytes=await fetch(origin+'/api/portal/question-image?source='+encodeURIComponent(detail.data.images[0].source));assert.equal(bytes.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await bytes.arrayBuffer()),png);assert.equal(downloads,0,'Fresh uploads are served from the seeded cache.');
  const matchingDetail=(await post({action:'get',...identity,id:matches[0].id})).data;assert.equal(matchingDetail.groupSize,2);assert.equal(matchingDetail.matching,true);
  assert.equal((await post({action:'save',...identity,id:matches[0].id,revision:matchingDetail.revision,images:[]})).status,400);
  assert.equal((await post({action:'save',...identity,id:matches[0].id,revision:matchingDetail.revision,images:[image]})).data.updated,2);
  const shared=(await pool.query('SELECT images,matching FROM public.questions WHERE id=ANY($1::integer[])',[matches.map(q=>q.id)])).rows;assert.ok(shared.every(q=>q.images[0].id===hash));assert.deepEqual(shared.map(q=>q.matching.correctChoiceId),['c1','c1']);
  const shortIdentity={type:'short_answer',lectureId:lecture.id,id:sa.id},saDetail=(await post({action:'get',...shortIdentity})).data;
  assert.equal((await post({action:'save',...shortIdentity,revision:saDetail.revision,images:[image]})).status,200);
  const saAfter=(await pool.query('SELECT * FROM public.short_answer_questions WHERE id=$1',[sa.id])).rows[0];assert.equal(saAfter.content_hash,sa.content_hash);assert.equal(saAfter.status,'published');assert.deepEqual(saAfter.definition.rubric,definition.rubric);assert.equal(saAfter.definition.model_answer,definition.model_answer);assert.equal(saAfter.definition.images[0].id,hash);
  const mirror=(await pool.query('SELECT id FROM public.questions WHERE short_answer_id=$1',[sa.id])).rows[0];const linkedDetail=(await post({action:'get',...identity,id:mirror.id})).data;assert.equal(linkedDetail.type,'short_answer');assert.equal(linkedDetail.id,sa.id);assert.equal(linkedDetail.images[0].id,hash);
  assert.deepEqual((await pool.query('SELECT * FROM public.short_answer_attempts WHERE id=$1',[savedShort.id])).rows[0],savedShort);
  assert.equal(uploads,1,'Image edits reuse Telegram references instead of storing image bytes in PostgreSQL.');
  const reopened=(await post({action:'get',...identity,id:mcq.id})).data;assert.equal((await post({action:'save',...identity,id:mcq.id,revision:reopened.revision,images:[],explanationImages:[]})).status,200,'Regular MCQ images can be removed.');
  const searched=(await post({action:'list',...identity,search:'no match'})).data;assert.equal(searched.questions.length,0);
  await pool.query("INSERT INTO public.questions(subject_id,lecture_id,question_text,option_a,option_b,option_c,option_d,correct_answer,explanation) SELECT $1,$2,'Pagination fixture '||n,'A','B','C','D','A','Explanation' FROM generate_series(1,31) n",[subject.id,lecture.id]);
  const page1=(await post({action:'list',...identity})).data,page2=(await post({action:'list',...identity,after:page1.nextCursor})).data;assert.equal(page1.questions.length,30);assert.equal(page2.questions.length,5);assert.equal(page2.nextCursor,null);assert.equal(new Set([...page1.questions,...page2.questions].map(q=>q.id)).size,35);
  assert.equal((await post({action:'list',...identity,search:'%'})).data.questions.length,0,'Search treats SQL wildcard input as literal text.');
  const {saveQuestionImages}=await import('./question-image-editor.ts');await assert.rejects(()=>saveQuestionImages({uid:'inactive',email:'inactive@example.invalid'},{...identity,id:mcq.id,revision:reopened.revision,images:[]}),/active administrator/);
 }finally{
  globalThis.fetch=realFetch;for(const [key,value] of Object.entries({TELEGRAM_BOT_TOKEN:oldToken,TELEGRAM_CHANNEL_ID:oldChannel})){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  if(sessionId)await pool.query('DELETE FROM public.exam_sessions WHERE id=$1',[sessionId]);await pool.query('DELETE FROM public.admin_audit_logs WHERE action=$1 AND details::jsonb->>\'lectureId\'=$2',['UPDATE_QUESTION_IMAGES',String(lecture.id)]);
  await pool.query('DELETE FROM public.subjects WHERE id=$1',[subject.id]);if(!owner)await pool.query('DELETE FROM public.users WHERE uid=$1',[uid]);
 }
});
