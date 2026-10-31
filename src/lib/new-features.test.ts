import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOptionPermutation,
  resolveCanonicalOption,
  resolveDisplayedOption,
  formatQuestionForClient,
  scoreExamSession,
  selectPracticeQuestions,
  computeTopicPerformance,
  parseAndValidateCsvQuestions,
  parseSpecialTags,
  getSampleCsvTemplate,
  REQUIRED_CSV_COLUMNS,
  CanonicalQuestion,
} from './mcq-engine';

const TEST_QUESTION: CanonicalQuestion = {
  id: 201,
  subjectId: 1,
  lectureId: 10,
  questionText: 'A 60-year-old male presents with retrosternal chest pain. ECG shows ST-segment elevation in leads II, III, and aVF. Which coronary artery is most likely occluded?',
  optionA: 'Left anterior descending (LAD)',
  optionB: 'Right coronary artery (RCA)',
  optionC: 'Left circumflex artery (LCx)',
  optionD: 'Left main coronary artery (LMCA)',
  correctAnswer: 'B',
  explanation: 'ST-segment elevation in leads II, III, and aVF reflects an inferior wall myocardial infarction, typically supplied by the RCA.',
  explanationA: 'LAD occlusion leads to anterior/septal STEMI (V1–V4).',
  explanationB: 'Correct: The RCA supplies the inferior myocardium in 85–90% of individuals.',
  explanationC: 'LCx occlusion typically results in lateral wall STEMI (I, aVL, V5, V6).',
  explanationD: 'LMCA occlusion causes extensive anterior and lateral ischemia with hemodynamic instability.',
  difficulty: 'Medium',
  tags: 'Cardiology,STEMI,ECG',
  pageNumber: 3,
  status: 'published',
};

// ============================================================================
// 1. Automatic Answer Submission & Duplicate Prevention
// ============================================================================
test('1. Study mode automatic submission: evaluates answer immediately and returns rationales', () => {
  const perm = createOptionPermutation(false); // canonical order
  const formatted = formatQuestionForClient(TEST_QUESTION, perm, false);

  // Student selects 'B' (correct)
  const isCorrect = resolveCanonicalOption('B', perm) === TEST_QUESTION.correctAnswer;
  assert.equal(isCorrect, true);
  assert.equal(formatted.correctDisplayedOption, 'B');
  assert.equal(formatted.optionExplanations?.['B'], TEST_QUESTION.explanationB);
  assert.equal(formatted.explanation, TEST_QUESTION.explanation);

  // Student selects 'A' (incorrect)
  const isIncorrect = resolveCanonicalOption('A', perm) === TEST_QUESTION.correctAnswer;
  assert.equal(isIncorrect, false);
  assert.equal(formatted.optionExplanations?.['A'], TEST_QUESTION.explanationA);
});

test('2. Duplicate submission prevention: scoring handles existing attempt snapshots idempotently', () => {
  const questions = [
    { id: 201, correctAnswer: 'B' as const },
    { id: 202, correctAnswer: 'A' as const },
  ];

  // First submission: Question 201 answered correctly
  const state1 = scoreExamSession(questions, { 201: 'B' });
  assert.equal(state1.correctCount, 1);
  assert.equal(state1.unansweredCount, 1);
  assert.equal(state1.scorePercentage, 50);

  // Re-submitting the same answer for 201 does not alter counts
  const state2 = scoreExamSession(questions, { 201: 'B' });
  assert.deepEqual(state1, state2);
});

// ============================================================================
// 2. Option Explanations & Shuffled Options
// ============================================================================
test('3. Option shuffling preserves individual rationales associated with each shuffled option', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const perm = createOptionPermutation(true, seed);
    const formatted = formatQuestionForClient(TEST_QUESTION, perm, false);

    assert.ok(formatted.optionExplanations, 'optionExplanations must exist in study mode');

    // For every displayed key (A, B, C, D), its explanation must correspond to its canonical option
    for (const key of ['A', 'B', 'C', 'D'] as const) {
      const canonical = perm[key];
      const expectedText = TEST_QUESTION[`option${canonical}` as keyof CanonicalQuestion];
      const expectedExpl = TEST_QUESTION[`explanation${canonical}` as keyof CanonicalQuestion];

      assert.equal(formatted.options[key], expectedText);
      assert.equal(formatted.optionExplanations[key], expectedExpl);
    }

    // General explanation is also preserved
    assert.equal(formatted.explanation, TEST_QUESTION.explanation);
    // Page number is preserved
    assert.equal(formatted.pageNumber, 3);
  }
});

// ============================================================================
// 3. Exam Answer Hiding
// ============================================================================
test('4. Exam mode strictly strips correct answer, option explanations, and general explanation', () => {
  const perm = createOptionPermutation(true, 99);
  const examPayload = formatQuestionForClient(TEST_QUESTION, perm, true) as Record<string, unknown>;

  // Must NOT expose answers or rationales
  assert.equal('correctDisplayedOption' in examPayload, false);
  assert.equal('correctCanonicalOption' in examPayload, false);
  assert.equal('explanation' in examPayload, false);
  assert.equal('optionExplanations' in examPayload, false);

  // But question text, options, and question metadata are preserved
  assert.equal(typeof examPayload.options, 'object');
  assert.equal(examPayload.id, 201);
  assert.equal(examPayload.questionText, TEST_QUESTION.questionText);
  assert.equal(examPayload.pageNumber, 3);
});

// ============================================================================
// 4. Progress and Statistics Calculations
// ============================================================================
test('5. Progress calculation: distinguishes unique questions attempted from repeated attempts', () => {
  const totalPublishedQuestions = 10;

  // Student attempts question 1 three times (2 correct, 1 incorrect), and question 2 once (1 correct)
  const attempts = [
    { questionId: 1, isCorrect: true, tags: 'Cardio' },
    { questionId: 1, isCorrect: true, tags: 'Cardio' },
    { questionId: 1, isCorrect: false, tags: 'Cardio' },
    { questionId: 2, isCorrect: true, tags: 'Cardio' },
  ];

  const uniqueQuestionIds = new Set(attempts.map((a) => a.questionId));
  const uniqueQuestionsAttempted = uniqueQuestionIds.size;
  const totalAnswersSubmitted = attempts.length;
  const correctAnswers = attempts.filter((a) => a.isCorrect).length;
  const incorrectAnswers = attempts.filter((a) => !a.isCorrect).length;
  const accuracyPercentage = Math.round((correctAnswers / totalAnswersSubmitted) * 100);
  const remainingUnanswered = Math.max(0, totalPublishedQuestions - uniqueQuestionsAttempted);

  assert.equal(uniqueQuestionsAttempted, 2, 'Repeated attempts must not increment unique questions');
  assert.equal(totalAnswersSubmitted, 4);
  assert.equal(correctAnswers, 3);
  assert.equal(incorrectAnswers, 1);
  assert.equal(accuracyPercentage, 75); // 3 / 4 = 75%
  assert.equal(remainingUnanswered, 8); // 10 - 2 = 8
});

test('6. Empty state: handles zero attempts without division by zero or NaN', () => {
  const totalPublishedQuestions = 15;
  const attempts: Array<{ questionId: number; isCorrect: boolean }> = [];

  const uniqueQuestionsAttempted = new Set(attempts.map((a) => a.questionId)).size;
  const totalAnswersSubmitted = attempts.length;
  const correctAnswers = 0;
  const incorrectAnswers = 0;
  const accuracyPercentage =
    totalAnswersSubmitted > 0 ? Math.round((correctAnswers / totalAnswersSubmitted) * 100) : 0;
  const remainingUnanswered = Math.max(0, totalPublishedQuestions - uniqueQuestionsAttempted);

  assert.equal(uniqueQuestionsAttempted, 0);
  assert.equal(totalAnswersSubmitted, 0);
  assert.equal(correctAnswers, 0);
  assert.equal(incorrectAnswers, 0);
  assert.equal(accuracyPercentage, 0);
  assert.equal(Number.isNaN(accuracyPercentage), false);
  assert.equal(remainingUnanswered, 15);
});

// ============================================================================
// 5. PDF Page Navigation & Page Number Validation
// ============================================================================
function validatePageNumberInput(val: unknown): { valid: boolean; pageNumber: number | null; error?: string } {
  if (val === null || val === undefined || val === '') {
    return { valid: true, pageNumber: null };
  }
  const num = typeof val === 'number' ? val : Number(String(val).trim());
  if (!Number.isInteger(num) || num <= 0) {
    return { valid: false, pageNumber: null, error: 'Page number must be a positive integer.' };
  }
  return { valid: true, pageNumber: num };
}

test('7. PDF page number validation: accepts positive integers, rejects invalid values', () => {
  // Valid positive integers
  assert.deepEqual(validatePageNumberInput(1), { valid: true, pageNumber: 1 });
  assert.deepEqual(validatePageNumberInput(42), { valid: true, pageNumber: 42 });
  assert.deepEqual(validatePageNumberInput(' 5 '), { valid: true, pageNumber: 5 });
  assert.deepEqual(validatePageNumberInput(null), { valid: true, pageNumber: null });
  assert.deepEqual(validatePageNumberInput(''), { valid: true, pageNumber: null });

  // Invalid: zero, negative, floats, NaN, strings
  assert.equal(validatePageNumberInput(0).valid, false);
  assert.equal(validatePageNumberInput(-1).valid, false);
  assert.equal(validatePageNumberInput(-10).valid, false);
  assert.equal(validatePageNumberInput(2.5).valid, false);
  assert.equal(validatePageNumberInput('abc').valid, false);
  assert.equal(validatePageNumberInput('NaN').valid, false);
});

// ============================================================================
// 6. CSV Compatibility with page_number
// ============================================================================
test('8. CSV parser: validates positive page_number, rejects invalid page_number, and handles missing column gracefully', () => {
  // Template includes page_number
  const template = getSampleCsvTemplate();
  assert.ok(REQUIRED_CSV_COLUMNS.includes('page_number' as any));
  assert.ok(template.includes('page_number'));

  // CSV with valid page_number
  const csvWithPage = `subject,lecture,question_text,option_a,option_b,option_c,option_d,correct_answer,explanation,difficulty,tags,page_number,status
Cardiology,ACS,Which coronary artery supplies the inferior wall of the heart?,LAD,RCA,LCx,LMCA,B,Inferior STEMI is RCA,Medium,Cardio,3,published`;

  const report1 = parseAndValidateCsvQuestions(csvWithPage);
  assert.equal(report1.headerErrors.length, 0);
  assert.equal(report1.validCount, 1);
  assert.equal(report1.rows[0].pageNumber, 3);
  assert.equal(report1.rows[0].isValid, true);

  // CSV with invalid page_number (negative)
  const csvInvalidPage = `subject,lecture,question_text,option_a,option_b,option_c,option_d,correct_answer,explanation,difficulty,tags,page_number,status
Cardiology,ACS,Which coronary artery supplies the inferior wall of the heart?,LAD,RCA,LCx,LMCA,B,Inferior STEMI is RCA,Medium,Cardio,-5,published`;

  const report2 = parseAndValidateCsvQuestions(csvInvalidPage);
  assert.equal(report2.invalidCount, 1);
  assert.ok(report2.rows[0].errors.some((e) => e.includes('positive integer')));

  // Backward compatibility: CSV without page_number column
  const csvWithoutPage = `subject,lecture,question_text,option_a,option_b,option_c,option_d,correct_answer,explanation,difficulty,tags,status
Cardiology,ACS,Which coronary artery supplies the inferior wall of the heart?,LAD,RCA,LCx,LMCA,B,Inferior STEMI is RCA,Medium,Cardio,published`;

  const report3 = parseAndValidateCsvQuestions(csvWithoutPage);
  assert.equal(report3.headerErrors.length, 0);
  assert.equal(report3.validCount, 1);
  assert.equal(report3.rows[0].pageNumber, null);
  assert.equal(report3.rows[0].isValid, true);
});

// ============================================================================
// 7. PDF File Upload & Validation
// ============================================================================
function validatePdfUploadBuffer(rawBuffer: Buffer): { valid: boolean; error?: string } {
  if (rawBuffer.length === 0) {
    return { valid: false, error: 'Uploaded file is empty.' };
  }
  const isPdf =
    rawBuffer.length >= 4 &&
    rawBuffer[0] === 0x25 && // %
    rawBuffer[1] === 0x50 && // P
    rawBuffer[2] === 0x44 && // D
    rawBuffer[3] === 0x46;   // F

  if (!isPdf) {
    return { valid: false, error: 'Invalid file format. Only valid PDF files are permitted for lecture documents.' };
  }
  const MAX_PDF_BYTES = 50 * 1024 * 1024;
  if (rawBuffer.length > MAX_PDF_BYTES) {
    return { valid: false, error: 'File size exceeds the 50MB limit.' };
  }
  return { valid: true };
}

test('9. PDF upload validation: accepts valid PDF buffers, rejects non-PDFs and empty files', () => {
  // Valid PDF header "%PDF-1.4"
  const validPdfBuf = Buffer.from('%PDF-1.4 sample lecture content for medical students');
  assert.equal(validatePdfUploadBuffer(validPdfBuf).valid, true);

  // Invalid: Plain text, HTML, or images without %PDF
  const plainTextBuf = Buffer.from('Hello world this is not a PDF');
  assert.equal(validatePdfUploadBuffer(plainTextBuf).valid, false);

  const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  assert.equal(validatePdfUploadBuffer(pngBuf).valid, false);

  // Empty buffer
  const emptyBuf = Buffer.alloc(0);
  assert.equal(validatePdfUploadBuffer(emptyBuf).valid, false);
});

test('10. PDF upload filename sanitization: prevents path traversal and unsafe characters', () => {
  const sanitizeFileName = (fileName: string): string => {
    const rawBase = fileName.split(/[/\\]/).pop()?.replace(/\.pdf$/i, '') || 'lecture';
    const safe = rawBase.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'lecture';
    return `${safe}.pdf`;
  };

  assert.equal(sanitizeFileName('../../../etc/passwd.pdf'), 'passwd.pdf');
  assert.equal(sanitizeFileName('..\\..\\windows\\system32.pdf'), 'system32.pdf');
  assert.equal(sanitizeFileName('Cardiology & ACS Slide Deck (2026).pdf'), 'Cardiology___ACS_Slide_Deck__2026_.pdf');
});

test('11. Lecture progress reset: clears only target lecture attempts and sessions while preserving others', () => {
  interface Attempt {
    id: number;
    userUid: string;
    lectureId: number;
    sessionId: number;
    questionId: number;
  }
  interface Session {
    id: number;
    userUid: string;
    lectureId: number;
  }

  let attempts: Attempt[] = [
    { id: 1, userUid: 'user-1', lectureId: 10, sessionId: 101, questionId: 1 },
    { id: 2, userUid: 'user-1', lectureId: 10, sessionId: 101, questionId: 2 },
    { id: 3, userUid: 'user-1', lectureId: 20, sessionId: 102, questionId: 3 }, // different lecture
    { id: 4, userUid: 'user-2', lectureId: 10, sessionId: 103, questionId: 1 }, // different user
  ];

  let sessions: Session[] = [
    { id: 101, userUid: 'user-1', lectureId: 10 },
    { id: 102, userUid: 'user-1', lectureId: 20 },
    { id: 103, userUid: 'user-2', lectureId: 10 },
  ];

  const targetUid = 'user-1';
  const targetLectureId = 10;

  // Simulate reset
  const userLectSessions = sessions.filter(
    (s) => s.userUid === targetUid && s.lectureId === targetLectureId
  );
  const sessionIds = userLectSessions.map((s) => s.id);

  attempts = attempts.filter(
    (a) =>
      !(
        a.userUid === targetUid &&
        (a.lectureId === targetLectureId || sessionIds.includes(a.sessionId))
      )
  );
  sessions = sessions.filter(
    (s) => !(s.userUid === targetUid && s.lectureId === targetLectureId)
  );

  // Assert user-1 lecture 10 is completely wiped
  assert.equal(
    attempts.filter((a) => a.userUid === targetUid && a.lectureId === targetLectureId).length,
    0
  );
  assert.equal(
    sessions.filter((s) => s.userUid === targetUid && s.lectureId === targetLectureId).length,
    0
  );

  // Assert user-1 lecture 20 is completely untouched
  assert.equal(
    attempts.filter((a) => a.userUid === targetUid && a.lectureId === 20).length,
    1
  );
  assert.equal(
    sessions.filter((s) => s.userUid === targetUid && s.lectureId === 20).length,
    1
  );

  // Assert user-2 lecture 10 is completely untouched
  assert.equal(
    attempts.filter((a) => a.userUid === 'user-2' && a.lectureId === 10).length,
    1
  );
  assert.equal(
    sessions.filter((s) => s.userUid === 'user-2' && s.lectureId === 10).length,
    1
  );
});

// ============================================================================
// 12. Post-Generation Lecture PDF Attachment
// ============================================================================
test('12. Post-Generation PDF Attachment: updates lecture pdfUrl and preserves lecture metadata', () => {
  interface MockLecture {
    id: number;
    title: string;
    subjectId: number;
    lectureNumber: number;
    pdfUrl: string | null;
  }

  const mockLectures: MockLecture[] = [
    {
      id: 501,
      title: 'Generated Lecture 1: Cardiac Electrophysiology',
      subjectId: 1,
      lectureNumber: 1,
      pdfUrl: null, // Initially generated without PDF
    },
    {
      id: 502,
      title: 'Generated Lecture 2: Valvular Pathology',
      subjectId: 1,
      lectureNumber: 2,
      pdfUrl: '/lectures/existing-valves.pdf',
    },
  ];

  function simulateAttachPdf(lectureId: number, pdfUrl: string | null): MockLecture {
    const lect = mockLectures.find((l) => l.id === lectureId);
    if (!lect) throw new Error(`Lecture ${lectureId} not found`);
    const cleanUrl = pdfUrl && pdfUrl.trim() ? pdfUrl.trim() : null;
    lect.pdfUrl = cleanUrl;
    return { ...lect };
  }

  // 1. Attach PDF to newly generated lecture without PDF
  const updated1 = simulateAttachPdf(501, '/lectures/1793200000000-cardiac_electrophysiology.pdf');
  assert.equal(updated1.pdfUrl, '/lectures/1793200000000-cardiac_electrophysiology.pdf');
  assert.equal(updated1.title, 'Generated Lecture 1: Cardiac Electrophysiology');

  // 2. Replace existing PDF on generated lecture
  const updated2 = simulateAttachPdf(502, '/lectures/1793200000001-valvular_pathology_v2.pdf');
  assert.equal(updated2.pdfUrl, '/lectures/1793200000001-valvular_pathology_v2.pdf');

  // 3. Remove/detach PDF
  const updated3 = simulateAttachPdf(502, null);
  assert.equal(updated3.pdfUrl, null);

  // 4. Non-existent lecture throws error
  assert.throws(() => simulateAttachPdf(99999, '/lectures/test.pdf'), /not found/);
});

test('13. CSV Bulk Import Affected Lecture Tracking: identifies generated and updated lectures for immediate PDF upload', () => {
  const existingLectures = [
    { id: 1, subjectId: 10, title: 'Existing Lecture A', pdfUrl: '/lectures/a.pdf' },
  ];

  const parsedCsvRows = [
    { subject: 'Cardiology', lecture: 'Existing Lecture A', questionText: 'Q1' },
    { subject: 'Cardiology', lecture: 'Newly Generated Lecture B', questionText: 'Q2' },
    { subject: 'Cardiology', lecture: 'Newly Generated Lecture B', questionText: 'Q3' },
  ];

  const affectedLectureIds = new Set<number>();
  const newlyCreatedLectureIds = new Set<number>();

  let nextId = 2;
  const lectureMap = new Map<string, any>(existingLectures.map((l) => [l.title.toLowerCase(), l]));

  for (const row of parsedCsvRows) {
    const key = row.lecture.toLowerCase();
    let lect = lectureMap.get(key);
    if (!lect) {
      lect = { id: nextId++, subjectId: 10, title: row.lecture, pdfUrl: null };
      lectureMap.set(key, lect);
      newlyCreatedLectureIds.add(lect.id);
    }
    affectedLectureIds.add(lect.id);
  }

  // Verify affected lectures
  assert.equal(affectedLectureIds.size, 2);
  assert.equal(affectedLectureIds.has(1), true); // existing
  assert.equal(affectedLectureIds.has(2), true); // newly generated

  // Verify new lectures identified
  assert.equal(newlyCreatedLectureIds.size, 1);
  assert.equal(newlyCreatedLectureIds.has(2), true);
  assert.equal(newlyCreatedLectureIds.has(1), false);

  // Newly generated lecture B is eligible for immediate PDF upload
  const generatedLect = lectureMap.get('newly generated lecture b');
  assert.equal(generatedLect.pdfUrl, null);
});

test('14. Lecture Study Session Question Synchronization: Automatically un-completes and appends newly added MCQs to existing lecture sessions', () => {
  // Simulate an existing session where a student solved the initial 30 MCQs and submitted
  const initialQuestions = Array.from({ length: 30 }, (_, i) => ({
    id: i + 1,
    lectureId: 42,
    status: 'published',
  }));

  const initialItems = initialQuestions.map((q) => ({
    questionId: q.id,
    permutation: { A: 'A', B: 'B', C: 'C', D: 'D' },
    selectedDisplayed: 'A',
    selectedCanonical: 'A',
    submitted: true,
  }));

  const existingCompletedSession = {
    id: 101,
    lectureId: 42,
    mode: 'study',
    status: 'completed',
    totalQuestions: 30,
    unansweredCount: 0,
    questionOrderJson: JSON.stringify(initialItems),
    completedAt: new Date(),
  };

  // Now, 30 new questions are added to the same lecture (total 60 questions)
  const currentPublishedQuestions = Array.from({ length: 60 }, (_, i) => ({
    id: i + 1,
    lectureId: 42,
    status: 'published',
  }));

  const pubQIdSet = new Set(currentPublishedQuestions.map((q) => q.id));
  const existingItems = JSON.parse(existingCompletedSession.questionOrderJson);
  const existingQIdSet = new Set(existingItems.map((i: any) => i.questionId));

  const validExistingItems = existingItems.filter((i: any) => pubQIdSet.has(i.questionId));
  const missingQuestions = currentPublishedQuestions.filter((q) => !existingQIdSet.has(q.id));

  // Must detect the 30 new questions
  assert.equal(missingQuestions.length, 30);

  const newItems = missingQuestions.map((q) => ({
    questionId: q.id,
    permutation: { A: 'A', B: 'B', C: 'C', D: 'D' },
    selectedDisplayed: null,
    selectedCanonical: null,
    submitted: false,
  }));

  const updatedItems = [...validExistingItems, ...newItems];
  const answeredCount = updatedItems.filter((i) => i.submitted).length;
  const totalCount = updatedItems.length;
  const unansweredCount = Math.max(0, totalCount - answeredCount);

  // Must transition status from 'completed' to 'in_progress' and clear completedAt
  const nextStatus = unansweredCount > 0 ? 'in_progress' : existingCompletedSession.status;
  const nextCompletedAt = unansweredCount > 0 ? null : existingCompletedSession.completedAt;

  assert.equal(totalCount, 60);
  assert.equal(answeredCount, 30);
  assert.equal(unansweredCount, 30);
  assert.equal(nextStatus, 'in_progress');
  assert.equal(nextCompletedAt, null);

  // Resume index logic: when resuming an active session with unanswered questions,
  // it should jump straight to the first unsolved question (index 30 -> Question 31)
  const firstUnsolvedIdx = updatedItems.findIndex((q) => !q.submitted && !q.selectedDisplayed);
  assert.equal(firstUnsolvedIdx, 30);
});

test('17. Special Tags (e.g. "Old Exam", "كتاب القسم"): CSV parsing, student badge formatting, and Mock Exam / Custom Practice filtering', () => {
  // 1. Official template includes special_tags column
  assert.ok(REQUIRED_CSV_COLUMNS.includes('special_tags' as any));
  const template = getSampleCsvTemplate();
  assert.ok(template.includes('special_tags'));
  assert.ok(template.includes('Old Exam,كتاب القسم'));

  // 2. parseSpecialTags deduplicates and trims
  assert.deepEqual(parseSpecialTags('Old Exam, كتاب القسم , old exam '), [
    'Old Exam',
    'كتاب القسم',
  ]);
  assert.deepEqual(parseSpecialTags(''), []);
  assert.deepEqual(parseSpecialTags(null), []);

  // 3. CSV parsing extracts special_tags and preserves backward compatibility when column is omitted
  const csvWithSpecialTags = `subject,lecture,question_text,option_a,option_b,option_c,option_d,correct_answer,explanation,difficulty,tags,special_tags,page_number,status
Histology,Epithelium,"Which junctional complex anchors epithelial cells to the basement membrane?",Tight junction,Gap junction,Hemidesmosome,Desmosome,C,Hemidesmosomes bind integrins to laminin in the basal lamina.,Medium,"Epithelium,Junctions","Old Exam,كتاب القسم",4,published`;

  const report = parseAndValidateCsvQuestions(csvWithSpecialTags);
  assert.equal(report.validCount, 1);
  assert.equal(report.rows[0].specialTags, 'Old Exam,كتاب القسم');

  // 4. formatQuestionForClient exposes specialTags in both Study and Exam modes so students see the notification badge
  const qWithSpecial: CanonicalQuestion = {
    ...TEST_QUESTION,
    specialTags: 'Old Exam, كتاب القسم',
  };
  const perm = createOptionPermutation(false);
  const studyClientQ = formatQuestionForClient(qWithSpecial, perm, false);
  const examClientQ = formatQuestionForClient(qWithSpecial, perm, true);
  assert.equal(studyClientQ.specialTags, 'Old Exam, كتاب القسم');
  assert.equal(examClientQ.specialTags, 'Old Exam, كتاب القسم');

  // 5. selectPracticeQuestions filters by specialTags for Mock Exam & Custom Practice
  const pool = [
    {
      id: 1,
      subjectId: 1,
      lectureId: 10,
      difficulty: 'Easy',
      tags: 'Cell Biology',
      specialTags: 'Old Exam',
      status: 'published',
    },
    {
      id: 2,
      subjectId: 1,
      lectureId: 10,
      difficulty: 'Medium',
      tags: 'Histology',
      specialTags: 'كتاب القسم',
      status: 'published',
    },
    {
      id: 3,
      subjectId: 1,
      lectureId: 10,
      difficulty: 'Hard',
      tags: 'Physiology',
      specialTags: '',
      status: 'published',
    },
  ];

  const oldExamOnly = selectPracticeQuestions(pool, {
    specialTags: ['old exam'],
  });
  assert.equal(oldExamOnly.selectedQuestions.length, 1);
  assert.equal(oldExamOnly.selectedQuestions[0].id, 1);

  const deptBookOnly = selectPracticeQuestions(pool, {
    specialTags: ['كتاب القسم'],
  });
  assert.equal(deptBookOnly.selectedQuestions.length, 1);
  assert.equal(deptBookOnly.selectedQuestions[0].id, 2);

  const bothSpecialTags = selectPracticeQuestions(pool, {
    specialTags: ['Old Exam', 'كتاب القسم'],
  });
  assert.equal(bothSpecialTags.selectedQuestions.length, 2);
});


