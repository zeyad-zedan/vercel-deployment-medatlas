import type {IncomingMessage,ServerResponse} from 'node:http';
import {ImageEditError,listImageEditableQuestions,getImageEditableQuestion,saveQuestionImages} from '../src/lib/question-image-editor.ts';
import {fetchQuestionImage,imageForStorage} from '../src/lib/telegram-question-images.ts';

export async function handleQuestionImageEditor(req:IncomingMessage,res:ServerResponse,url:URL,readBody:(req:IncomingMessage,limit:number)=>Promise<Buffer>,actor:()=>Promise<{uid:string;email:string}>){
 if(!['/api/portal/questions','/api/portal/question-image'].includes(url.pathname))return false;
 const json=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
 try{
  if(req.method==='GET'&&url.pathname==='/api/portal/question-image'){
   let image;try{image=imageForStorage({source:url.searchParams.get('source')||'',id:'',alt:''});}catch{throw new ImageEditError('Invalid image reference.');}
   const buffer=await fetchQuestionImage(image);res.writeHead(200,{'Content-Type':image.mimeType!,'Cache-Control':'private, max-age=3600','X-Content-Type-Options':'nosniff'});res.end(buffer);return true;
  }
  if(req.method!=='POST'||url.pathname!=='/api/portal/questions'){res.setHeader('Allow',url.pathname.endsWith('question-image')?'GET':'POST');json(405,{error:'Method not allowed.'});return true;}
  if(req.headers['x-medatlas-portal']!=='1')throw new ImageEditError('Open this action from the upload portal.',403);
  if(!req.headers['content-type']?.startsWith('application/json'))throw new ImageEditError('Send a JSON edit request.',415);
  let body;try{body=JSON.parse((await readBody(req,48*1024)).toString('utf8'));}catch(error){if(error instanceof SyntaxError)throw new ImageEditError('Invalid edit request.');throw error;}
  if(!body||typeof body!=='object')throw new ImageEditError('Choose a question to edit.');
  const admin=await actor();
  if(body.action==='list')json(200,await listImageEditableQuestions(body));
  else if(body.action==='get')json(200,await getImageEditableQuestion(body));
  else if(body.action==='save')json(200,await saveQuestionImages(admin,body));
  else throw new ImageEditError('Choose a valid image editing action.');
 }catch(error){const status=error instanceof ImageEditError?error.status:typeof (error as any)?.statusCode==='number'?(error as any).statusCode:500;json(status,{error:status===500?'Could not update question images. Please retry.':(error as Error).message});}
 return true;
}
