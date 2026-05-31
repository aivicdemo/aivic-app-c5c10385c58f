export interface User {
  userId: string;
  loginId: string;
  userName: string;
  email?: string;
  role: 'admin' | 'operator' | 'viewer';
  isActive: boolean;
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
  if (!user.isActive) return false;
  
  const permissions = ROLE_PERMISSIONS[user.role] || [];
  return permissions.some(p => 
    (p.resource === '*' || p.resource === resource) && 
    (p.action === action)
  );
}

export function extractUserFromEvent(event: any): User | null {
  try {
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    if (!authHeader) return null;
    
    const token = authHeader.replace('Bearer ', '');
    const decoded = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    
    return {
      userId: decoded.userId || 'anonymous',
      loginId: decoded.loginId || 'anonymous',
      userName: decoded.userName || 'Anonymous User',
      email: decoded.email,
      role: decoded.role || 'viewer',
      isActive: decoded.isActive !== false
    };
  } catch {
    return {
      userId: 'anonymous',
      loginId: 'anonymous', 
      userName: 'Anonymous User',
      role: 'viewer',
      isActive: true
    };
  }
}