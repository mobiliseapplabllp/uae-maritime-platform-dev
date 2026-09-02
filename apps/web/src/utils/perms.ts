import type { SessionUser } from '../types';
export const hasPerm = (user: SessionUser | null | undefined, perm?: string) => {
  if (!perm) return true;
  const perms = user?.perms;
  if (!Array.isArray(perms)) return false;
  return perms.includes('*') || perms.includes(perm);
};
