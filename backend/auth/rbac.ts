export interface User {
  id: string;
  role: 'admin' | 'operator' | 'viewer';
}

export interface Permission {
  resource: string;
  action: 'create' | 'read' | 'update' | 'delete' | 'bulk';
}

const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  admin: [
    { resource: '*', action: 'create' },
    { resource: '*', action: 'read' },
    { resource: '*', action: 'update' },
    { resource: '*', action: 'delete' },
    { resource: '*', action: 'bulk' }
  ],
  operator: [
    { resource: '*', action: 'create' },
    { resource: '*', action: 'read' },
    { resource: '*', action: 'update' },
    { resource: '*', action: 'bulk' }
  ],
  viewer: [
    { resource: '*', action: 'read' }
  ]
};

export function hasPermission(user: User, resource: string, action: string): boolean {
  const permissions = ROLE_PERMISSIONS[user.role] || [];
  return permissions.some(p => 
    (p.resource === '*' || p.resource === resource) && 
    (p.action === action)
  );
}

export function checkPermission(user: User, resource: string, action: string): void {
  if (!hasPermission(user, resource, action)) {
    throw new Error(`Access denied: ${user.role} cannot ${action} ${resource}`);
  }
}