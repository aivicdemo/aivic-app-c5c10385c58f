import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { can, type Role } from "../auth/rbac";

type Event = {
  path: string;
  httpMethod: string;
  pathParameters?: Record<string, string> | null;
  requestContext?: { authorizer?: { role?: Role } };
  body?: string | null;
};

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const tableName = process.env.MAIN_TABLE || "aivic_app_records";
const nowIso = () => new Date().toISOString();
const newId = () => typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const parseBody = (body?: string | null) => {
  if (!body) return {};
  try { return JSON.parse(body); } catch { return {}; }
};

const writeAuditLog = async (action: string, role: Role, detail: Record<string, unknown>) => {
  const ts = nowIso();
  await db.send(new PutCommand({
    TableName: tableName,
    Item: { pk: "AUDIT", sk: `LOG#${ts}#${Math.random().toString(36).slice(2, 8)}`, action, role, detail, createdAt: ts },
  }));
};

const bulkWrite = async (items: Record<string, unknown>[]): Promise<{ imported: number; failed: number; errors: string[] }> => {
  const now = nowIso();
  const prepared = items.map((item) => ({ ...item, id: item.id || newId(), createdAt: item.createdAt || now, updatedAt: now }));
  let imported = 0;
  const errors: string[] = [];
  const chunks: Record<string, unknown>[][] = [];
  for (let i = 0; i < prepared.length; i += 25) chunks.push(prepared.slice(i, i + 25));
  for (const chunk of chunks) {
    try {
      await db.send(new BatchWriteCommand({ RequestItems: { [tableName]: chunk.map((item) => ({ PutRequest: { Item: item } })) } }));
      imported += chunk.length;
    } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); }
  }
  return { imported, failed: items.length - imported, errors };
};

export const handler = async (event: Event) => {
  const role = (event.requestContext?.authorizer?.role || "viewer") as Role;
  try {
    const bulkMatch = event.path.match(/^\/api\/(\d+)\/bulk$/);
    if (bulkMatch && event.httpMethod === "POST") {
      if (!can(role, "bulk:write")) return json(403, { message: "forbidden" });
      const body = parseBody(event.body);
      const items: Record<string, unknown>[] = Array.isArray(body.items) ? body.items : [];
      if (items.length === 0) return json(400, { message: "items array is required" });
      const result = await bulkWrite(items);
      await writeAuditLog("bulk_import", role, { tableIndex: bulkMatch[1], count: result.imported });
      return json(200, result);
    }
  if (event.path === "/resources" && event.httpMethod === "GET") {
    if (!can(role, "resources:get")) return json(403, { message: "forbidden" });
    return json(200, { ok: true, route: "GET /resources" });
  }
    return json(404, { message: "not found" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return json(500, { message: "internal error", detail });
  }
};
