import { describe, expect, test } from 'bun:test';
import { mediaEntityLockKey } from '@/modules/media/media-attachments.repository.ts';

describe('media advisory lock keys', () => {
  test('are stable per entity and distinct across entities', () => {
    const productA = mediaEntityLockKey('products', 'product-a');
    const productB = mediaEntityLockKey('products', 'product-b');
    const categoryA = mediaEntityLockKey('categories', 'product-a');

    expect(mediaEntityLockKey('products', 'product-a')).toBe(productA);
    expect(productA).not.toBe(productB);
    expect(productA).not.toBe(categoryA);
  });
});
