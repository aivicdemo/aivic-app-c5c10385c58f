export type Role = 'admin' | 'operator' | 'viewer';

export interface Permission {
  read: boolean;
  write: boolean;
  delete: boolean;
}

export const ROLE_PERMISSIONS: Record<Role, Permission> = {
  admin: { read: true, write: true, delete: true },
  operator: { read: true, write: true, delete: false },
  viewer: { read: true, write: false, delete: false }
};

export function hasPermission(role: Role, action: 'read' | 'write' | 'delete'): boolean {
  const permissions = ROLE_PERMISSIONS[role];
  return permissions[action];
}

export function validateRole(role: string): Role {
  if (role === 'admin' || role === 'operator' || role === 'viewer') {
    return role;
  }
  throw new Error('Invalid role');
}