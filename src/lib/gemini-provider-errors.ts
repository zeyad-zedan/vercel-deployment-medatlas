// Keep provider diagnostics separate from student-facing errors. Never log raw bodies.
export function inspectGeminiRateLimit(body: unknown, retryAfter: string | null, now = Date.now(), protectedValues?: readonly string[]) {
  const error = body && typeof body === 'object' ? (body as any).error : undefined;
  const details: any[] = Array.isArray(error?.details) ? error.details : [];
  const token = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_.\/-]{1,160}$/.test(value) ? value : undefined;
  const violations = details.filter(d => d?.['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure')
    .flatMap(d => Array.isArray(d.violations) ? d.violations : [])
    .map(v => ({ metric: token(v.quotaMetric), limit: token(v.quotaId), value: /^\d{1,12}$/.test(String(v.quotaValue)) ? String(v.quotaValue) : undefined }));
  const reasons = details.filter(d => d?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo')
    .map(d => token(d.reason)).filter(Boolean);
  const headerMs = retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000
    : retryAfter ? Date.parse(retryAfter) - now : 0;
  const retryDelays = details.filter(d => d?.['@type'] === 'type.googleapis.com/google.rpc.RetryInfo')
    .map(d => typeof d.retryDelay === 'string' && /^\d+(?:\.\d+)?s$/.test(d.retryDelay) ? parseFloat(d.retryDelay) * 1000 : 0);
  const retryMs = Math.min(86400000, Math.max(0, Number.isFinite(headerMs) ? headerMs : 0, ...retryDelays));
  const message = typeof error?.message === 'string' ? error.message : '';
  const explicitQuota = violations.length > 0 || error?.code === 'quota_exceeded'
    || reasons.includes('QUOTA_EXCEEDED')
    || /quota exceeded|exceeded your current quota|daily limit/i.test(message);
  const isPerDay = violations.some(v => /PerDay|Daily/i.test(v.limit || '')) || /per\s*day|daily/i.test(message);
  const minQuotaSeconds = retryMs > 0 && !isPerDay ? 10 : 60;
  let providerMessage: string | undefined;
  if(protectedValues){
    let safeMessage:string=String(message).replace(/https?:\/\/\S+/g,'[link]');
    for(const value of [...new Set(protectedValues)].filter(Boolean).sort((a,b)=>b.length-a.length)){
      if(value.length>=4)safeMessage=safeMessage.replaceAll(value,'[redacted]');
      else {
        const escaped=value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
        safeMessage=safeMessage.replace(new RegExp(`(^|\\W)${escaped}(?=\\W|$)`,'g'),'$1[redacted]');
      }
    }
    providerMessage=safeMessage.replace(/AIza[\w-]{20,}/g,'[key]')
      .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi,'[email]')
      .replace(/\b\d{8,}\b/g,'[id]').replace(/\s+/g,' ').slice(0,800);
  }
  // Only fixed vocabulary is emitted: even a provider echoing an answer or credential cannot leak it.
  const messageSignals = ['too many requests', 'quota', 'capacity', 'overload', 'resource exhausted', 'rate limit', 'try again']
    .filter(term => message.toLowerCase().replaceAll('_', ' ').includes(term));
  return {
    code: explicitQuota ? 'QUOTA' : 'THROTTLED',
    delaySeconds: Math.max(explicitQuota ? minQuotaSeconds : 10, Math.ceil(retryMs / 1000)),
    retryAfterMs: explicitQuota ? undefined : Math.max(1000, retryMs),
    diagnostics: { providerStatus: token(error?.status), providerCode: Number.isInteger(error?.code)?error.code:token(error?.code), reasons,
      quotaViolations: violations, retryAfterMs: retryMs, messageSignals, explicitQuota,
      ...(providerMessage?{providerMessage}:{}),
    },
  };
}
