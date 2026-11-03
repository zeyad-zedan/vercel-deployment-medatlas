// Shared by registration and profile settings; add future faculties here.
export const DEFAULT_FACULTY = 'Benha University';
export const AVAILABLE_FACULTIES = [DEFAULT_FACULTY] as const;

export function validateAcademicProfile(username: unknown, faculty: unknown) {
  if (typeof username !== 'string' || username.trim().length < 2) {
    return 'Username must be at least 2 characters long.';
  }
  if (username.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(username)) {
    return 'Username must be 2–120 characters and cannot contain control characters.';
  }
  if (typeof faculty !== 'string' || !AVAILABLE_FACULTIES.some(option => option === faculty)) {
    return 'Please select Benha University as your faculty.';
  }
  return null;
}
