import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { User, checkPermission } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface TableConfig {
  name: string;
  pkField: string;
  skField?: string;
}

const TABLES: Record<string, TableConfig> = {
  '0': { name: 'LoginUser', pkField: 'userId' },
  '1': { name: 'ProductMaster', pkField: 'productId' },
  '2': { name: 'SupplierMaster', pkField: 'supplierId' },
  '3': { name: 'InventoryManagement', pkField: 'inventoryId' },
  '4': { name: 'PurchaseRecord', pkField: 'purchaseRecordId' },
  '5': { name: 'SalesRecord', pkField: 'salesRecordId' },
  '6': { name: 'MonthlySummary', pkField: 'summaryId' },
  '7': { name: 'OrderRecommendation', pkField: 'orderRecommendationId' },
  '8': { name: 'ProductProposal', pkField: 'proposalId' },
  '9': { name: 'CustomerMaster', pkField: 'customerId' },
  '10': { name: 'PetInfo', pkField: 'petId' },
  '11': { name: 'CustomerUsageHistory', pkField: 'usageHistoryId' },
  '12': { name: 'DemandForecast', pkField: 'demandForecastId' },
  '13': { name: 'OrderHistory', pkField: 'orderHistoryId' },
  '14': { name: 'InventoryAdjustmentHistory', pkField: 'adjustmentHistoryId' }
};

function getCurrentUser(event: APIGatewayProxyEvent): User {
  const authHeader = event.headers.Authorization || event.headers.authorization;
  if (!authHeader) {
    throw new Error('Authorization header required');
  }
  
  const role = event.headers['x-user-role'] as 'admin' | 'operator' | 'viewer';
  const userId = event.headers['x-user-id'];
  
  if (!role || !userId) {
    throw new Error('User role and ID required');
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
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-user-role, x-user-id'
    },
    body: JSON.stringify(body)
  };
}

async function createAuditLog(action: string, resource: string, userId: string, details?: any): Promise<void> {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    action,
    resource,
    userId,
    timestamp: new Date().toISOString(),
    details: details || {}
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

function validateTableIndex(tableIndex: string): TableConfig {
  const table = TABLES[tableIndex];
  if (!table) {
    throw new Error(`Invalid table index: ${tableIndex}`);
  }
  return table;
}

function addTimestamps(item: any, isUpdate: boolean = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const user = getCurrentUser(event);
    const path = event.path;
    const method = event.httpMethod;
    
    // GET /resources - 全テーブル一覧
    if (path === '/resources' && method === 'GET') {
      checkPermission(user, 'resources', 'read');
      
      const resources = Object.entries(TABLES).map(([index, config]) => ({
        index,
        name: config.name,
        pkField: config.pkField,
        skField: config.skField
      }));
      
      return createResponse(200, { resources });
    }

    // パスパラメータの解析
    const pathParts = path.split('/').filter(p => p);
    if (pathParts.length < 2 || pathParts[0] !== 'api') {
      return createResponse(404, { error: 'Not found' });
    }

    const tableIndex = pathParts[1];
    const table = validateTableIndex(tableIndex);
    const resourceId = pathParts[2];
    const isBulk = pathParts[2] === 'bulk';

    // 一括インポート
    if (method === 'POST' && isBulk) {
      checkPermission(user, table.name, 'bulk');
      
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
        const writeRequests = batch.map(item => {
          const processedItem = {
            ...item,
            [table.pkField]: item[table.pkField] || randomUUID(),
            pk: table.name,
            sk: item[table.pkField] || randomUUID()
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
          imported += batch.length;
        } catch (error) {
          failed += batch.length;
          errors.push(`Batch ${Math.floor(i/25) + 1}: ${error}`);
        }
      }

      await createAuditLog('BULK_IMPORT', table.name, user.userId, { imported, failed });
      
      return createResponse(200, { imported, failed, errors });
    }

    // 一覧取得
    if (method === 'GET' && !resourceId) {
      checkPermission(user, table.name, 'read');
      
      const result = await docClient.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'pk = :pk',
        ExpressionAttributeValues: {
          ':pk': table.name
        }
      }));
      
      return createResponse(200, { items: result.Items || [] });
    }

    // 詳細取得
    if (method === 'GET' && resourceId) {
      checkPermission(user, table.name, 'read');
      
      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: table.name,
          sk: resourceId
        }
      }));
      
      if (!result.Item) {
        return createResponse(404, { error: 'Item not found' });
      }
      
      return createResponse(200, result.Item);
    }

    // 新規作成
    if (method === 'POST' && !resourceId && !isBulk) {
      checkPermission(user, table.name, 'create');
      
      const body = JSON.parse(event.body || '{}');
      const id = body[table.pkField] || randomUUID();
      
      const item = {
        ...body,
        [table.pkField]: id,
        pk: table.name,
        sk: id,
        createdBy: user.userId,
        updatedBy: user.userId
      };
      addTimestamps(item);
      
      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      }));
      
      await createAuditLog('CREATE', table.name, user.userId, { id });
      
      return createResponse(201, item);
    }

    // 更新
    if (method === 'PUT' && resourceId) {
      checkPermission(user, table.name, 'update');
      
      const body = JSON.parse(event.body || '{}');
      
      // 既存アイテムの確認
      const existing = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: table.name,
          sk: resourceId
        }
      }));
      
      if (!existing.Item) {
        return createResponse(404, { error: 'Item not found' });
      }
      
      const updatedItem = {
        ...existing.Item,
        ...body,
        [table.pkField]: resourceId,
        pk: table.name,
        sk: resourceId,
        updatedBy: user.userId
      };
      addTimestamps(updatedItem, true);
      
      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: updatedItem
      }));
      
      await createAuditLog('UPDATE', table.name, user.userId, { id: resourceId });
      
      return createResponse(200, updatedItem);
    }

    // 削除
    if (method === 'DELETE' && resourceId) {
      checkPermission(user, table.name, 'delete');
      
      // 既存アイテムの確認
      const existing = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: table.name,
          sk: resourceId
        }
      }));
      
      if (!existing.Item) {
        return createResponse(404, { error: 'Item not found' });
      }
      
      await docClient.send(new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: table.name,
          sk: resourceId
        }
      }));
      
      await createAuditLog('DELETE', table.name, user.userId, { id: resourceId });
      
      return createResponse(200, { message: 'Item deleted successfully' });
    }

    return createResponse(405, { error: 'Method not allowed' });
    
  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof Error) {
      if (error.message.includes('Access denied')) {
        return createResponse(403, { error: error.message });
      }
      if (error.message.includes('not found') || error.message.includes('Invalid table')) {
        return createResponse(404, { error: error.message });
      }
      if (error.message.includes('required') || error.message.includes('Invalid')) {
        return createResponse(400, { error: error.message });
      }
    }
    
    return createResponse(500, { error: 'Internal server error' });
  }
};