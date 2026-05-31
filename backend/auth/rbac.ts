export type Role = "admin" | "operator" | "viewer";

export const permissionMatrix: Record<Role, string[]> = {
  admin: ["*"],
  operator: ["resources:get", "bulk:write"],
  viewer: ["resources:get"],
};

export const can = (role: Role, permission: string) => {
  const grants = permissionMatrix[role] || [];
  return grants.includes("*") || grants.includes(permission);
};
