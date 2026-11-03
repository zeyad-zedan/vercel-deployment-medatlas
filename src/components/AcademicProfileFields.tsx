import React from 'react';
import { AVAILABLE_FACULTIES } from '../lib/academic-profile.ts';

export function AcademicProfileFields({ idPrefix, username, faculty, onUsernameChange, onFacultyChange, disabled = false, autoFocus = false }: {
  idPrefix: string;
  username: string;
  faculty: string;
  onUsernameChange: (value: string) => void;
  onFacultyChange: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const fieldClass = 'w-full px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-[var(--ma-brand)] disabled:opacity-60';
  return <>
    <div>
      <label htmlFor={`${idPrefix}-username`} className="block text-xs font-semibold text-slate-700 mb-1">Username</label>
      <input id={`${idPrefix}-username`} name="username" type="text" autoComplete="nickname" required minLength={2} maxLength={120}
        value={username} onChange={event => onUsernameChange(event.target.value)} placeholder="Choose your username"
        disabled={disabled} autoFocus={autoFocus} className={fieldClass} />
    </div>
    <div>
      <label htmlFor={`${idPrefix}-faculty`} className="block text-xs font-semibold text-slate-700 mb-1">Faculty</label>
      <select id={`${idPrefix}-faculty`} name="faculty" value={faculty} onChange={event => onFacultyChange(event.target.value)} required disabled={disabled} className={fieldClass}>
        {AVAILABLE_FACULTIES.map(option => <option key={option} value={option}>{option}</option>)}
      </select>
    </div>
  </>;
}
