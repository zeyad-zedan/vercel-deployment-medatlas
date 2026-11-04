import {createRoot} from 'react-dom/client';
import {Analytics} from '@vercel/analytics/react';
import {sanitizeAnalyticsEvent,shouldEnableAnalytics} from './lib/analytics.ts';
import App from './App.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <>
    <App />
    {shouldEnableAnalytics(import.meta.env.PROD, window.location.hostname) &&
      <Analytics mode="production" beforeSend={sanitizeAnalyticsEvent} />}
  </>,
);
