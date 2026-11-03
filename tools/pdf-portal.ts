import type { IncomingMessage,ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const asset=(name:string)=>fileURLToPath(new URL(name,import.meta.url));
let script:Promise<Uint8Array>|undefined;
export async function servePdfPortalPage(req:IncomingMessage,res:ServerResponse,url:URL):Promise<boolean> {
  if(!['/','/index.html','/pdf-assets/styles.css','/pdf-assets/client.js'].includes(url.pathname))return false;
  if(req.method!=='GET'){res.writeHead(405,{Allow:'GET'});res.end('Method not allowed.');return true;}
  try {
    if(url.pathname==='/pdf-assets/styles.css'){res.writeHead(200,{'Content-Type':'text/css; charset=utf-8'});res.end(await fs.readFile(asset('./pdf-portal.css')));return true;}
    if(url.pathname==='/pdf-assets/client.js'){
      if(!script)script=build({entryPoints:[asset('./pdf-portal-client.ts')],bundle:true,write:false,platform:'browser',target:'es2022',minify:true}).then(r=>r.outputFiles[0].contents).catch(error=>{script=undefined;throw error;});
      res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end(await script);return true;
    }
    const html=await fs.readFile(asset('./pdf-portal.html'));
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});res.end(html);return true;
  }catch{res.writeHead(500);res.end('The PDF portal could not load. Please refresh.');return true;}
}
