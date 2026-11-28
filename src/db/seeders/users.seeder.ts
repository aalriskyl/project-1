import { eq } from 'drizzle-orm';
import type { Database } from '@/db/client.ts';
import { users } from '@/db/schema/users.ts';
import type { SeededUsersResult } from '@/db/seeders/types.ts';
import { generateId } from '@/lib/auth/id.ts';
import { hashPassword } from '@/lib/auth/password.ts';
import type { UserRole } from '@/types/app.ts';

interface SeedUserSpec {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  readonly phone: string | null;
  readonly address: string | null;
  readonly role: UserRole;
}

export interface SeedUsersOptions {
  readonly adminEmail: string;
  readonly adminPassword: string;
  readonly customerEmail: string;
  readonly customerPassword: string;
  readonly devSuperAdmin?: {
    readonly email: string;
    readonly password: string;
  };
}

async function ensureUser(database: Database, spec: SeedUserSpec): Promise<string> {
  const normalizedEmail = spec.email.trim().toLowerCase();
  const [existing] = await database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);

  if (existing !== undefined) {
    return existing.id;
  }

  const id = generateId();
  const passwordHash = await hashPassword(spec.password);
  await database.insert(users).values({
    id,
    email: normalizedEmail,
    passwordHash,
    displayName: spec.displayName,
    phone: spec.phone,
    address: spec.address,
    role: spec.role,
  });
  return id;
}

/**
 * Seeds admin, primary customer, and secondary reviewer accounts idempotently.
 */
export async function seedUsers(
  database: Database,
  options: SeedUsersOptions,
): Promise<SeededUsersResult> {
  const adminId = await ensureUser(database, {
    email: options.adminEmail,
    password: options.adminPassword,
    displayName: 'Tsuzumi Admin',
    phone: '+628111000222',
    address: 'Jl. Pangeran Jayakarta No. 129, Jakarta Pusat',
    role: 'admin',
  });

  const customerId = await ensureUser(database, {
    email: options.customerEmail,
    password: options.customerPassword,
    displayName: 'Andi Pratama',
    phone: '+6281234567890',
    address: 'Jl. Industri Raya No. 45, Cikarang, Bekasi',
    role: 'user',
  });

  const reviewerId = await ensureUser(database, {
    email: 'budi.reviewer@tsuzumi.test',
    password: options.customerPassword,
    displayName: 'Budi Santoso',
    phone: '+6281298765432',
    address: 'Jl. Raya Darmo No. 88, Surabaya',
    role: 'user',
  });

  let count = 3;
  if (options.devSuperAdmin !== undefined) {
    await ensureUser(database, {
      email: options.devSuperAdmin.email,
      password: options.devSuperAdmin.password,
      displayName: 'Pelangi Superadmin',
      phone: '+628111000001',
      address: 'Jl. Pangeran Jayakarta No. 129, Jakarta Pusat',
      role: 'admin',
    });
    count += 1;
  }

  return {
    adminId,
    customerId,
    reviewerId,
    count,
  };
}
