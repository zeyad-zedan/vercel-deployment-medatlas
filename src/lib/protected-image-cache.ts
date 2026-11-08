import {readFile} from 'node:fs/promises';
import {createHash,createDecipheriv} from 'node:crypto';
import path from 'node:path';
import type {QuestionImage} from './question-images.ts';

/** Encrypted deployment cache. Images are served only by authenticated image routes. */
export async function protectedImageCache(image:QuestionImage,directory=path.resolve('assets/protected-question-images')):Promise<Buffer|null>{
 if(!/^[a-f0-9]{64}$/.test(image.id)||!process.env.AUTH_SESSION_SECRET)return null;
 try{
  const encrypted=await readFile(path.join(directory,image.id+'.bin'));
  const key=createHash('sha256').update('medatlas-image-cache-v1:'+process.env.AUTH_SESSION_SECRET).digest();
  const decipher=createDecipheriv('aes-256-gcm',key,encrypted.subarray(0,12));decipher.setAuthTag(encrypted.subarray(12,28));
  const bytes=Buffer.concat([decipher.update(encrypted.subarray(28)),decipher.final()]);
  if(bytes.length!==image.fileSize||createHash('sha256').update(bytes).digest('hex')!==image.id)return null;
  return bytes;
 }catch{return null;}
}
