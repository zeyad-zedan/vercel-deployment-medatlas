export const QUESTION_REPORT_REASONS = [
  { value: 'wrong_answer', label: 'Wrong answer' },
  { value: 'outside_syllabus', label: 'Outside the academic syllabus', arabic: 'السؤال خارج المقرر الأكاديمي' },
] as const;

export type QuestionReportReason = typeof QUESTION_REPORT_REASONS[number]['value'];

export interface QuestionReportItem {
  id: number;
  questionId: number | null;
  questionText: string;
  reason: QuestionReportReason;
  studentName: string | null;
  lectureTitle: string | null;
  createdAt: string;
}
