import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createUser, checkPermission, PERMISSIONS } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE || 'inventory-management';

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

function getUserFromEvent(event: APIGatewayProxyEvent) {
  const authHeader = event.headers.Authorization || event.headers.authorization;
  if (!authHeader) {
    throw new Error('Authorization header required');
  }
  
  const token = authHeader.replace('Bearer ', '');
  const [userId, role] = token.split(':');
  
  if (!userId || !role || !['admin', 'operator', 'viewer'].includes(role)) {
    throw new Error('Invalid authorization token');
  }
  
  return createUser(userId, role as 'admin' | 'operator' | 'viewer');
}

async function writeAuditLog(action: string, userId: string, details: any) {
  const auditItem = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    action,
    userId,
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
    throw new Error(`Invalid table index: ${tableIndex}`);
  }
  return tableIndex;
}

function addTimestamps(item: any, isUpdate = false) {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const user = getUserFromEvent(event);
    const path = event.path;
    const method = event.httpMethod;
    
    // GET /resources - リソース一覧取得
    if (method === 'GET' && path === '/resources') {
      checkPermission(user, PERMISSIONS.READ_ALL);
      
      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        index,
        name: config.name,
        pk: config.pk
      }));
      
      return createResponse(200, { resources });
    }
    
    // パスパラメータの解析
    const pathParts = path.split('/').filter(p => p);
    
    if (pathParts.length < 2) {
      return createResponse(400, { error: 'Invalid path format' });
    }
    
    const tableIndex = validateTableIndex(pathParts[1]);
    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    // 一括インポート: POST /api/{tableIndex}/bulk
    if (method === 'POST' && pathParts[2] === 'bulk') {
      checkPermission(user, PERMISSIONS.BULK_IMPORT);
      
      const body = JSON.parse(event.body || '{}');
      if (!body.items || !Array.isArray(body.items)) {
        return createResponse(400, { error: 'items array is required' });
      }
      
      let imported = 0;
      let failed = 0;
      const errors: string[] = [];
      
      const chunks = chunkArray(body.items, 25);
      
      for (const chunk of chunks) {
        const writeRequests = chunk.map(item => {
          const processedItem = {
            ...item,
            pk: config.pk,
            sk: item.id || randomUUID(),
            id: item.id || randomUUID()
          };
          addTimestamps(processedItem);
          
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
          errors.push(`Batch write failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
      
      await writeAuditLog('BULK_IMPORT', user.id, {
        tableIndex,
        tableName: config.name,
        imported,
        failed
      });
      
      return createResponse(200, { imported, failed, errors });
    }
    
    // 一覧取得: GET /api/{tableIndex}
    if (method === 'GET' && pathParts.length === 2) {
      checkPermission(user, PERMISSIONS.READ_ALL);
      
      const result = await docClient.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'pk = :pk',
        ExpressionAttributeValues: {
          ':pk': config.pk
        }
      }));
      
      return createResponse(200, { items: result.Items || [] });
    }
    
    // 詳細取得: GET /api/{tableIndex}/{id}
    if (method === 'GET' && pathParts.length === 3) {
      checkPermission(user, PERMISSIONS.READ_ALL);
      
      const id = pathParts[2];
      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: config.pk,
          sk: id
        }
      }));
      
      if (!result.Item) {
        return createResponse(404, { error: 'Item not found' });
      }
      
      return createResponse(200, result.Item);
    }
    
    // 新規作成: POST /api/{tableIndex}
    if (method === 'POST' && pathParts.length === 2) {
      checkPermission(user, PERMISSIONS.WRITE_ALL);
      
      const body = JSON.parse(event.body || '{}');
      const id = body.id || randomUUID();
      
      const item = {
        ...body,
        pk: config.pk,
        sk: id,
        id,
        createdBy: user.id,
        updatedBy: user.id
      };
      
      addTimestamps(item);
      
      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      }));
      
      await writeAuditLog('CREATE', user.id, {
        tableIndex,
        tableName: config.name,
        itemId: id
      });
      
      return createResponse(201, item);
    }
    
    // 更新: PUT /api/{tableIndex}/{id}
    if (method === 'PUT' && pathParts.length === 3) {
      checkPermission(user, PERMISSIONS.WRITE_ALL);
      
      const id = pathParts[2];
      const body = JSON.parse(event.body || '{}');
      
      // 既存アイテムの確認
      const existing = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: config.pk,
          sk: id
        }
      }));
      
      if (!existing.Item) {
        return createResponse(404, { error: 'Item not found' });
      }
      
      const item = {
        ...existing.Item,
        ...body,
        pk: config.pk,
        sk: id,
        id,
        updatedBy: user.id
      };
      
      addTimestamps(item, true);
      
      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      }));
      
      await writeAuditLog('UPDATE', user.id, {
        tableIndex,
        tableName: config.name,
        itemId: id
      });
      
      return createResponse(200, item);
    }
    
    // 削除: DELETE /api/{tableIndex}/{id}
    if (method === 'DELETE' && pathParts.length === 3) {
      checkPermission(user, PERMISSIONS.DELETE_ALL);
      
      const id = pathParts[2];
      
      // 既存アイテムの確認
      const existing = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: config.pk,
          sk: id
        }
      }));
      
      if (!existing.Item) {
        return createResponse(404, { error: 'Item not found' });
      }
      
      await docClient.send(new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: config.pk,
          sk: id
        }
      }));
      
      await writeAuditLog('DELETE', user.id, {
        tableIndex,
        tableName: config.name,
        itemId: id
      });
      
      return createResponse(200, { message: 'Item deleted successfully' });
    }
    
    return createResponse(404, { error: 'Endpoint not found' });
    
  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof Error) {
      if (error.message.includes('Authorization') || error.message.includes('permissions')) {
        return createResponse(403, { error: error.message });
      }
      if (error.message.includes('Invalid')) {
        return createResponse(400, { error: error.message });
      }
    }
    
    return createResponse(500, { 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};