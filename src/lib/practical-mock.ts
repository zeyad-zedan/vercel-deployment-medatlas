import type { QuestionImage } from './question-images.ts';
import type { ShortAnswerGrade } from './short-answer-model.ts';

export const practicalStationSeconds = 120;
export const maxPracticalStations = 12;
export const maxPracticalAnswerLength = 2000;
export const maxPracticalMarkingPoints = 6;

export type PracticalMockCard = {
  id: string;
  title: string;
  stationCount: number;
  status: 'ready' | 'active' | 'finished' | 'graded';
};

export type PracticalStation = {
  question: string;
  images: QuestionImage[];
  maxMarks: number;
};

export type PracticalMockAttempt = {
  id: string;
  title: string;
  stationCount: number;
} & (
  | { status: 'active'; stationIndex: number; station: PracticalStation; answer: string; revision: number; remainingMs: number }
  | { status: 'finished' | 'grading'; retryInMs: number; gradingError: string | null }
  | { status: 'graded'; stations: (PracticalStation & { answer: string; modelAnswer: string; grade: ShortAnswerGrade })[] }
);

export type PracticalStationUpload = {
  image: QuestionImage;
  question: string;
  modelAnswer: string;
  rubric: { description: string; marks: number }[];
};
