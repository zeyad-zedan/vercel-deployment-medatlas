import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getR2Config, isR2Configured, getR2PublicUrl } from './r2-storage.ts';

describe('Cloudflare R2 Zero-Egress Storage Provider', () => {
  it('1. Reports unconfigured gracefully when environment variables are empty', () => {
    const origKey = process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_ACCESS_KEY_ID;
    try {
      assert.equal(isR2Configured(), false);
    } finally {
      if (origKey) process.env.R2_ACCESS_KEY_ID = origKey;
    }
  });

  it('2. Builds proper public CDN URL for lecture PDFs when R2_PUBLIC_URL is configured', () => {
    const origUrl = process.env.R2_PUBLIC_URL;
    process.env.R2_PUBLIC_URL = 'https://pub-abc123xyz.r2.dev';

    try {
      const url = getR2PublicUrl('1793196249718-L1_Biochemistry.pdf');
      assert.equal(url, 'https://pub-abc123xyz.r2.dev/1793196249718-L1_Biochemistry.pdf');

      // Handles trailing slash in publicUrl cleanly
      process.env.R2_PUBLIC_URL = 'https://slides.medatlas.com/';
      const customUrl = getR2PublicUrl('L2_Cell_Membrane.pdf');
      assert.equal(customUrl, 'https://slides.medatlas.com/L2_Cell_Membrane.pdf');
    } finally {
      if (origUrl !== undefined) {
        process.env.R2_PUBLIC_URL = origUrl;
      } else {
        delete process.env.R2_PUBLIC_URL;
      }
    }
  });

  it('3. Encodes special characters safely in PDF filenames for public URL', () => {
    const origUrl = process.env.R2_PUBLIC_URL;
    process.env.R2_PUBLIC_URL = 'https://pub-test.r2.dev';
    try {
      const url = getR2PublicUrl('Lecture #1 & Slides (2026).pdf');
      assert.ok(url?.includes('Lecture%20%231%20%26%20Slides%20(2026).pdf'));
    } finally {
      if (origUrl !== undefined) {
        process.env.R2_PUBLIC_URL = origUrl;
      } else {
        delete process.env.R2_PUBLIC_URL;
      }
    }
  });
});
