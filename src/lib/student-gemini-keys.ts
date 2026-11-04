import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {db,studentGeminiKeys} from '../db/index.ts';

function encryptionKey() {
  const value=process.env.STUDENT_API_KEY_ENCRYPTION_KEY || '';
  if(!/^[a-f0-9]{64}$/i.test(value) || value===process.env.AUTH_SESSION_SECRET || value===process.env.BACKUP_ENCRYPTION_KEY)
    throw new Error('Student key encryption is not configured.');
  return Buffer.from(value,'hex');
}
export function studentKeyStorageAvailable() {try{encryptionKey();return true;}catch{return false;}}
export function encryptStudentGeminiKey(uid:string,key:string) {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey(),iv);
  cipher.setAAD(Buffer.from(`medatlas:gemini:v1:${uid}`));
  const ciphertext=Buffer.concat([cipher.update(key,'utf8'),cipher.final()]);
  return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),ciphertext.toString('base64url')].join('.');
}
export function decryptStudentGeminiKey(uid:string,envelope:string) {
  const [version,iv,tag,ciphertext,...extra]=envelope.split('.');
  if(version!=='v1'||!iv||!tag||!ciphertext||extra.length)throw new Error('Invalid stored key.');
  const decipher=createDecipheriv('aes-256-gcm',encryptionKey(),Buffer.from(iv,'base64url'));
  decipher.setAAD(Buffer.from(`medatlas:gemini:v1:${uid}`));decipher.setAuthTag(Buffer.from(tag,'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext,'base64url')),decipher.final()]).toString('utf8');
}
export async function getStudentGeminiKeyStatus(uid:string) {
  // No ciphertext or secret read is needed for the settings screen.
  const [row]=await db.select({suffix:studentGeminiKeys.keySuffix,updatedAt:studentGeminiKeys.updatedAt}).from(studentGeminiKeys).where(eq(studentGeminiKeys.userUid,uid)).limit(1);
  return {configured:Boolean(row),maskedKey:row?`••••${row.suffix}`:null,updatedAt:row?.updatedAt??null,available:studentKeyStorageAvailable()};
}
export function validStudentGeminiKey(value:unknown):value is string {return typeof value==='string'&&/^AIza[A-Za-z0-9_-]{35}$/.test(value);}
export async function saveStudentGeminiKey(uid:string,value:string) {
  const encryptedKey=encryptStudentGeminiKey(uid,value);
  await db.insert(studentGeminiKeys).values({userUid:uid,encryptedKey,keySuffix:value.slice(-4)})
    .onConflictDoUpdate({target:studentGeminiKeys.userUid,set:{encryptedKey,keySuffix:value.slice(-4),updatedAt:new Date()}});
  return getStudentGeminiKeyStatus(uid);
}
export async function removeStudentGeminiKey(uid:string) {
  await db.delete(studentGeminiKeys).where(eq(studentGeminiKeys.userUid,uid));
  return getStudentGeminiKeyStatus(uid);
}
// Server-only helper for the future grading service; never expose through an API response.
export async function readStudentGeminiKeyForGrading(uid:string) {
  const [row]=await db.select({encryptedKey:studentGeminiKeys.encryptedKey}).from(studentGeminiKeys).where(eq(studentGeminiKeys.userUid,uid)).limit(1);
  return row?decryptStudentGeminiKey(uid,row.encryptedKey):null;
}
