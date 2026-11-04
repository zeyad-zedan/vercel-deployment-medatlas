import type { BeforeSendEvent } from '@vercel/analytics/react';

/** Visitor counts need page names, never recovery codes, query values or private session IDs. */
export function sanitizeAnalyticsEvent(event: BeforeSendEvent): BeforeSendEvent | null {
  try {
    const url = new URL(event.url);
    if (url.pathname.startsWith('/api/')) return null;
    url.search = ''; url.hash = '';
    url.pathname = url.pathname.replace(/^\/session\/\d+\/?$/, '/session');
    return { ...event, url: url.toString() };
  } catch { return null; }
}

export function shouldEnableAnalytics(production: boolean, hostname: string) {
  return production && !['localhost', '127.0.0.1', '[::1]'].includes(hostname) && !hostname.endsWith('.trycloudflare.com');
}
