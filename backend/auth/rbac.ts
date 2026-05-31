export interface User {
  id: string;
  role: 'admin' | 'operator' | 'viewer';
  permissions: string[];
}

export const PERMISSIONS = {
  READ_USERS: 'read:users',
  WRITE_USERS: 'write:users',
  DELETE_USERS: 'delete:users',
  READ_PRODUCTS: 'read:products',
  WRITE_PRODUCTS: 'write:products',
  DELETE_PRODUCTS: 'delete:products',
  READ_SUPPLIERS: 'read:suppliers',
  WRITE_SUPPLIERS: 'write:suppliers',
  DELETE_SUPPLIERS: 'delete:suppliers',
  READ_INVENTORY: 'read:inventory',
  WRITE_INVENTORY: 'write:inventory',
  DELETE_INVENTORY: 'delete:inventory',
  READ_PURCHASE_RECORDS: 'read:purchase_records',
  WRITE_PURCHASE_RECORDS: 'write:purchase_records',
  DELETE_PURCHASE_RECORDS: 'delete:purchase_records',
  READ_SALES_RECORDS: 'read:sales_records',
  WRITE_SALES_RECORDS: 'write:sales_records',
  DELETE_SALES_RECORDS: 'delete:sales_records',
  READ_MONTHLY_SUMMARY: 'read:monthly_summary',
  WRITE_MONTHLY_SUMMARY: 'write:monthly_summary',
  DELETE_MONTHLY_SUMMARY: 'delete:monthly_summary',
  READ_ORDER_RECOMMENDATIONS: 'read:order_recommendations',
  WRITE_ORDER_RECOMMENDATIONS: 'write:order_recommendations',
  DELETE_ORDER_RECOMMENDATIONS: 'delete:order_recommendations',
  READ_PRODUCT_PROPOSALS: 'read:product_proposals',
  WRITE_PRODUCT_PROPOSALS: 'write:product_proposals',
  DELETE_PRODUCT_PROPOSALS: 'delete:product_proposals',
  READ_CUSTOMERS: 'read:customers',
  WRITE_CUSTOMERS: 'write:customers',
  DELETE_CUSTOMERS: 'delete:customers',
  READ_PETS: 'read:pets',
  WRITE_PETS: 'write:pets',
  DELETE_PETS: 'delete:pets',
  READ_CUSTOMER_HISTORY: 'read:customer_history',
  WRITE_CUSTOMER_HISTORY: 'write:customer_history',
  DELETE_CUSTOMER_HISTORY: 'delete:customer_history',
  READ_DEMAND_FORECAST: 'read:demand_forecast',
  WRITE_DEMAND_FORECAST: 'write:demand_forecast',
  DELETE_DEMAND_FORECAST: 'delete:demand_forecast',
  READ_ORDER_HISTORY: 'read:order_history',
  WRITE_ORDER_HISTORY: 'write:order_history',
  DELETE_ORDER_HISTORY: 'delete:order_history',
  READ_INVENTORY_ADJUSTMENTS: 'read:inventory_adjustments',
  WRITE_INVENTORY_ADJUSTMENTS: 'write:inventory_adjustments',
  DELETE_INVENTORY_ADJUSTMENTS: 'delete:inventory_adjustments',
  BULK_IMPORT: 'bulk:import'
} as const;

export const ROLE_PERMISSIONS = {
  admin: Object.values(PERMISSIONS),
  operator: [
    PERMISSIONS.READ_USERS,
    PERMISSIONS.READ_PRODUCTS,
    PERMISSIONS.WRITE_PRODUCTS,
    PERMISSIONS.READ_SUPPLIERS,
    PERMISSIONS.WRITE_SUPPLIERS,
    PERMISSIONS.READ_INVENTORY,
    PERMISSIONS.WRITE_INVENTORY,
    PERMISSIONS.READ_PURCHASE_RECORDS,
    PERMISSIONS.WRITE_PURCHASE_RECORDS,
    PERMISSIONS.READ_SALES_RECORDS,
    PERMISSIONS.WRITE_SALES_RECORDS,
    PERMISSIONS.READ_MONTHLY_SUMMARY,
    PERMISSIONS.READ_ORDER_RECOMMENDATIONS,
    PERMISSIONS.WRITE_ORDER_RECOMMENDATIONS,
    PERMISSIONS.READ_PRODUCT_PROPOSALS,
    PERMISSIONS.WRITE_PRODUCT_PROPOSALS,
    PERMISSIONS.READ_CUSTOMERS,
    PERMISSIONS.WRITE_CUSTOMERS,
    PERMISSIONS.READ_PETS,
    PERMISSIONS.WRITE_PETS,
    PERMISSIONS.READ_CUSTOMER_HISTORY,
    PERMISSIONS.WRITE_CUSTOMER_HISTORY,
    PERMISSIONS.READ_DEMAND_FORECAST,
    PERMISSIONS.READ_ORDER_HISTORY,
    PERMISSIONS.WRITE_ORDER_HISTORY,
    PERMISSIONS.READ_INVENTORY_ADJUSTMENTS,
    PERMISSIONS.WRITE_INVENTORY_ADJUSTMENTS,
    PERMISSIONS.BULK_IMPORT
  ],
  viewer: [
    PERMISSIONS.READ_USERS,
    PERMISSIONS.READ_PRODUCTS,
    PERMISSIONS.READ_SUPPLIERS,
    PERMISSIONS.READ_INVENTORY,
    PERMISSIONS.READ_PURCHASE_RECORDS,
    PERMISSIONS.READ_SALES_RECORDS,
    PERMISSIONS.READ_MONTHLY_SUMMARY,
    PERMISSIONS.READ_ORDER_RECOMMENDATIONS,
    PERMISSIONS.READ_PRODUCT_PROPOSALS,
    PERMISSIONS.READ_CUSTOMERS,
    PERMISSIONS.READ_PETS,
    PERMISSIONS.READ_CUSTOMER_HISTORY,
    PERMISSIONS.READ_DEMAND_FORECAST,
    PERMISSIONS.READ_ORDER_HISTORY,
    PERMISSIONS.READ_INVENTORY_ADJUSTMENTS
  ]
};

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