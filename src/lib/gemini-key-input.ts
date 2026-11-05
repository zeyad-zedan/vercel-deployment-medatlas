// Provider credentials are opaque; Google may change their prefix and length.
export const MAX_GEMINI_KEY_LENGTH = 4096;
export const GEMINI_KEY_INPUT_ERROR = 'Paste the complete key copied from Google AI Studio, without quotes, spaces, or an API-key assignment.';

export function validStudentGeminiKey(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 20 && value.length <= MAX_GEMINI_KEY_LENGTH &&
    /^[A-Za-z0-9._~+/=-]+$/.test(value) && !/^(?:GEMINI_API_KEY|GOOGLE_API_KEY)=/i.test(value);
}
