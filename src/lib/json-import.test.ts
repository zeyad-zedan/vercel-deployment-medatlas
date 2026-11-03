import 'dotenv/config';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseAndValidateJsonQuestions, getSampleJsonTemplate } from './json-import.ts';
import { imageForClient, imageForStorage, inspectQuestionImage, protectQuestionImageFields, fetchQuestionImage, uploadQuestionImage } from './telegram-question-images.ts';
import { formatQuestionForClient } from './mcq-engine.ts';

const hash='a'.repeat(64), manifest=[{name:'cell-diagram.png',id:hash}];
test('JSON supports arrays, lecture defaults, Arabic tags, multiline explanations and four options',()=>{
  const root=JSON.parse(getSampleJsonTemplate());root.questions[0].explanation='Line one\nشرح بالعربية';
  root.questions[0].special_tags=['Important','important','كتاب القسم'];
  const report=parseAndValidateJsonQuestions(JSON.stringify(root));
  assert.equal(report.validCount,1);assert.equal(report.rows[0].specialTags,'Important, كتاب القسم');
  assert.equal(report.rows[0].explanation,'Line one\nشرح بالعربية');
  const q=root.questions[0];delete q.subject;delete q.lecture;q.options=Object.values(q.options);
  const defaults=parseAndValidateJsonQuestions(JSON.stringify([q]),new Set(),{defaultSubject:'Anatomy',defaultLecture:'Head'});
  assert.equal(defaults.validCount,1);assert.equal(defaults.rows[0].lecture,'Head');
});
test('JSON rejects malformed values, unknown fields, links, missing files, duplicate filenames and oversized batches',()=>{
  assert.ok(parseAndValidateJsonQuestions('{bad').headerErrors.length);
  for(const mutation of [
    (q:any)=>q.options.A={}, (q:any)=>q.correct_answer='E', (q:any)=>q.question_text=42,
    (q:any)=>q.explanaton='typo',(q:any)=>q.images=['https://example.org/a.png'],
    (q:any)=>q.images=['absent.png'],(q:any)=>q.tags=[false],(q:any)=>q.page_number='3',
  ]){
    const root=JSON.parse(getSampleJsonTemplate());mutation(root.questions[0]);
    assert.equal(parseAndValidateJsonQuestions(JSON.stringify(root)).invalidCount,1);
  }
  assert.ok(parseAndValidateJsonQuestions(getSampleJsonTemplate(),new Set(),undefined,[...manifest,...manifest]).headerErrors.length);
  assert.ok(parseAndValidateJsonQuestions(JSON.stringify(Array(2001).fill({}))).headerErrors.length);
});
test('JSON validates image matching before upload and includes actual image content in duplicate detection',()=>{
  const root=JSON.parse(getSampleJsonTemplate(true));root.questions[0].explanation_images=['cell-diagram.png'];
  const first=parseAndValidateJsonQuestions(JSON.stringify(root),new Set(),undefined,manifest);
  assert.equal(first.validCount,1);assert.deepEqual(first.referencedImages,['cell-diagram.png']);
  assert.equal(first.rows[0].rowNumber,1);
  const duplicate=parseAndValidateJsonQuestions(JSON.stringify(root),new Set([first.rows[0].contentHash]),undefined,manifest);
  assert.equal(duplicate.duplicateCount,1);
  const other=parseAndValidateJsonQuestions(JSON.stringify(root),new Set([first.rows[0].contentHash]),undefined,[{name:'cell-diagram.png',id:'b'.repeat(64)}]);
  assert.equal(other.validCount,1);
  const renamed=JSON.stringify(root).replaceAll('cell-diagram.png','renamed.png');
  assert.equal(parseAndValidateJsonQuestions(renamed,new Set([first.rows[0].contentHash]),undefined,[{name:'renamed.png',id:hash}]).duplicateCount,1);
});
test('opaque image references hide Telegram credentials, reject tampering and preserve snapshot references',()=>{
  const image={id:hash,alt:'Cell figure',telegramFileId:'private-file-identifier',mimeType:'image/png',fileSize:123};
  const client=imageForClient(image);assert.ok(client.source?.startsWith('/api/question-images/'));
  assert.ok(!JSON.stringify(client).includes('private-file-identifier'));
  assert.deepEqual(imageForStorage(client),image);
  assert.throws(()=>imageForStorage({...client,id:'b'.repeat(64)}));
  assert.throws(()=>imageForStorage({...client,source:client.source!.slice(0,-8)+'AAAAAAAA'}));
  const safe=protectQuestionImageFields({images:[image],questionSnapshotJson:JSON.stringify({images:[image]})});
  assert.ok(!JSON.stringify(safe).includes('private-file-identifier'));
  assert.equal(safe.images[0].source,JSON.parse(safe.questionSnapshotJson).images[0].source);
});
test('active exams include question figures but never explanation figures',()=>{
  const q:any={id:1,optionA:'A',optionB:'B',optionC:'C',optionD:'D',correctAnswer:'A',images:[{id:'stem'}],explanationImages:[{id:'answer'}]};
  const permutation={A:'A',B:'B',C:'C',D:'D'} as const;
  const exam=formatQuestionForClient(q,permutation,true);
  assert.deepEqual(exam.images,[{id:'stem'}]);assert.equal('explanationImages' in exam,false);
  assert.deepEqual(formatQuestionForClient(q,permutation,false).explanationImages,[{id:'answer'}]);
});
test('Telegram images upload once, download once concurrently, validate bytes, and reject unsafe formats',async()=>{
  const {createCanvas}=await import('@napi-rs/canvas');
  const canvas=createCanvas(10,10);const ctx=canvas.getContext('2d');ctx.fillRect(0,0,10,10);
  const bytes=canvas.toBuffer('image/png');assert.equal(inspectQuestionImage(bytes),'image/png');
  assert.throws(()=>inspectQuestionImage(Buffer.from('<svg onload="evil"/>')));
  const huge=Buffer.from(bytes);huge.writeUInt32BE(100000,16);assert.throws(()=>inspectQuestionImage(huge));
  const oldFetch=globalThis.fetch,oldToken=process.env.TELEGRAM_BOT_TOKEN,oldChannel=process.env.TELEGRAM_CHANNEL_ID;
  let uploads=0,lookups=0,downloads=0;
  process.env.TELEGRAM_BOT_TOKEN='123:test';process.env.TELEGRAM_CHANNEL_ID='test-channel';
  globalThis.fetch=(async(input:any,init:any)=>{
    const url=String(input);
    if(url.endsWith('/sendDocument')){uploads++;assert.ok(init.body instanceof FormData);return Response.json({ok:true,result:{document:{file_id:'test-question-image'}}});}
    if(url.includes('/getFile?')){lookups++;return Response.json({ok:true,result:{file_path:'images/test.png'}});}
    downloads++;return new Response(new Uint8Array(bytes),{headers:{'content-type':'image/png'}});
  }) as typeof fetch;
  try{
    const [a,b]=await Promise.all([uploadQuestionImage('cell.png',bytes),uploadQuestionImage('renamed.png',bytes)]);
    assert.equal(uploads,1);assert.equal(a.id,createHash('sha256').update(bytes).digest('hex'));assert.deepEqual(a,b);
    const [first,second]=await Promise.all([fetchQuestionImage(a),fetchQuestionImage(a)]);
    assert.deepEqual(first,bytes);assert.deepEqual(first,second);assert.equal(downloads,1);assert.equal(lookups,1);
    await fetchQuestionImage(a);assert.equal(downloads,1);
    await assert.rejects(fetchQuestionImage({...a,id:'f'.repeat(64)}),/integrity/);
  }finally{
    globalThis.fetch=oldFetch;
    if(oldToken===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=oldToken;
    if(oldChannel===undefined)delete process.env.TELEGRAM_CHANNEL_ID;else process.env.TELEGRAM_CHANNEL_ID=oldChannel;
  }
});
