const ARGON2_MEMORY_COST_KIB = 65_536; // 64 MiB
const ARGON2_TIME_COST = 2;

let cachedDummyHashPromise: Promise<string> | undefined;

function getDummyHash(): Promise<string> {
  cachedDummyHashPromise ??= hashPassword('dummy-password-for-constant-time-auth-check');
  return cachedDummyHashPromise;
}

/**
 * Hashes a plaintext password using Bun's native Argon2id implementation.
 */
export async function hashPassword(plainPassword: string): Promise<string> {
  return Bun.password.hash(plainPassword, {
    algorithm: 'argon2id',
    memoryCost: ARGON2_MEMORY_COST_KIB,
    timeCost: ARGON2_TIME_COST,
  });
}

/**
 * Verifies a plaintext password against an Argon2id hash.
 */
export async function verifyPassword(
  plainPassword: string,
  passwordHash: string,
): Promise<boolean> {
  return Bun.password.verify(plainPassword, passwordHash);
}

/**
 * Runs a full Argon2id verification against a dummy hash when an account does not exist
 * so login latency does not leak account existence.
 */
export async function verifyAgainstDummyPassword(plainPassword: string): Promise<void> {
  const dummyHash = await getDummyHash();
  await Bun.password.verify(plainPassword, dummyHash);
}
