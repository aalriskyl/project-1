import { describe, expect, test } from 'bun:test';
import { UnauthorizedError } from '@/lib/shared/errors.ts';
import { createAuthService } from '@/modules/auth/auth.service.ts';
import { createInMemoryDatastore } from '@/test/in-memory-repos.ts';

describe('concurrent refresh-token rotation', () => {
  test('a losing concurrent retry does not revoke the winning session family', async () => {
    const store = createInMemoryDatastore();
    const normalService = createAuthService(store.authRepo);
    const initial = await normalService.register({
      email: 'race@example.com',
      password: 'correct-horse-battery-staple',
      displayName: 'Race User',
    });
    const rotated = await normalService.refresh({
      refreshToken: initial.tokens.refreshToken,
    });

    // Simulate a second request that read the token before the first rotation committed.
    const staleReadingService = createAuthService({
      ...store.authRepo,
      findRefreshTokenWithUserByHash: async (hash) => {
        const found = await store.authRepo.findRefreshTokenWithUserByHash(hash);
        if (found === null) return null;
        return {
          ...found,
          token: { ...found.token, revokedAt: null, replacedByTokenId: null },
        };
      },
    });

    await expect(
      staleReadingService.refresh({ refreshToken: initial.tokens.refreshToken }),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    await expect(
      normalService.refresh({ refreshToken: rotated.tokens.refreshToken }),
    ).resolves.toHaveProperty('tokens.accessToken');
  });
});
