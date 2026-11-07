/** Subject-card destinations only; individual lecture links keep their own content type. */
export function subjectLibraryTab(title: string): 'lectures' | 'practical' {
  return /\b(?:anatomy|histology|histlogy)\b/i.test(title) ? 'practical' : 'lectures';
}
