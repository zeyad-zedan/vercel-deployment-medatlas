/** The model answer/rubric stays in the private short-answer table; the quiz bank holds only public content. */
export async function syncShortAnswerQuizEntries(client:any,lectureId:number){
 await client.query(`INSERT INTO public.questions(subject_id,lecture_id,question_bank_id,question_text,option_a,option_b,option_c,option_d,correct_answer,explanation,difficulty,tags,images,status,content_hash,short_answer_id,short_answer_max_marks)
 SELECT l.subject_id,sa.lecture_id,(SELECT id FROM public.question_banks WHERE lecture_id=sa.lecture_id ORDER BY id LIMIT 1),sa.definition->>'question_text','','','','','A','','Medium',
 COALESCE((SELECT string_agg(tag,', ') FROM jsonb_array_elements_text(COALESCE(sa.definition->'tags','[]'::jsonb)) tag),''),COALESCE(sa.definition->'images','[]'::jsonb),sa.status,'short-answer:'||sa.id,sa.id,sa.max_score
 FROM public.short_answer_questions sa JOIN public.lectures l ON l.id=sa.lecture_id WHERE sa.lecture_id=$1
 ON CONFLICT(short_answer_id) DO UPDATE SET question_text=excluded.question_text,tags=excluded.tags,images=excluded.images,status=excluded.status,short_answer_max_marks=excluded.short_answer_max_marks,version=questions.version+1,updated_at=now()
 WHERE (questions.question_text,questions.tags,questions.images,questions.status,questions.short_answer_max_marks) IS DISTINCT FROM (excluded.question_text,excluded.tags,excluded.images,excluded.status,excluded.short_answer_max_marks)`,[lectureId]);
}
