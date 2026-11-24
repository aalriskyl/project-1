import type { Logger } from 'pino';

export const USER_ROLES = ['user', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
}

export interface AppVariables {
  requestId: string;
  logger: Logger;
  user?: AuthUser;
}

export interface AppEnv {
  Variables: AppVariables;
}
