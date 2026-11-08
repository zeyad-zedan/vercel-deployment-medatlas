import {createContext, useContext} from 'react';
import {api} from './api.ts';

// The lecture player owns the UI. A scoped transport keeps private-course writes
// away from public sessions, progress, question reports and bookmarks.
export type SessionPlayerApi = Pick<typeof api,
  'submitQuestionAnswer' | 'getSessionQuestionBatch' | 'syncSessionProgress' |
  'completeSession' | 'saveQuizShortAnswer' | 'gradeQuizShortAnswer'>;
export const SessionPlayerApiContext = createContext<SessionPlayerApi>(api);
export const useSessionPlayerApi = () => useContext(SessionPlayerApiContext);
