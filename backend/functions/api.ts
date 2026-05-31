import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
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
  const auditItem = {
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
    Item: auditItem
  }));
}

function validateTableIndex(tableIndex: string): string {
  if (!TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS]) {
    throw new Error('Invalid table index');
  }
  return tableIndex;
}

function addTimestamps(item: any, isUpdate = false): any {
  const now = new Date().toISOString();
  const result = { ...item };
  
  if (!isUpdate) {
    result.createdAt = now;
  }
  result.updatedAt = now;
  
  return result;
}

export const handler = async (event: any): Promise<ApiResponse> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const path = event.path || event.rawPath || '';
    const method = event.httpMethod || event.requestContext?.http?.method || '';
    
    // GET /resources - リソース一覧取得
    if (method === 'GET' && path === '/resources') {
      try {
        const user = extractUserFromEvent(event);
        if (!hasPermission(user, 'resources', 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
          index,
          name: config.name,
          pk: config.pk
        }));
        
        return createResponse(200, { resources });
      } catch (error) {
        return createResponse(401, { error: 'Unauthorized' });
      }
    }

    // パスパラメータ解析
    const pathMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(\w+))?$/);
    if (!pathMatch) {
      return createResponse(404, { error: 'Not found' });
    }

    const [, tableIndex, action, itemId] = pathMatch;
    
    try {
      validateTableIndex(tableIndex);
    } catch (error) {
      return createResponse(400, { error: 'Invalid table index' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    let user: User;
    
    try {
      user = extractUserFromEvent(event);
    } catch (error) {
      return createResponse(401, { error: 'Unauthorized' });
    }

    // 一括インポート
    if (method === 'POST' && action === 'bulk') {
      if (!hasPermission(user, config.pk, 'bulk')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      try {
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
            const processedItem = addTimestamps({
              ...item,
              pk: config.pk,
              sk: item.id || randomUUID(),
              id: item.id || randomUUID()
            });
            
            return {
              PutRequest: {
                Item: processedItem
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
            errors.push(`Batch ${Math.floor(i / 25) + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }

        await createAuditLog(user, 'BULK_IMPORT', config.pk, { imported, failed, total: items.length });
        
        return createResponse(200, { imported, failed, errors });
      } catch (error) {
        return createResponse(400, { error: 'Invalid request body' });
      }
    }

    // 一覧取得
    if (method === 'GET' && !itemId) {
      if (!hasPermission(user, config.pk, 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      try {
        const result = await docClient.send(new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: 'pk = :pk',
          ExpressionAttributeValues: {
            ':pk': config.pk
          }
        }));

        return createResponse(200, { items: result.Items || [] });
      } catch (error) {
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // 詳細取得
    if (method === 'GET' && itemId) {
      if (!hasPermission(user, config.pk, 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      try {
        const result = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: config.pk,
            sk: itemId
          }
        }));

        if (!result.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        return createResponse(200, result.Item);
      } catch (error) {
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // 新規作成
    if (method === 'POST' && !itemId) {
      if (!hasPermission(user, config.pk, 'create')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      try {
        const body = JSON.parse(event.body || '{}');
        const id = body.id || randomUUID();
        
        const item = addTimestamps({
          ...body,
          pk: config.pk,
          sk: id,
          id,
          createdBy: user.id,
          updatedBy: user.id
        });

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        }));

        await createAuditLog(user, 'CREATE', config.pk, { id });
        
        return createResponse(201, item);
      } catch (error) {
        return createResponse(400, { error: 'Invalid request body' });
      }
    }

    // 更新
    if (method === 'PUT' && itemId) {
      if (!hasPermission(user, config.pk, 'update')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      try {
        const body = JSON.parse(event.body || '{}');
        
        // 既存アイテムの存在確認
        const existing = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: config.pk,
            sk: itemId
          }
        }));

        if (!existing.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        const item = addTimestamps({
          ...existing.Item,
          ...body,
          pk: config.pk,
          sk: itemId,
          id: itemId,
          updatedBy: user.id
        }, true);

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        }));

        await createAuditLog(user, 'UPDATE', config.pk, { id: itemId });
        
        return createResponse(200, item);
      } catch (error) {
        return createResponse(400, { error: 'Invalid request body' });
      }
    }

    // 削除
    if (method === 'DELETE' && itemId) {
      if (!hasPermission(user, config.pk, 'delete')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      try {
        // 既存アイテムの存在確認
        const existing = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: config.pk,
            sk: itemId
          }
        }));

        if (!existing.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: config.pk,
            sk: itemId
          }
        }));

        await createAuditLog(user, 'DELETE', config.pk, { id: itemId });
        
        return createResponse(200, { message: 'Item deleted successfully' });
      } catch (error) {
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    return createResponse(405, { error: 'Method not allowed' });
    
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};