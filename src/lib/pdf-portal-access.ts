export function isPdfPortalOriginAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  try { const parsed = new URL(origin); return ['http:', 'https:'].includes(parsed.protocol) && parsed.host === host; }
  catch { return false; }
}
