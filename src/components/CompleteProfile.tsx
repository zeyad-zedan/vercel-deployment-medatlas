import React, { useState } from 'react';
import { api, type UserProfile } from '../lib/api.ts';
import { DEFAULT_FACULTY, validateAcademicProfile } from '../lib/academic-profile.ts';
import { AcademicProfileFields } from './AcademicProfileFields.tsx';

export function CompleteProfile({ onCompleted, onLogout }: {
  onCompleted: (user: UserProfile) => void;
  onLogout: () => Promise<void>;
}) {
  const [username, setUsername] = useState('');
  const [faculty, setFaculty] = useState<string>(DEFAULT_FACULTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const invalid = validateAcademicProfile(username, faculty);
    if (invalid) { setError(invalid); return; }
    setSaving(true);
    setError(null);
    try {
      const result = await api.updateProfile(username, undefined, faculty);
      onCompleted(result.user);
    } catch (err: any) {
      setError(err.message || 'Could not save your profile. Please try again.');
    } finally { setSaving(false); }
  };
  return <main className="ma-workspace min-h-screen flex items-center justify-center p-4 sm:p-8">
    <section aria-labelledby="complete-profile-title" className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 w-full max-w-md space-y-6">
      <div className="space-y-2">
        <p className="text-sm font-semibold text-[var(--ma-brand)]">MedAtlas MCQ</p>
        <h1 id="complete-profile-title" className="text-2xl font-bold text-slate-900">Complete your profile</h1>
        <p className="text-sm text-slate-600">Choose your username and faculty to start studying.</p>
      </div>
      <form onSubmit={save} className="space-y-4">
        <AcademicProfileFields idPrefix="setup" username={username} faculty={faculty} onUsernameChange={setUsername} onFacultyChange={setFaculty} disabled={saving} autoFocus />
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <button type="submit" disabled={saving} className="w-full rounded-lg px-4 py-3 bg-[var(--ma-brand)] hover:bg-[var(--ma-brand-hover)] text-white text-sm font-semibold disabled:opacity-60 cursor-pointer">{saving ? 'Saving…' : 'Save and continue'}</button>
        <button type="button" disabled={saving} onClick={async () => {
          try { await onLogout(); } catch { setError('Could not sign out. Please try again.'); }
        }} className="w-full text-sm text-slate-600 underline underline-offset-4 cursor-pointer disabled:opacity-60">Sign out</button>
      </form>
    </section>
  </main>;
}
