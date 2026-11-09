export const dailyGoalTargets = [5, 10, 20] as const;
export const tournamentsEnabled = false;
export type DailyGoalTarget = (typeof dailyGoalTargets)[number];

export interface DailyGoal {
  target: DailyGoalTarget;
  nextTarget: DailyGoalTarget;
  answered: number;
  currentStreak: number;
  bestStreak: number;
  resetsAt: string;
}

export interface Tournament {
  id: number;
  title: string;
  startsAt: string;
  endsAt: string;
  status: 'upcoming' | 'active' | 'completed';
}

export interface TournamentRank {
  rank: number;
  nickname: string;
  points: number;
}

export interface TournamentBoard {
  tournaments: Tournament[];
  tournament: Tournament | null;
  leaders: TournamentRank[];
  ownRank: TournamentRank | null;
  participantCount: number;
}
