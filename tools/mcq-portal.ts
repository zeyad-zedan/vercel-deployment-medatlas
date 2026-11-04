import type { IncomingMessage, ServerResponse } from 'node:http';
import {handleShortAnswerPortal} from './short-answer-portal.ts';
import {handleQuestionImageEditor} from './question-image-editor.ts';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../src/db/index.ts';
import { lectures, subjects, users } from '../src/db/schema.ts';
import { ClientSafeError, OWNER_ADMIN_EMAIL, previewCsvImportAdmin, executeCsvImportAdmin,upsertLectureAdmin } from '../src/db/repository.ts';
import { getSampleJsonTemplate } from '../src/lib/json-import.ts';
import { MAX_QUESTION_IMAGE_BYTES, validImageFileName } from '../src/lib/question-images.ts';
import { protectQuestionImageFields, uploadQuestionImage } from '../src/lib/telegram-question-images.ts';

const asset = (file: string) => fileURLToPath(new URL(file, import.meta.url));
let script: Promise<Uint8Array> | undefined;
function clientScript() {
  if (!script) script = build({entryPoints:[asset('./mcq-portal-client.ts')],bundle:true,write:false,platform:'browser',target:'es2022',minify:true})
    .then(result=>result.outputFiles[0].contents).catch(error=>{script=undefined;throw error;});
  return script;
}

async function portalActor() {
  // Portal imports use the existing owner actor; callers cannot select arbitrary users.
  const [admin]=await db.select({uid:users.uid,email:users.email}).from(users)
    .where(and(eq(users.email,OWNER_ADMIN_EMAIL),eq(users.role,'admin'),eq(users.accountStatus,'active'))).limit(1);
  if (!admin) throw new ClientSafeError('The portal owner account must be an active administrator before importing.',403);
  return admin;
}

export function readPortalBody(req:IncomingMessage,limit:number):Promise<Buffer> {
  return new Promise((resolve,reject)=>{
    let size=0,failed=false;const chunks:Buffer[]=[];
    const fail=(error:Error)=>{if(failed)return;failed=true;chunks.length=0;clearTimeout(timer);reject(error);};
    const timer=setTimeout(()=>fail(new ClientSafeError('Upload timed out. Please retry.',408)),60000);
    if(Number(req.headers['content-length'])>limit){fail(new ClientSafeError('File or batch exceeds the size limit.',413));req.resume();return;}
    req.on('data',(chunk:Buffer)=>{
      if(failed)return;
      size+=chunk.length;
      if(size>limit){fail(new ClientSafeError('File or batch exceeds the size limit.',413));return;}
      chunks.push(chunk);
    });
    req.on('end',()=>{clearTimeout(timer);if(!failed)resolve(Buffer.concat(chunks));});
    req.on('error',()=>fail(new ClientSafeError('Upload was interrupted. Please retry.',400)));
    req.on('aborted',()=>fail(new ClientSafeError('Upload was interrupted. Please retry.',400)));
  });
}
function json(res:ServerResponse,status:number,value:unknown) {
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});
  res.end(JSON.stringify(protectQuestionImageFields(value)));
}

/** The bot-linked portal uses same-origin checks and needs no interactive login. */
export async function handleMcqPortalRequest(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean> {
  if(await handleQuestionImageEditor(req,res,url,readPortalBody,portalActor))return true;
  if(await handleShortAnswerPortal(req,res,url,readPortalBody,portalActor))return true;
  if (!['/mcqs','/mcqs/','/mcq-assets/client.js','/mcq-assets/styles.css','/api/mcq/lectures','/api/mcq/destinations','/api/mcq/preview','/api/mcq/execute','/api/mcq/image','/api/mcq/template','/api/mcq/mixed-template','/api/mcq/image-example'].includes(url.pathname)) return false;
  try {
    if(req.method==='GET') {
      if(url.pathname==='/mcqs' || url.pathname==='/mcqs/') {
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});
        res.end(await fs.readFile(asset('./quiz-portal.html')));return true;
      }
      if(url.pathname==='/mcq-assets/client.js') {res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end(await clientScript());return true;}
      if(url.pathname==='/mcq-assets/styles.css') {res.writeHead(200,{'Content-Type':'text/css; charset=utf-8'});res.end(await fs.readFile(asset('./mcq-portal.css')));return true;}
      if(url.pathname==='/api/mcq/template') {res.setHeader('Content-Disposition','attachment; filename="questions.json"');res.writeHead(200,{'Content-Type':'application/json; charset=utf-8'});res.end(getSampleJsonTemplate());return true;}
      if(url.pathname==='/api/mcq/mixed-template'){res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="mixed-quiz-example.json"'});res.end(await fs.readFile(asset('../public/templates/mixed-quiz-example.json')));return true;}
      if(url.pathname==='/api/mcq/image-example') {res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':'attachment; filename="mcq-image-example.zip"'});res.end(await fs.readFile(asset('../public/templates/mcq-image-example.zip')));return true;}
      if(url.pathname==='/api/mcq/lectures') {
        const [rows,parentSubjects]=await Promise.all([db.select({id:lectures.id,title:lectures.title,lectureNumber:lectures.lectureNumber,contentType:lectures.contentType,subjectTitle:subjects.title,status:lectures.status})
          .from(lectures).innerJoin(subjects,eq(subjects.id,lectures.subjectId))
          .orderBy(asc(subjects.displayOrder),asc(lectures.lectureNumber),asc(lectures.id)),db.select({id:subjects.id,title:subjects.title,status:subjects.status}).from(subjects).orderBy(asc(subjects.displayOrder),asc(subjects.id))]);
        json(res,200,{lectures:rows,subjects:parentSubjects,matchingPreviewOnly:process.env.MATCHING_PREVIEW_ONLY==='true'});return true;
      }
    }
    if(req.method==='POST' && ['/api/mcq/preview','/api/mcq/execute','/api/mcq/image','/api/mcq/destinations'].includes(url.pathname)) {
      if(req.headers['x-medatlas-portal']!=='1')throw new ClientSafeError('Open this action from the private upload portal.',403);
      if(url.pathname==='/api/mcq/image') {
        const name=url.searchParams.get('name') || '';
        if(!validImageFileName(name) || req.headers['content-type']!=='application/octet-stream')throw new ClientSafeError('Select a PNG, JPEG, or WebP image up to 2 MB.',400);
        const body=await readPortalBody(req,MAX_QUESTION_IMAGE_BYTES);
        try {json(res,200,await uploadQuestionImage(name,body));}
        catch {throw new ClientSafeError('Image upload failed. Check the image is valid and under 2 MB, then retry.',400);}
        return true;
      }
      if(!req.headers['content-type']?.startsWith('application/json'))throw new ClientSafeError('Send a JSON import request.',415);
      let body:any;
      try {body=JSON.parse((await readPortalBody(req,5*1024*1024)).toString('utf8'));}
      catch(error){if(error instanceof ClientSafeError)throw error;throw new ClientSafeError('The import request contains invalid JSON.',400);}
      if(url.pathname==='/api/mcq/destinations'){
        if(!body||!Number.isInteger(body.subjectId)||body.subjectId<=0||!['lecture','practical'].includes(body.contentType)||!Number.isInteger(body.lectureNumber)||body.lectureNumber<1||typeof body.title!=='string'||!body.title.trim()||body.title.length>200||typeof body.description!=='string'||body.description.length>4000||!['draft','published'].includes(body.status??'draft'))throw new ClientSafeError('Choose a subject, Lecture or Practical, a title, a positive number and a publication status.',400);
        const admin=await portalActor();
        const saved=await upsertLectureAdmin(admin,{subjectId:body.subjectId,contentType:body.contentType,title:body.title,description:body.description.trim()||`${body.contentType==='practical'?'Practical section':'Lecture'}: ${body.title.trim()}`,lectureNumber:body.lectureNumber,status:body.status??'draft'});
        json(res,200,{lecture:saved});return true;
      }
      if(!body || typeof body.jsonContent!=='string' || !body.jsonContent.trim())throw new ClientSafeError('Select or paste a JSON question file first.',400);
      const target=body.targetLectureId===undefined || body.targetLectureId===null ? undefined : Number(body.targetLectureId);
      if(target!==undefined && (!Number.isInteger(target) || target<=0))throw new ClientSafeError('Choose a valid target lecture.',400);
      const publication=body.publication ?? 'draft';
      if(!['draft','json'].includes(publication))throw new ClientSafeError('Choose drafts or the JSON publication status.',400);
      let content=body.jsonContent;
      if(publication==='draft' || process.env.MATCHING_PREVIEW_ONLY==='true'||process.env.SHORT_ANSWER_PREVIEW_ONLY==='true') {
        try {
          const parsed=JSON.parse(content.replace(/^\uFEFF/,''));
          const rows=Array.isArray(parsed)?parsed:parsed?.questions;
          if(Array.isArray(rows)) {
            const drafts=rows.map(row=>row && typeof row==='object' && !Array.isArray(row) && (publication==='draft' || row.question_type==='matching'&&process.env.MATCHING_PREVIEW_ONLY==='true'||row.question_type==='short_answer'&&process.env.SHORT_ANSWER_PREVIEW_ONLY==='true')?{...row,status:'draft'}:row);
            content=JSON.stringify(Array.isArray(parsed)?drafts:{...parsed,questions:drafts});
          }
        } catch { /* Let the shared validator report the original JSON syntax error. */ }
      }
      const options={format:'json' as const,imageFiles:body.imageFiles ?? [],uploadedImages:body.uploadedImages};
      if(url.pathname==='/api/mcq/preview') {json(res,200,await previewCsvImportAdmin(content,target,options));return true;}
      if(body.rowOverrides!==undefined && (!body.rowOverrides || typeof body.rowOverrides!=='object' || Array.isArray(body.rowOverrides) || Object.values(body.rowOverrides).some((v:any)=>!v || typeof v!=='object' || (v.specialTags!==undefined && typeof v.specialTags!=='string') || (v.tags!==undefined && typeof v.tags!=='string'))))throw new ClientSafeError('Question tags must be text labels.',400);
      const admin=await portalActor();
      json(res,200,await executeCsvImportAdmin(admin,typeof body.fileName==='string'?body.fileName.slice(0,180):'questions.json',content,target,body.rowOverrides,options));return true;
    }
    res.setHeader('Allow',['/mcqs','/mcqs/','/mcq-assets/client.js','/mcq-assets/styles.css','/api/mcq/lectures','/api/mcq/template','/api/mcq/mixed-template','/api/mcq/image-example'].includes(url.pathname)?'GET':'POST');
    json(res,405,{error:'Method not allowed.'});return true;
  } catch(error) {
    if(error instanceof ClientSafeError) json(res,error.statusCode,{error:error.message});
    else {console.error('[MCQ portal] Request failed:',error instanceof Error?error.name:'Unknown error');json(res,500,{error:'The portal could not complete this request. Please retry.'});}
    return true;
  }
}
