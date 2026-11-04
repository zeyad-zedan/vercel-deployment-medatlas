import type {IncomingMessage,ServerResponse} from 'node:http';
import fs from 'node:fs/promises';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {importShortAnswers,manageShortAnswers} from '../src/lib/short-answer-service.ts';
let script:Promise<Uint8Array>|undefined;
export async function handleShortAnswerPortal(req:IncomingMessage,res:ServerResponse,url:URL,readBody:(req:IncomingMessage,limit:number)=>Promise<Buffer>,actor:()=>Promise<{uid:string;email:string}>) {
 if(!['/short-answers','/sa-assets/client.js','/api/sa-portal/preview','/api/sa-portal/execute','/api/sa-portal/manage'].includes(url.pathname))return false;
 const json=(status:number,value:any)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
 try{
  if(req.method==='GET'&&url.pathname==='/short-answers'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});res.end(await fs.readFile(fileURLToPath(new URL('./short-answer-portal.html',import.meta.url))));return true;}
  if(req.method==='GET'&&url.pathname==='/sa-assets/client.js'){script??=build({entryPoints:[fileURLToPath(new URL('./short-answer-portal-client.ts',import.meta.url))],bundle:true,write:false,minify:true,platform:'browser',target:'es2022'}).then(result=>result.outputFiles[0].contents).catch(e=>{script=undefined;throw e;});res.writeHead(200,{'Content-Type':'text/javascript'});res.end(await script);return true;}
  if(req.method==='POST'&&url.pathname.startsWith('/api/sa-portal/')){
   if(req.headers['x-medatlas-portal']!=='1'){json(403,{error:'Open this action from the upload portal.'});return true;}
   if(!req.headers['content-type']?.startsWith('application/json')){json(415,{error:'Send a JSON import request.'});return true;}
   const body=JSON.parse((await readBody(req,2*1024*1024)).toString('utf8'));
   if(url.pathname.endsWith('/manage')){
    const admin=await actor();
    if(body.status==='published'&&process.env.SHORT_ANSWER_PREVIEW_ONLY==='true'){json(409,{error:'Publishing will be available after the student website update is deployed.'});return true;}
    const result=await manageShortAnswers(body.lectureId,body.ids,body.status);
    if(body.ids){const {logAdminAction}=await import('../src/db/repository.ts');await logAdminAction(admin.uid,admin.email,'SHORT_ANSWER_STATUS','lecture',Number(body.lectureId),JSON.stringify({ids:body.ids,status:body.status}));}
    json(200,result);return true;
   }
   if(typeof body.jsonContent!=='string')throw new Error('Select or paste your short-answer JSON.');
   const execute=url.pathname.endsWith('/execute');
   const admin=execute?await actor():null;
   const result=await importShortAnswers(body.lectureId,body.jsonContent,body.publication==='json'&&process.env.SHORT_ANSWER_PREVIEW_ONLY!=='true',execute,{imageFiles:body.imageFiles,uploadedImages:body.uploadedImages});
   if(admin){const {logAdminAction}=await import('../src/db/repository.ts');await logAdminAction(admin.uid,admin.email,'IMPORT_SHORT_ANSWERS','lecture',Number(body.lectureId),JSON.stringify(result));}
   json(200,result);return true;
  }
  json(405,{error:'Method not allowed.'});return true;
 }catch(error){json(400,{error:error instanceof SyntaxError?'Check your JSON syntax.':error instanceof Error&&!('code' in error)?error.message:'Could not import short-answer questions. Please retry.'});return true;}
}
