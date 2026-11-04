import {Router} from 'express';
import type {AuthRequest} from '../middleware/auth.ts';
import * as service from './short-answer-service.ts';
export const shortAnswerRouter=Router();
shortAnswerRouter.use((_req,res,next)=>{res.setHeader('Cache-Control','private, no-store');next();});
shortAnswerRouter.use(async(req:AuthRequest,res,next)=>{
 try{
  const uid=req.user!.uid;
  if(req.method==='GET'&&req.path==='/catalog')return res.json({lectures:await service.shortAnswerCatalog()});
  if(req.method==='GET'&&req.path==='/questions')return res.json(await service.shortAnswerQuestions(uid,req.query.lectureId,req.query.after));
  if(req.method==='GET'&&req.path==='/history')return res.json(await service.shortAnswerHistory(uid,req.query.before));
  if(req.method==='POST'&&req.path==='/answers')return res.json({attempt:await service.saveShortAnswer(uid,req.body?.questionId,req.body?.answer)});
  const match=req.path.match(/^\/answers\/(\d+)(\/grade)?$/);
  if(match&&req.method==='GET'&&!match[2])return res.json({attempt:await service.getShortAnswerAttempt(uid,match[1])});
  if(match&&req.method==='POST'&&match[2]){if(req.body?.consent!==true)return res.status(400).json({error:'Confirm using your Gemini key to send this answer to Google for grading.'});return res.json({attempt:await service.gradeShortAnswer(uid,match[1])});}
  next();
 }catch(error){
  if(error instanceof service.ShortAnswerError)return res.status(error.status).json({error:error.message});
  return res.status(500).json({error:'Short-answer practice is temporarily unavailable. Please try again.'});
 }
});
