import {pool} from '../db/index.ts';

/** Upgrade an ongoing attempt once. Keep every original answer row for history. */
export async function refreshCourseAttempt(attemptId:string,uid:string){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const attempt=(await client.query('SELECT a.*,q.published_version FROM impulse.attempts a JOIN impulse.quizzes q ON q.id=a.quiz_id WHERE a.id=$1 AND a.student_uid=$2 FOR UPDATE OF a',[attemptId,uid])).rows[0];
  if(!attempt||attempt.completed||attempt.version_id===attempt.published_version){await client.query('COMMIT');return attempt;}
  // Compare compact fingerprints, not full question text, images or marking guides.
  const metadata=`SELECT id,position,jsonb_build_object('id',definition->'id','type',definition->'type',
   'text',md5(definition->>'text'),'image',jsonb_build_object('id',definition#>>'{image,id}'),
   'options',md5((definition->'options')::text)) AS definition
   FROM impulse.questions WHERE version_id=$1 ORDER BY position`;
  const old=(await client.query(metadata,[attempt.version_id])).rows;
  const next=(await client.query(metadata,[attempt.published_version])).rows;
  let cursor=Math.min(attempt.current_position,Math.max(0,next.length-1));
  const used=new Set<string>();
  for(const question of next){
   let previous=old.find(q=>q.definition.id===question.definition.id);
   // Compatibility for attempts created before stable question identities existed.
   if(!previous)previous=old.find(q=>!used.has(q.id)&&q.definition.type===question.definition.type&&q.definition.text===question.definition.text);
   if(!previous&&question.definition.image?.id){const candidates=old.filter(q=>!used.has(q.id)&&q.definition.type===question.definition.type&&q.definition.image?.id===question.definition.image.id);if(candidates.length===1)previous=candidates[0];}
   if(!previous&&old.length===next.length)previous=old.find(q=>q.id===q.definition.id&&q.position===question.position&&q.definition.type===question.definition.type);
   if(!previous||used.has(previous.id)||previous.definition.type!==question.definition.type)continue;
   used.add(previous.id);
   if(previous.position===attempt.current_position)cursor=question.position;
   if(question.definition.type==='mcq'&&JSON.stringify(previous.definition.options)!==JSON.stringify(question.definition.options))continue;
   await client.query(`INSERT INTO impulse.answers(attempt_id,question_id,answer,result,status)
    SELECT attempt_id,$3,answer,CASE WHEN result IS NULL THEN NULL ELSE result||jsonb_build_object('_modelAnswer',COALESCE(result->>'_modelAnswer',(SELECT definition->>'model_answer' FROM impulse.questions WHERE id=$2))) END,
    CASE WHEN status='grading' THEN 'saved' ELSE status END FROM impulse.answers WHERE attempt_id=$1 AND question_id=$2
    ON CONFLICT(attempt_id,question_id) DO NOTHING`,[attemptId,previous.id,question.id]);
  }
  await client.query('UPDATE impulse.attempts SET version_id=$2,current_position=$3,updated_at=now() WHERE id=$1',[attemptId,attempt.published_version,cursor]);
  await client.query('COMMIT');return {...attempt,version_id:attempt.published_version,current_position:cursor};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
