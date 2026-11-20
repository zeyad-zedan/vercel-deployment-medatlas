import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after,test} from 'node:test';

process.env.NODE_ENV='test';
process.env.AUTH_SESSION_SECRET='bsf112-isolated-format-test-session-secret';
const local=/^postgres(?:ql)?:\/\/[^/]*@127\.0\.0\.1:/.test(process.env.DATABASE_URL??'');
const {pool}=await import('../db/index.ts');
const {startPracticalMock,readPracticalMock,savePracticalMockAnswer,skipPracticalMock,listPracticalMocks,parsePracticalMockStations}=await import('../db/practical-mock.ts');
after(()=>pool.end());

test('26 slides use their own 90-second clock and display quarter marks without changing legacy clocks',{skip:!local},async()=>{
 const id=randomUUID(),old=randomUUID(),uid='bsf112-test-'+id;
 const stations=parsePracticalMockStations(Array.from({length:26},()=>({question:'1. Define the concept.\n2. Name two examples.',modelAnswer:'Definition; first; second.',rubric:[{description:'Definition',marks:2},{description:'First example',marks:1},{description:'Second example',marks:1}],images:[]})));
 try{
  await pool.query("INSERT INTO public.users(uid,email,display_name) VALUES($1,$1||'@example.invalid','Fixture')",[uid]);
  await pool.query('INSERT INTO practical_mock.exams(id,title,stations,station_seconds,mark_unit) VALUES($1,$2,$3,90,0.25)',[id,'BSF112 clock fixture',JSON.stringify(stations)]);
  await pool.query('INSERT INTO practical_mock.exams(id,title,stations) VALUES($1,$2,$3)',[old,'Legacy clock fixture',JSON.stringify(stations.slice(0,2))]);
  const first=await startPracticalMock(uid,id);assert.equal(first.status,'active');
  if(first.status!=='active')throw Error('Expected active attempt');
  assert.ok(first.remainingMs>85000&&first.remainingMs<=90000);assert.equal(first.station.maxMarks,1);
  await savePracticalMockAnswer(uid,id,{stationIndex:0,answer:'Definition',revision:0});
  const next=await skipPracticalMock(uid,id,{stationIndex:0});assert.equal(next.status,'active');
  if(next.status==='active'){assert.equal(next.stationIndex,1);assert.ok(next.remainingMs>85000&&next.remainingMs<=90000);}
  await pool.query("UPDATE practical_mock.attempts SET skipped_ms=0,started_at=clock_timestamp()-interval '90.2 seconds' WHERE exam_id=$1",[id]);
  await assert.rejects(savePracticalMockAnswer(uid,id,{stationIndex:0,answer:'Late',revision:1}));
  const at90=await readPracticalMock(uid,id);assert.equal(at90.status,'active');if(at90.status==='active')assert.equal(at90.stationIndex,1);
  await pool.query("UPDATE practical_mock.attempts SET started_at=clock_timestamp()-interval '2341 seconds',grade_available_at=NULL WHERE exam_id=$1",[id]);
  assert.equal((await readPracticalMock(uid,id)).status,'finished');
  const graded=stations.map(s=>({score:3,maxScore:4,feedback:'Partial',points:s.rubric.map((r,i)=>({...r,awarded:i?0:2,feedback:'Marked'}))}));
  graded.forEach(g=>g.score=2);
  await pool.query('UPDATE practical_mock.attempts SET grades=$2 WHERE exam_id=$1',[id,JSON.stringify(graded)]);
  const result=await readPracticalMock(uid,id);assert.equal(result.status,'graded');if(result.status==='graded'){assert.equal(result.stations[0].grade.score,.5);assert.equal(result.stations[0].grade.maxScore,1);assert.equal(result.stations[0].grade.points[1].marks,.25);}
  const legacy=await startPracticalMock(uid,old);if(legacy.status!=='active')throw Error('Expected legacy attempt');assert.ok(legacy.remainingMs>115000);assert.equal(legacy.station.maxMarks,4);
  const card=(await listPracticalMocks(uid,id))[0];assert.equal(card.stationSeconds,90);assert.equal(card.stationCount,26);
 }finally{await pool.query('DELETE FROM public.users WHERE uid=$1',[uid]);await pool.query('DELETE FROM practical_mock.exams WHERE id=ANY($1::uuid[])',[[id,old]]);}
});
