import { useEffect, useState } from 'react';
import { Check, Flame, Target, Trophy } from 'lucide-react';
import { api } from '../lib/api.ts';
import { dailyGoalTargets, type DailyGoal, type DailyGoalTarget } from '../lib/study-rewards.ts';

export function DailyStudyGoal({ goal, onChange }: { goal: DailyGoal; onChange: (goal: DailyGoal) => void }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const remaining = Math.max(0, goal.target - goal.answered);
  const refreshIn = Date.parse(goal.resetsAt) - Date.now();

  useEffect(() => {
    let ignore = false;
    const timer = window.setTimeout(async () => {
      try {
        const fresh = await api.getDailyGoal();
        if (!ignore) onChange(fresh);
      } catch { /* The next dashboard load can refresh the goal. */ }
    }, Math.max(500, Date.parse(goal.resetsAt) - Date.now() + 500));
    return () => { ignore = true; window.clearTimeout(timer); };
  }, [goal.resetsAt, onChange]);

  async function chooseTarget(target: DailyGoalTarget) {
    setSaving(true);
    setError('');
    try {
      onChange(await api.setDailyGoal(target));
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally { setSaving(false); }
  }

  return (
    <section className="ma-study-goal" aria-labelledby="daily-goal-heading">
      <div className="ma-goal-main">
        <div className="ma-goal-heading">
          <h2 id="daily-goal-heading">
            <span className="ma-reward-icon"><Target size={16} aria-hidden="true" /></span>
            Daily study goal
          </h2>
          <div className="ma-goal-count">
            <strong>{goal.answered}<span> / {goal.target}</span></strong>
            <span>{remaining ? `${remaining} left` : <><Check size={14} aria-hidden="true" /> Goal reached</>}</span>
          </div>
          <button type="button" className="ma-text-button" aria-expanded={editing} aria-controls="daily-goal-options"
            onClick={() => { setEditing(!editing); setError(''); }}>Change goal</button>
        </div>
        <progress aria-label="Questions toward today's goal" max={goal.target} value={Math.min(goal.answered, goal.target)} />
        {goal.nextTarget !== goal.target ? (
          <p className="ma-goal-caption">Tomorrow’s goal is {goal.nextTarget} questions.</p>
        ) : refreshIn <= 0 && <p className="ma-goal-caption">Refreshing your study day…</p>}
        <div id="daily-goal-options" hidden={!editing} className="ma-goal-options">
          <p>Each different question you answer today counts.{goal.answered ? ' Changes take effect tomorrow, Cairo time.' : ''}</p>
          <div role="group" aria-label="Questions per day">
            {dailyGoalTargets.map(target => (
              <button type="button" key={target} className="ma-reward-button" aria-pressed={goal.nextTarget === target}
                disabled={saving} onClick={() => void chooseTarget(target)}>{target} questions</button>
            ))}
          </div>
          {error && <p className="ma-reward-error" role="alert">{error}</p>}
        </div>
      </div>
      <dl className="ma-goal-streaks">
        <div>
          <dt><Flame size={14} aria-hidden="true" /> Current streak</dt>
          <dd>{goal.currentStreak} <span>{goal.currentStreak === 1 ? 'day' : 'days'}</span></dd>
        </div>
        <div>
          <dt><Trophy size={14} aria-hidden="true" /> Best streak</dt>
          <dd>{goal.bestStreak} <span>{goal.bestStreak === 1 ? 'day' : 'days'}</span></dd>
        </div>
      </dl>
    </section>
  );
}
