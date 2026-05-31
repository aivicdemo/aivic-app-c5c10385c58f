export interface User {
  id: string;
  role: 'admin' | 'operator' | 'viewer';
  permissions: string[];
}

export const ROLES = {
  admin: {
    permissions: [
      'read:all',
      'write:all',
      'delete:all',
      'bulk:import'
    ]
  },
  operator: {
    permissions: [
      'read:all',
      'write:all',
      'bulk:import'
    ]
  },
  viewer: {
    permissions: [
      'read:all'
    ]
  }
} as const;

export function hasPermission(user: User, permission: string): boolean {
  return user.permissions.includes(permission) || user.permissions.includes('write:all');
}

export function checkPermission(user: User, permission: string): void {
  if (!hasPermission(user, permission)) {
    throw new Error(`Insufficient permissions. Required: ${permission}`);
  }
}

export function getUserFromEvent(event: any): User {
  const authHeader = event.headers?.Authorization || event.headers?.authorization;
  if (!authHeader) {
    throw new Error('No authorization header');
  }
  
  // Mock user extraction - in real implementation, decode JWT token
  const mockUser: User = {
    id: 'user-123',
    role: 'admin',
    permissions: ROLES.admin.permissions
  };
  
  return mockUser;
}