export interface User {
  id: string;
  role: 'admin' | 'operator' | 'viewer';
  permissions: string[];
}

export const PERMISSIONS = {
  READ_ALL: 'read:all',
  WRITE_ALL: 'write:all',
  DELETE_ALL: 'delete:all',
  BULK_IMPORT: 'bulk:import'
} as const;

export const ROLE_PERMISSIONS = {
  admin: [PERMISSIONS.READ_ALL, PERMISSIONS.WRITE_ALL, PERMISSIONS.DELETE_ALL, PERMISSIONS.BULK_IMPORT],
  operator: [PERMISSIONS.READ_ALL, PERMISSIONS.WRITE_ALL, PERMISSIONS.BULK_IMPORT],
  viewer: [PERMISSIONS.READ_ALL]
} as const;

export function hasPermission(user: User, permission: string): boolean {
  return user.permissions.includes(permission);
}

export function createUser(id: string, role: 'admin' | 'operator' | 'viewer'): User {
  return {
    id,
    role,
    permissions: ROLE_PERMISSIONS[role]
  };
}

export function checkPermission(user: User, permission: string): void {
  if (!hasPermission(user, permission)) {
    throw new Error(`Insufficient permissions. Required: ${permission}`);
  }
}