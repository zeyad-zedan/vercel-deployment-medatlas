import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isFirebaseStorageConfigured } from './firebase-storage.ts';

describe('Firebase Storage Provider (Zero-Card Solution)', () => {
  it('1. Confirms Firebase Storage is configured via existing project credentials', () => {
    assert.equal(isFirebaseStorageConfigured(), true);
  });
});
