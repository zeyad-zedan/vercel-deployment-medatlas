import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { protectDocumentReference, resolveDocumentReference, protectDocumentFields, documentReferenceForStorage } from './protected-document-reference.ts';
import { createProtectedDocumentRouter } from '../middleware/protected-documents.ts';
import { createBoundedRateLimiter } from '../middleware/rate-limit.ts';
import { buildSimpleMultiPagePdf } from './pdf-generator.ts';
import { isPdfPortalOriginAllowed } from './pdf-portal-access.ts';
import { cachedDocumentSource } from './document-renderer.ts';

test('original fetches are deduplicated and bounded before loading more Telegram files', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let loads=0;
  const loader=()=>{loads++;return gate.then(() => Buffer.from('%PDF-1.4 test source'));};
  const first=cachedDocumentSource('bounded-source-a',loader);
  const repeated=cachedDocumentSource('bounded-source-a',loader);
  const second=cachedDocumentSource('bounded-source-b',loader);
  const third=cachedDocumentSource('bounded-source-c',loader);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(loads,2);
  } finally { release(); }
  assert.equal((await first).toString(),(await repeated).toString());
  await Promise.all([second, third]);
  assert.equal(loads, 3);
});

test('upload portal rejects cross-site origins', () => {
  assert.equal(isPdfPortalOriginAllowed('https://upload.trycloudflare.com','upload.trycloudflare.com'),true);
  assert.equal(isPdfPortalOriginAllowed('https://other.example','upload.trycloudflare.com'),false);
});

test('opaque document references hide source paths, reject tampering and external URLs, and round-trip admin edits', () => {
  const original = '/lectures/private-source.pdf';
  const reference = protectDocumentReference(original);
  assert.ok(reference.startsWith('/api/documents/'));
  assert.ok(!reference.includes('private-source'));
  assert.equal(resolveDocumentReference(reference), original);
  assert.equal(documentReferenceForStorage(reference), original);
  assert.throws(() => resolveDocumentReference(reference.slice(0,-4)+'aaaa'));
  assert.throws(() => documentReferenceForStorage('https://external.example/file.pdf'));
  assert.throws(() => protectDocumentReference('/lectures/../secret.pdf'));
  const safe = protectDocumentFields({pdfUrl:original, questions:[{lecturePdfUrl:original}], telegramFileId:'secret-file-id', dataBase64:'secret-bytes', pdfExternal:{pdfUrl:'https://external.example/file.pdf'}});
  assert.ok(!JSON.stringify(safe).includes(original));
  assert.ok(!JSON.stringify(safe).includes('secret-file-id'));
  assert.ok(!JSON.stringify(safe).includes('secret-bytes'));
  assert.equal(safe.pdfUrl,safe.questions[0].lecturePdfUrl,'Repeated references stay compressible within a response.');
  assert.equal(safe.pdfExternal.pdfUrl,null);
});

test('protected viewing keeps originals private with watermarks off or on, controlled only by the server', async () => {
  const original = '/lectures/security-regression.pdf';
  const reference = protectDocumentReference(original);
  const pdf = buildSimpleMultiPagePdf({title:'Protected lecture',module:'Test',lectureNumber:1,pages:[{pageNumber:1,heading:'Readable page',bulletPoints:['Original PDF must never reach the browser.']}]});
  let loads=0, checks=0, published=true, watermarksEnabled=false;
  const app=express();
  app.use('/api/documents',createProtectedDocumentRouter({
    authenticate:(req:any,res,next)=>{const token=req.get('authorization');if(!token?.startsWith('Bearer test-'))return res.status(401).json({error:'Sign in.'});req.user={uid:token.slice(7)};next();},
    limiter:createBoundedRateLimiter({scope:'document-view-regression',maxRequests:20,windowMs:60000,keyGenerator:(req:any)=>req.user.uid}),
    getMetadata:async url=>{checks++;return published&&url===original?{telegramFileId:'security-regression-source',watermarksEnabled}:null;},
    fetchSource:async()=>{loads++;return pdf;},
  }));
  const server=app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const origin=`http://127.0.0.1:${(server.address() as any).port}`;
  const request=(suffix='',uid='a',extra:Record<string,string>={})=>fetch(origin+reference+suffix,{headers:{Authorization:`Bearer test-${uid}`,...extra}});
  try {
    assert.equal((await fetch(origin+reference)).status,401);
    assert.equal((await fetch(origin+reference+'?token=test-a')).status,401);
    assert.equal(checks,0);assert.equal(loads,0);
    const metadata=await request();
    assert.deepEqual(await metadata.json(),{totalPages:1});
    assert.match(metadata.headers.get('cache-control')!,/no-store/);
    const first=await request('/pages/1');
    assert.equal(first.status,200);assert.equal(first.headers.get('content-type'),'image/webp');
    assert.equal(first.headers.get('access-control-allow-origin'),null);
    assert.equal(first.headers.get('vercel-cdn-cache-control'),'no-store');
    const firstBytes=Buffer.from(await first.arrayBuffer());
    assert.equal(firstBytes.subarray(8,12).toString(),'WEBP');
    assert.notEqual(firstBytes.subarray(0,5).toString(),'%PDF-');
    const otherBytes=Buffer.from(await (await request('/pages/1','b')).arrayBuffer());
    assert.deepEqual(firstBytes,otherBytes,'Watermarks and viewer footer are off by default for every account.');
    watermarksEnabled=true;
    const markedA=Buffer.from(await(await request('/pages/1')).arrayBuffer());
    const markedB=Buffer.from(await(await request('/pages/1?watermarksEnabled=false','b')).arrayBuffer());
    assert.notDeepEqual(markedA,firstBytes,'Enabling watermarks changes the rendered pixels.');
    assert.notDeepEqual(markedA,markedB,'Viewers cannot disable account watermarks via request parameters.');
    assert.equal(loads,1,'Telegram original is reused server-side.');
    assert.equal((await request('/pages/0')).status,400);
    assert.equal((await request('/pages/2')).status,404);
    assert.equal((await request('','a',{'sec-fetch-site':'cross-site'})).status,403);
    assert.equal((await fetch(origin+'/api/documents/guessed-reference',{headers:{Authorization:'Bearer test-a'}})).status,404);
    published=false;
    assert.equal((await request('/pages/1')).status,404,'Cached source must not bypass current publication checks.');
    assert.ok(checks>=6);
    for(let i=0;i<20;i++) assert.equal((await request('','limited-viewer')).status,404);
    assert.equal((await request('','limited-viewer')).status,429,'Page/metadata access must be rate limited per account.');
  } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
});
