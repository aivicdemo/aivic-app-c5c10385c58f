import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserRole, Role } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

const TABLE_CONFIGS = {
  0: { name: 'ログインユーザー', pk: 'USER' },
  1: { name: '商品マスタ', pk: 'PRODUCT' },
  2: { name: '仕入先マスタ', pk: 'SUPPLIER' },
  3: { name: '在庫管理', pk: 'INVENTORY' },
  4: { name: '仕入実績', pk: 'PURCHASE' },
  5: { name: '売上実績', pk: 'SALES' },
  6: { name: '月次集計', pk: 'MONTHLY' },
  7: { name: '発注推奨', pk: 'ORDER_RECOMMEND' },
  8: { name: '商品提案情報', pk: 'PRODUCT_PROPOSAL' },
  9: { name: '顧客マスタ', pk: 'CUSTOMER' },
  10: { name: 'ペット情報', pk: 'PET' },
  11: { name: '顧客利用履歴', pk: 'CUSTOMER_HISTORY' },
  12: { name: '需要予測', pk: 'DEMAND_FORECAST' },
  13: { name: '発注履歴', pk: 'ORDER_HISTORY' },
  14: { name: '在庫調整履歴', pk: 'INVENTORY_ADJUSTMENT' }
};

interface APIGatewayEvent {
  httpMethod: string;
  path: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  body?: string;
  headers?: { [key: string]: string };
}

interface APIGatewayResponse {
  statusCode: number;
  headers: { [key: string]: string };
  body: string;
}

function createResponse(statusCode: number, body: any): APIGatewayResponse {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    },
    body: JSON.stringify(body)
  };
}

async function writeAuditLog(action: string, resource: string, userId: string, details?: any): Promise<void> {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    action,
    resource,
    userId,
    details,
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

function validateTableIndex(tableIndex: string): number {
  const index = parseInt(tableIndex);
  if (isNaN(index) || !TABLE_CONFIGS[index as keyof typeof TABLE_CONFIGS]) {
    throw new Error('Invalid table index');
  }
  return index;
}

function addTimestamps(item: any, isUpdate = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const userRole = extractUserRole(event);
    const path = event.path;
    const method = event.httpMethod;

    // GET /resources エンドポイント
    if (method === 'GET' && path === '/resources') {
      if (!hasPermission(userRole, 'resources', 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        index: parseInt(index),
        name: config.name,
        pk: config.pk
      }));

      return createResponse(200, { resources });
    }

    // API routes pattern: /api/{tableIndex}/* または /{tableIndex}/*
    const apiMatch = path.match(/^\/(?:api\/)?([0-9]+)(?:\/(.*))?$/);
    if (!apiMatch) {
      return createResponse(404, { error: 'Not found' });
    }

    const tableIndex = validateTableIndex(apiMatch[1]);
    const subPath = apiMatch[2] || '';
    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];

    // 一括インポートエンドポイント
    if (method === 'POST' && subPath === 'bulk') {
      if (!hasPermission(userRole, tableConfig.name, 'bulk')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const body = JSON.parse(event.body || '{}');
      if (!body.items || !Array.isArray(body.items)) {
        return createResponse(400, { error: 'Invalid request body. Expected { items: [] }' });
      }

      let imported = 0;
      let failed = 0;
      const errors: string[] = [];

      // 25件ずつに分割してバッチ処理
      const chunks = [];
      for (let i = 0; i < body.items.length; i += 25) {
        chunks.push(body.items.slice(i, i + 25));
      }

      for (const chunk of chunks) {
        const writeRequests = chunk.map((item: any) => {
          const processedItem = {
            ...item,
            pk: tableConfig.pk,
            sk: item.id || randomUUID(),
            ...addTimestamps(item)
          };

          return {
            PutRequest: {
              Item: processedItem
            }
          };
        });

        try {
          await docClient.send(new BatchWriteCommand({
            RequestItems: {
              [TABLE_NAME]: writeRequests
            }
          }));
          imported += chunk.length;
        } catch (error) {
          failed += chunk.length;
          errors.push(`Batch write failed: ${error}`);
        }
      }

      await writeAuditLog('BULK_IMPORT', tableConfig.name, userRole, { imported, failed });

      return createResponse(200, { imported, failed, errors });
    }

    // CRUD operations
    if (method === 'GET' && !subPath) {
      // 一覧取得
      if (!hasPermission(userRole, tableConfig.name, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const result = await docClient.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'pk = :pk',
        ExpressionAttributeValues: {
          ':pk': tableConfig.pk
        }
      }));

      return createResponse(200, { items: result.Items || [] });
    }

    if (method === 'GET' && subPath) {
      // 詳細取得
      if (!hasPermission(userRole, tableConfig.name, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.pk,
          sk: subPath
        }
      }));

      if (!result.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      return createResponse(200, result.Item);
    }

    if (method === 'POST' && !subPath) {
      // 新規作成
      if (!hasPermission(userRole, tableConfig.name, 'create')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const body = JSON.parse(event.body || '{}');
      const item = {
        ...body,
        pk: tableConfig.pk,
        sk: body.id || randomUUID(),
        ...addTimestamps(body)
      };

      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      }));

      await writeAuditLog('CREATE', tableConfig.name, userRole, { id: item.sk });

      return createResponse(201, item);
    }

    if (method === 'PUT' && subPath) {
      // 更新
      if (!hasPermission(userRole, tableConfig.name, 'update')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const body = JSON.parse(event.body || '{}');
      const item = {
        ...body,
        pk: tableConfig.pk,
        sk: subPath,
        ...addTimestamps(body, true)
      };

      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      }));

      await writeAuditLog('UPDATE', tableConfig.name, userRole, { id: subPath });

      return createResponse(200, item);
    }

    if (method === 'DELETE' && subPath) {
      // 削除
      if (!hasPermission(userRole, tableConfig.name, 'delete')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      await docClient.send(new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.pk,
          sk: subPath
        }
      }));

      await writeAuditLog('DELETE', tableConfig.name, userRole, { id: subPath });

      return createResponse(200, { message: 'Item deleted successfully' });
    }

    return createResponse(404, { error: 'Not found' });

  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof Error) {
      if (error.message === 'Invalid table index') {
        return createResponse(400, { error: 'Invalid table index' });
      }
      if (error.message.includes('ValidationException')) {
        return createResponse(400, { error: 'Validation error' });
      }
    }

    return createResponse(500, { error: 'Internal server error' });
  }
};