import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { hasPermission, validateRole, Role } from './rbac';
import * as crypto from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface AuthContext {
  userId: string;
  role: Role;
}

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

function getAuthContext(event: APIGatewayProxyEvent): AuthContext {
  const userId = event.headers['x-user-id'] || 'anonymous';
  const role = event.headers['x-user-role'] || 'viewer';
  
  if (!validateRole(role)) {
    throw new Error('Invalid role');
  }
  
  return { userId, role };
}

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-user-id, x-user-role'
    },
    body: JSON.stringify(body)
  };
}

async function writeAuditLog(action: string, tableName: string, userId: string, details?: any) {
  const auditItem = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${crypto.randomUUID()}`,
    action,
    tableName,
    userId,
    details,
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditItem
  }));
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const auth = getAuthContext(event);
    const path = event.path;
    const method = event.httpMethod;

    // GET /resources エンドポイント
    if (method === 'GET' && path === '/resources') {
      if (!hasPermission(auth.role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        index: parseInt(index),
        name: config.name,
        pk: config.pk
      }));

      return createResponse(200, { resources });
    }

    // テーブル操作エンドポイント
    const tableMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(\w+))?$/);
    if (!tableMatch) {
      return createResponse(404, { error: 'Endpoint not found' });
    }

    const tableIndex = parseInt(tableMatch[1]);
    const operation = tableMatch[2];
    const itemId = tableMatch[3];

    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }

    // 一括インポートエンドポイント
    if (method === 'POST' && operation === 'bulk') {
      if (!hasPermission(auth.role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const body = JSON.parse(event.body || '{}');
      const items = body.items || [];

      if (!Array.isArray(items)) {
        return createResponse(400, { error: 'Items must be an array' });
      }

      let imported = 0;
      let failed = 0;
      const errors: string[] = [];

      // 25件ずつに分割してバッチ処理
      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        const putRequests = batch.map(item => {
          const now = new Date().toISOString();
          return {
            PutRequest: {
              Item: {
                pk: tableConfig.pk,
                sk: item.id || crypto.randomUUID(),
                ...item,
                createdAt: now,
                updatedAt: now,
                createdBy: auth.userId,
                updatedBy: auth.userId
              }
            }
          };
        });

        try {
          await docClient.send(new BatchWriteCommand({
            RequestItems: {
              [TABLE_NAME]: putRequests
            }
          }));
          imported += batch.length;
        } catch (error) {
          failed += batch.length;
          errors.push(`Batch ${Math.floor(i/25) + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      await writeAuditLog('BULK_IMPORT', tableConfig.name, auth.userId, { imported, failed });

      return createResponse(200, { imported, failed, errors });
    }

    // 一覧取得
    if (method === 'GET' && !operation) {
      if (!hasPermission(auth.role, 'read')) {
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

    // 詳細取得
    if (method === 'GET' && operation && !itemId) {
      if (!hasPermission(auth.role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.pk,
          sk: operation
        }
      }));

      if (!result.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      return createResponse(200, result.Item);
    }

    // 新規作成
    if (method === 'POST' && !operation) {
      if (!hasPermission(auth.role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const body = JSON.parse(event.body || '{}');
      const now = new Date().toISOString();
      const id = crypto.randomUUID();

      const item = {
        pk: tableConfig.pk,
        sk: id,
        ...body,
        createdAt: now,
        updatedAt: now,
        createdBy: auth.userId,
        updatedBy: auth.userId
      };

      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      }));

      await writeAuditLog('CREATE', tableConfig.name, auth.userId, { id });

      return createResponse(201, item);
    }

    // 更新
    if (method === 'PUT' && operation) {
      if (!hasPermission(auth.role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const body = JSON.parse(event.body || '{}');
      const now = new Date().toISOString();

      // 既存アイテムの確認
      const existing = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.pk,
          sk: operation
        }
      }));

      if (!existing.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      const updatedItem = {
        ...existing.Item,
        ...body,
        updatedAt: now,
        updatedBy: auth.userId
      };

      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: updatedItem
      }));

      await writeAuditLog('UPDATE', tableConfig.name, auth.userId, { id: operation });

      return createResponse(200, updatedItem);
    }

    // 削除
    if (method === 'DELETE' && operation) {
      if (!hasPermission(auth.role, 'delete')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      // 既存アイテムの確認
      const existing = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.pk,
          sk: operation
        }
      }));

      if (!existing.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      await docClient.send(new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.pk,
          sk: operation
        }
      }));

      await writeAuditLog('DELETE', tableConfig.name, auth.userId, { id: operation });

      return createResponse(200, { message: 'Item deleted successfully' });
    }

    return createResponse(404, { error: 'Endpoint not found' });

  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof Error && error.message === 'Invalid role') {
      return createResponse(403, { error: 'Invalid role' });
    }
    
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON in request body' });
    }
    
    return createResponse(500, { 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};