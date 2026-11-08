import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { MAX_QUESTION_IMAGE_BYTES, QUESTION_IMAGE_PREFIX, type QuestionImage } from './question-images.ts';
import { getTelegramFileDownloadUrl, isTelegramConfigured } from './telegram-storage.ts';
import {protectedImageCache} from './protected-image-cache.ts';

function key() {
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('Image protection requires the session secret.');
  return createHash('sha256').update(`medatlas-question-image-v1:${secret}`).digest();
}
export function imageForClient(image: QuestionImage): QuestionImage {
  if (!image.telegramFileId) return image;
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key(),iv);
  const data=Buffer.concat([cipher.update(JSON.stringify({id:image.id,telegramFileId:image.telegramFileId,mimeType:image.mimeType,fileSize:image.fileSize}),'utf8'),cipher.final()]);
  return {id:image.id,alt:image.alt || '',source:QUESTION_IMAGE_PREFIX+Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64url')};
}
export function imageForStorage(image: QuestionImage): QuestionImage {
  if (!image || typeof image.source !== 'string' || !image.source.startsWith(QUESTION_IMAGE_PREFIX)) throw new Error('Upload each image to Telegram before importing.');
  const token=image.source.slice(QUESTION_IMAGE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{60,2200}$/.test(token)) throw new Error('Invalid image reference.');
  const bytes=Buffer.from(token,'base64url'), decipher=createDecipheriv('aes-256-gcm',key(),bytes.subarray(0,12));
  decipher.setAuthTag(bytes.subarray(12,28));
  const data=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
  if (!/^[a-f0-9]{64}$/.test(data.id) || (image.id && data.id !== image.id) || typeof data.telegramFileId !== 'string' || !['image/png','image/jpeg','image/webp'].includes(data.mimeType) || !Number.isInteger(data.fileSize) || data.fileSize <= 0 || data.fileSize > MAX_QUESTION_IMAGE_BYTES) throw new Error('Invalid image reference.');
  return {...data,alt:typeof image.alt === 'string' ? image.alt.slice(0,500) : ''};
}
export function protectQuestionImageFields(value: any, memo=new Map<string,QuestionImage>()): any {
  if (Array.isArray(value)) return value.map(v=>protectQuestionImageFields(v,memo));
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    if (value.telegramFileId && value.id && value.mimeType?.startsWith('image/')) {
      const k=`${value.id}:${value.telegramFileId}`;
      if (!memo.has(k)) memo.set(k,imageForClient(value));
      return {...memo.get(k),alt:value.alt || ''};
    }
    return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,/Json$/.test(k) && typeof v==='string' ? protectJson(v,memo) : protectQuestionImageFields(v,memo)]));
  }
  return value;
}
function protectJson(value:string,memo:Map<string,QuestionImage>) {
  try { return JSON.stringify(protectQuestionImageFields(JSON.parse(value),memo)); } catch { return value; }
}

/** Check real format and dimensions before decoding/forwarding any untrusted upload. */
export function inspectQuestionImage(buffer: Buffer): string {
  if (!buffer.length || buffer.length>MAX_QUESTION_IMAGE_BYTES) throw new Error('Each image must be no larger than 2 MB.');
  let width=0,height=0,mime='';
  if (buffer.length>=24 && buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    mime='image/png'; width=buffer.readUInt32BE(16); height=buffer.readUInt32BE(20);
  } else if (buffer[0]===255 && buffer[1]===216) {
    mime='image/jpeg';
    for(let i=2;i+8<buffer.length;) {
      if(buffer[i++]!==255) continue;
      while(buffer[i]===255) i++;
      const marker=buffer[i++];
      if(marker===0xda || marker===0xd9) break;
      if(marker===0x01 || (marker>=0xd0 && marker<=0xd7)) continue;
      if(i+2>buffer.length) break;
      const size=buffer.readUInt16BE(i);
      if(size<2 || i+size>buffer.length) break;
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {height=buffer.readUInt16BE(i+3);width=buffer.readUInt16BE(i+5);break;}
      i+=size;
    }
  } else if(buffer.length>=30 && buffer.toString('ascii',0,4)==='RIFF' && buffer.toString('ascii',8,12)==='WEBP') {
    mime='image/webp'; const kind=buffer.toString('ascii',12,16);
    if(kind==='VP8X') {width=1+buffer.readUIntLE(24,3);height=1+buffer.readUIntLE(27,3);}
    else if(kind==='VP8 ') {width=buffer.readUInt16LE(26)&0x3fff;height=buffer.readUInt16LE(28)&0x3fff;}
    else if(kind==='VP8L' && buffer[20]===0x2f) {const bits=buffer.readUInt32LE(21);width=(bits&0x3fff)+1;height=((bits>>>14)&0x3fff)+1;}
  }
  if(!mime || !width || !height || width>6000 || height>6000 || width*height>16_000_000) throw new Error('Use a valid PNG, JPEG, or WebP image, up to 6,000 pixels per side and 16 megapixels.');
  return mime;
}

// Process-local caches bound memory and deduplicate concurrent Telegram requests.
const uploaded=new Map<string,QuestionImage>();
const uploading=new Map<string,Promise<QuestionImage>>();
export async function uploadQuestionImage(fileName:string,buffer:Buffer):Promise<QuestionImage> {
  const mimeType=inspectQuestionImage(buffer), id=createHash('sha256').update(buffer).digest('hex');
  if(uploaded.has(id)) return uploaded.get(id)!;
  if(uploading.has(id)) return uploading.get(id)!;
  if(!isTelegramConfigured()) throw new Error('Telegram image storage is not configured.');
  if(uploading.size>=2) throw new Error('Image uploads are busy. Please retry in a moment.');
  const job=(async()=>{
    // Decode as well as checking headers, so truncated/corrupt images fail before storage.
    const {loadImage}=await import('@napi-rs/canvas'); await loadImage(buffer);
    const form=new FormData();
    form.append('chat_id',process.env.TELEGRAM_CHANNEL_ID!.trim());form.append('protect_content','true');
    form.append('caption',`MedAtlas MCQ image • ${id}`);
    form.append('document',new Blob([new Uint8Array(buffer)],{type:mimeType}),fileName);
    const response=await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN!.trim()}/sendDocument`,{method:'POST',body:form,signal:AbortSignal.timeout(45000)});
    const result=await response.json().catch(()=>null);
    if(!response.ok || !result?.ok || !result.result?.document?.file_id) throw new Error('Telegram could not store this image. Please retry.');
    const image:QuestionImage={id,alt:'',telegramFileId:result.result.document.file_id,mimeType,fileSize:buffer.length};
    if(uploaded.size>=500) uploaded.delete(uploaded.keys().next().value!);
    uploaded.set(id,image);return image;
  })();
  uploading.set(id,job);
  try{return await job;}finally{uploading.delete(id);}
}
const downloads=new Map<string,{buffer:Buffer;expires:number}>();
const downloading=new Map<string,Promise<Buffer>>();
export async function fetchQuestionImage(image:QuestionImage):Promise<Buffer> {
  const cacheKey=image.id+':'+image.telegramFileId;
  const cached=downloads.get(cacheKey);
  if(cached && cached.expires>Date.now())return cached.buffer;
  if(cached)downloads.delete(cacheKey);
  if(downloading.has(cacheKey))return downloading.get(cacheKey)!;
  if(downloading.size>=8)throw new Error('Images are busy loading. Please retry.');
  const job=(async()=>{
    const protectedCopy=await protectedImageCache(image);
    if(protectedCopy){downloads.set(cacheKey,{buffer:protectedCopy,expires:Date.now()+3600000});return protectedCopy;}
    const url=await getTelegramFileDownloadUrl(image.telegramFileId!);
    const response=await fetch(url,{signal:AbortSignal.timeout(25000)});
    if(!response.ok || !response.body)throw new Error('Telegram image unavailable. Please retry.');
    const reader=response.body.getReader(),chunks:Buffer[]=[];let size=0;
    try { for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_QUESTION_IMAGE_BYTES)throw new Error('Image exceeds the size limit.');chunks.push(Buffer.from(value));} }
    finally {await reader.cancel().catch(()=>{});}
    const buffer=Buffer.concat(chunks);
    if(size!==image.fileSize || createHash('sha256').update(buffer).digest('hex')!==image.id)throw new Error('Image integrity check failed.');
    let total=[...downloads.values()].reduce((n,c)=>n+c.buffer.length,0);
    for(const [k,v] of downloads){if(total+size<=32*1024*1024)break;downloads.delete(k);total-=v.buffer.length;}
    downloads.set(cacheKey,{buffer,expires:Date.now()+3600000});return buffer;
  })();
  downloading.set(cacheKey,job);
  try{return await job;}finally{downloading.delete(cacheKey);}
}
