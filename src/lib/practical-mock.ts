import type { QuestionImage } from './question-images.ts';
import type { ShortAnswerGrade } from './short-answer-model.ts';

export const practicalStationSeconds = 120;
export const maxPracticalAnswerLength = 2000;
export const maxPracticalMarkingPoints = 15;

export type PracticalMockCard = {
  id: string;
  title: string;
  stationCount: number;
  stationSeconds?: number;
  status: 'ready' | 'active' | 'finished' | 'graded';
};

export type PracticalMcqOptions = Record<string, string>;

export type PracticalStation = {
  questionType?: 'short_answer' | 'mcq';
  question: string;
  images: QuestionImage[];
  maxMarks: number;
  options?: PracticalMcqOptions;
};

export type PracticalStationPreviewResult = PracticalStation & {
  answer: string;
  modelAnswer: string;
  correctOption?: string;
  grade?: ShortAnswerGrade;
};

export type PracticalMockAttempt = {
  id: string;
  title: string;
  stationCount: number;
} & (
  | { status: 'active'; stationIndex: number; station: PracticalStation; answer: string; revision: number; remainingMs: number }
  | { status: 'finished' | 'grading'; retryInMs: number; gradingError: string | null; stations?: PracticalStationPreviewResult[] }
  | { status: 'graded'; stations: (PracticalStation & { answer: string; modelAnswer: string; correctOption?: string; grade: ShortAnswerGrade })[] }
);

export type PracticalStationUpload =
  | {
      questionType?: 'short_answer';
      image?: QuestionImage;
      images?: QuestionImage[];
      question: string;
      modelAnswer: string;
      rubric: { description: string; marks: number }[];
    }
  | {
      questionType: 'mcq';
      image?: QuestionImage;
      images?: QuestionImage[];
      question: string;
      options: PracticalMcqOptions;
      correctAnswer: string;
      marks?: number;
      explanation?: string;
    };
