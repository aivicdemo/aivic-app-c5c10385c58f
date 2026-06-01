import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

const TABLE_CONFIGS = {
  '0': { name: 'ログインユーザー', pk: 'USER' },
  '1': { name: '商品マスタ', pk: 'PRODUCT' },
  '2': { name: '仕入先マスタ', pk: 'SUPPLIER' },
  '3': { name: '在庫管理', pk: 'INVENTORY' },
  '4': { name: '仕入実績', pk: 'PURCHASE' },
  '5': { name: '売上実績', pk: 'SALES' },
  '6': { name: '月次集計', pk: 'MONTHLY' },
  '7': { name: '発注推奨', pk: 'ORDER_RECOMMEND' },
  '8': { name: '商品提案情報', pk: 'PRODUCT_PROPOSAL' },
  '9': { name: '顧客マスタ', pk: 'CUSTOMER' },
  '10': { name: 'ペット情報', pk: 'PET' },
  '11': { name: '顧客利用履歴', pk: 'CUSTOMER_HISTORY' },
  '12': { name: '需要予測', pk: 'DEMAND_FORECAST' },
  '13': { name: '発注履歴', pk: 'ORDER_HISTORY' },
  '14': { name: '在庫調整履歴', pk: 'INVENTORY_ADJUSTMENT' }
};

interface ApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function createResponse(statusCode: number, body: any): ApiResponse {
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

async function createAuditLog(user: User, action: string, resource: string, details: any = {}) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.id,
    action,
    resource,
    details,
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

function validateTableIndex(tableIndex: string): string {
  if (!TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS]) {
    throw new Error('Invalid table index');
  }
  return tableIndex;
}

function addTimestamps(item: any, isUpdate: boolean = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

function generateId(): string {
  return randomUUID();
}

export const handler = async (event: any): Promise<ApiResponse> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    let user: User;
    try {
      user = extractUserFromEvent(event);
    } catch (error) {
      return createResponse(401, { error: 'Unauthorized' });
    }

    const path = event.path || event.rawPath || '';
    const method = event.httpMethod || event.requestContext?.http?.method || '';
    const pathParams = event.pathParameters || {};
    
    // GET /resources - システム全体のリソース一覧
    if (method === 'GET' && path === '/resources') {
      if (!hasPermission(user, 'system', 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }
      
      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        index,
        name: config.name,
        pk: config.pk
      }));
      
      return createResponse(200, { resources });
    }

    // テーブル別API
    const tableMatch = path.match(/^\/api\/(\d+)(?:\/([^/]+))?(?:\/(.+))?$/);
    if (!tableMatch) {
      return createResponse(404, { error: 'Not found' });
    }

    const [, tableIndex, operation, itemId] = tableMatch;
    
    try {
      validateTableIndex(tableIndex);
    } catch (error) {
      return createResponse(400, { error: 'Invalid table index' });
    }

    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const resourceName = tableConfig.name;

    // 一括インポート
    if (method === 'POST' && operation === 'bulk') {
      if (!hasPermission(user, resourceName, 'bulk')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      let requestBody;
      try {
        requestBody = JSON.parse(event.body || '{}');
      } catch (error) {
        return createResponse(400, { error: 'Invalid JSON' });
      }

      const { items } = requestBody;
      if (!Array.isArray(items)) {
        return createResponse(400, { error: 'Items must be an array' });
      }

      let imported = 0;
      let failed = 0;
      const errors: string[] = [];

      // 25件ずつに分割してバッチ処理
      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        const writeRequests = batch.map(item => {
          const processedItem = {
            ...item,
            pk: tableConfig.pk,
            sk: item.id || generateId(),
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
          imported += batch.length;
        } catch (error) {
          failed += batch.length;
          errors.push(`Batch ${Math.floor(i/25) + 1}: ${error}`);
        }
      }

      await createAuditLog(user, 'BULK_IMPORT', resourceName, {
        imported,
        failed,
        totalItems: items.length
      });

      return createResponse(200, { imported, failed, errors });
    }

    // 一覧取得
    if (method === 'GET' && !operation) {
      if (!hasPermission(user, resourceName, 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const command = new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: {
          ':pk': tableConfig.pk
        }
      });

      const result = await docClient.send(command);
      return createResponse(200, { items: result.Items || [] });
    }

    // 詳細取得
    if (method === 'GET' && operation && !itemId) {
      if (!hasPermission(user, resourceName, 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const command = new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.pk,
          sk: operation
        }
      });

      const result = await docClient.send(command);
      if (!result.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      return createResponse(200, { item: result.Item });
    }

    // 新規作成
    if (method === 'POST' && !operation) {
      if (!hasPermission(user, resourceName, 'create')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      let requestBody;
      try {
        requestBody = JSON.parse(event.body || '{}');
      } catch (error) {
        return createResponse(400, { error: 'Invalid JSON' });
      }

      const id = generateId();
      const item = {
        ...requestBody,
        pk: tableConfig.pk,
        sk: id,
        id,
        createdBy: user.id,
        updatedBy: user.id,
        ...addTimestamps(requestBody)
      };

      const command = new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      });

      await docClient.send(command);
      await createAuditLog(user, 'CREATE', resourceName, { id });

      return createResponse(201, { item });
    }

    // 更新
    if (method === 'PUT' && operation) {
      if (!hasPermission(user, resourceName, 'update')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      let requestBody;
      try {
        requestBody = JSON.parse(event.body || '{}');
      } catch (error) {
        return createResponse(400, { error: 'Invalid JSON' });
      }

      // 既存アイテムの確認
      const getCommand = new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.pk,
          sk: operation
        }
      });

      const existingItem = await docClient.send(getCommand);
      if (!existingItem.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      const updatedItem = {
        ...existingItem.Item,
        ...requestBody,
        pk: tableConfig.pk,
        sk: operation,
        updatedBy: user.id,
        ...addTimestamps(requestBody, true)
      };

      const putCommand = new PutCommand({
        TableName: TABLE_NAME,
        Item: updatedItem
      });

      await docClient.send(putCommand);
      await createAuditLog(user, 'UPDATE', resourceName, { id: operation });

      return createResponse(200, { item: updatedItem });
    }

    // 削除
    if (method === 'DELETE' && operation) {
      if (!hasPermission(user, resourceName, 'delete')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      // 既存アイテムの確認
      const getCommand = new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.pk,
          sk: operation
        }
      });

      const existingItem = await docClient.send(getCommand);
      if (!existingItem.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      const deleteCommand = new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableConfig.pk,
          sk: operation
        }
      });

      await docClient.send(deleteCommand);
      await createAuditLog(user, 'DELETE', resourceName, { id: operation });

      return createResponse(200, { message: 'Item deleted successfully' });
    }

    return createResponse(404, { error: 'Not found' });

  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};