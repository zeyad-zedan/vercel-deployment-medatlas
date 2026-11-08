import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomBytes,createCipheriv} from 'node:crypto';
import {protectedImageCache} from './protected-image-cache.ts';

test('encrypted image cache survives an upstream outage and rejects corrupt or mismatched bytes',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'medatlas-image-test-')),previous=process.env.AUTH_SESSION_SECRET;
 process.env.AUTH_SESSION_SECRET='isolated_image_cache_test_secret_at_least_32';
 const bytes=Buffer.from('isolated image fixture'),id=createHash('sha256').update(bytes).digest('hex');
 const image={id,alt:'Fixture',fileSize:bytes.length};
 try{
  const key=createHash('sha256').update('medatlas-image-cache-v1:'+process.env.AUTH_SESSION_SECRET).digest(),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
  const data=Buffer.concat([cipher.update(bytes),cipher.final()]),file=path.join(directory,id+'.bin');
  await writeFile(file,Buffer.concat([iv,cipher.getAuthTag(),data]));
  assert.deepEqual(await protectedImageCache(image,directory),bytes);
  assert.equal(await protectedImageCache({...image,fileSize:bytes.length+1},directory),null);
  process.env.AUTH_SESSION_SECRET='different_isolated_secret_at_least_32_characters';
  assert.equal(await protectedImageCache(image,directory),null);
  process.env.AUTH_SESSION_SECRET='isolated_image_cache_test_secret_at_least_32';
  data[0]^=1;await writeFile(file,Buffer.concat([iv,cipher.getAuthTag(),data]));
  assert.equal(await protectedImageCache(image,directory),null);
  assert.equal(await protectedImageCache({...image,id:'../unsafe'},directory),null);
 }finally{if(previous===undefined)delete process.env.AUTH_SESSION_SECRET;else process.env.AUTH_SESSION_SECRET=previous;await unlink(path.join(directory,id+'.bin')).catch(error=>{if(error.code!=='ENOENT')throw error;});await rmdir(directory);}
});

test('new uploads seed the bounded image cache so previews do not immediately redownload from Telegram',async()=>{
 const originalFetch=globalThis.fetch,token=process.env.TELEGRAM_BOT_TOKEN,channel=process.env.TELEGRAM_CHANNEL_ID;
 process.env.TELEGRAM_BOT_TOKEN='isolated-test-token';process.env.TELEGRAM_CHANNEL_ID='isolated-test-channel';
 let calls=0;
 globalThis.fetch=(async(input:any)=>{calls++;assert.match(String(input),/\/sendDocument$/);return Response.json({ok:true,result:{document:{file_id:'isolated-uploaded-file'}}});}) as typeof fetch;
 try{
  const {createCanvas}=await import('@napi-rs/canvas'),{uploadQuestionImage,fetchQuestionImage}=await import('./telegram-question-images.ts');
  const canvas=createCanvas(20,20),context=canvas.getContext('2d');context.fillStyle='#147d70';context.fillRect(0,0,20,20);
  const bytes=canvas.toBuffer('image/png'),image=await uploadQuestionImage('fixture.png',bytes);
  for(const received of await Promise.all([fetchQuestionImage(image),fetchQuestionImage(image)]))assert.deepEqual(received,bytes);
  assert.equal(calls,1,'Only the upload should contact Telegram.');
 }finally{globalThis.fetch=originalFetch;if(token===undefined)delete process.env.TELEGRAM_BOT_TOKEN;else process.env.TELEGRAM_BOT_TOKEN=token;if(channel===undefined)delete process.env.TELEGRAM_CHANNEL_ID;else process.env.TELEGRAM_CHANNEL_ID=channel;}
});
