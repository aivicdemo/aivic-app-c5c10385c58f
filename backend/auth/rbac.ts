export type Role = 'admin' | 'operator' | 'viewer';

export interface Permission {
  resource: string;
  actions: string[];
}

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: [
    { resource: '*', actions: ['*'] }
  ],
  operator: [
    { resource: 'users', actions: ['read'] },
    { resource: 'products', actions: ['create', 'read', 'update', 'delete', 'bulk'] },
    { resource: 'suppliers', actions: ['create', 'read', 'update', 'delete', 'bulk'] },
    { resource: 'inventory', actions: ['create', 'read', 'update', 'delete', 'bulk'] },
    { resource: 'purchase-records', actions: ['create', 'read', 'update', 'delete', 'bulk'] },
    { resource: 'sales-records', actions: ['create', 'read', 'update', 'delete', 'bulk'] },
    { resource: 'monthly-summary', actions: ['create', 'read', 'update', 'delete', 'bulk'] },
    { resource: 'order-recommendations', actions: ['create', 'read', 'update', 'delete', 'bulk'] },
    { resource: 'product-proposals', actions: ['create', 'read', 'update', 'delete', 'bulk'] },
    { resource: 'customers', actions: ['create', 'read', 'update', 'delete', 'bulk'] },
    { resource: 'pets', actions: ['create', 'read', 'update', 'delete', 'bulk'] },
    { resource: 'customer-history', actions: ['create', 'read', 'update', 'delete', 'bulk'] },
    { resource: 'demand-forecast', actions: ['create', 'read', 'update', 'delete', 'bulk'] },
    { resource: 'order-history', actions: ['create', 'read', 'update', 'delete', 'bulk'] },
    { resource: 'inventory-adjustments', actions: ['create', 'read', 'update', 'delete', 'bulk'] }
  ],
  viewer: [
    { resource: 'users', actions: ['read'] },
    { resource: 'products', actions: ['read'] },
    { resource: 'suppliers', actions: ['read'] },
    { resource: 'inventory', actions: ['read'] },
    { resource: 'purchase-records', actions: ['read'] },
    { resource: 'sales-records', actions: ['read'] },
    { resource: 'monthly-summary', actions: ['read'] },
    { resource: 'order-recommendations', actions: ['read'] },
    { resource: 'product-proposals', actions: ['read'] },
    { resource: 'customers', actions: ['read'] },
    { resource: 'pets', actions: ['read'] },
    { resource: 'customer-history', actions: ['read'] },
    { resource: 'demand-forecast', actions: ['read'] },
    { resource: 'order-history', actions: ['read'] },
    { resource: 'inventory-adjustments', actions: ['read'] }
  ]
};

export function hasPermission(role: Role, resource: string, action: string): boolean {
  const permissions = ROLE_PERMISSIONS[role];
  
  return permissions.some(permission => {
    const resourceMatch = permission.resource === '*' || permission.resource === resource;
    const actionMatch = permission.actions.includes('*') || permission.actions.includes(action);
    return resourceMatch && actionMatch;
  });
}

export function checkPermission(role: Role, resource: string, action: string): void {
  if (!hasPermission(role, resource, action)) {
    throw new Error(`Access denied: ${role} cannot ${action} ${resource}`);
  }
}