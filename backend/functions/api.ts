import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
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
  '7': { name: '発注推奨', pk: 'ORDER_REC' },
  '8': { name: '商品提案情報', pk: 'PROPOSAL' },
  '9': { name: '顧客マスタ', pk: 'CUSTOMER' },
  '10': { name: 'ペット情報', pk: 'PET' },
  '11': { name: '顧客利用履歴', pk: 'USAGE' },
  '12': { name: '需要予測', pk: 'FORECAST' },
  '13': { name: '発注履歴', pk: 'ORDER_HIST' },
  '14': { name: '在庫調整履歴', pk: 'ADJUST_HIST' }
};

interface APIGatewayEvent {
  httpMethod: string;
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

async function writeAuditLog(user: User, action: string, resource: string, details: any = {}) {
  const auditRecord = {
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
    Item: auditRecord
  }));
}

function validateTableIndex(tableIndex: string): boolean {
  return tableIndex in TABLE_CONFIGS;
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

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const path = event.pathParameters?.proxy || '';
    const pathParts = path.split('/');
    
    if (pathParts[0] === 'resources') {
      return await handleResourcesEndpoint(event);
    }
    
    if (pathParts[0] === 'api' && pathParts.length >= 2) {
      const tableIndex = pathParts[1];
      if (!validateTableIndex(tableIndex)) {
        return createResponse(404, { error: 'Table not found' });
      }
      
      if (pathParts.length === 3 && pathParts[2] === 'bulk') {
        return await handleBulkImport(event, tableIndex);
      }
      
      return await handleTableOperations(event, tableIndex, pathParts);
    }
    
    return createResponse(404, { error: 'Endpoint not found' });
    
  } catch (error: any) {
    console.error('Handler error:', error);
    if (error.message.includes('Authorization') || error.message.includes('token')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    return createResponse(500, { error: 'Internal server error', details: error.message });
  }
};

async function handleResourcesEndpoint(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  try {
    const user = extractUserFromEvent(event);
    
    if (!hasPermission(user, 'resources', 'read')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }
    
    const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
      index,
      name: config.name,
      pk: config.pk
    }));
    
    return createResponse(200, { resources });
  } catch (error: any) {
    if (error.message.includes('Authorization')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleBulkImport(event: APIGatewayEvent, tableIndex: string): Promise<APIGatewayResponse> {
  try {
    const user = extractUserFromEvent(event);
    
    if (!hasPermission(user, 'bulk', 'bulk')) {
      return createResponse(403, { error: 'Insufficient permissions for bulk operations' });
    }
    
    if (event.httpMethod !== 'POST') {
      return createResponse(405, { error: 'Method not allowed' });
    }
    
    const body = JSON.parse(event.body || '{}');
    const items = body.items || [];
    
    if (!Array.isArray(items)) {
      return createResponse(400, { error: 'Items must be an array' });
    }
    
    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    let imported = 0;
    let failed = 0;
    const errors: string[] = [];
    
    // Process in batches of 25 (DynamoDB BatchWrite limit)
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      const writeRequests = batch.map(item => {
        const processedItem = {
          ...item,
          pk: config.pk,
          sk: item.id || generateId(),
          ...addTimestamps(item, false)
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
      } catch (error: any) {
        failed += batch.length;
        errors.push(`Batch ${Math.floor(i/25) + 1}: ${error.message}`);
      }
    }
    
    await writeAuditLog(user, 'BULK_IMPORT', config.name, {
      tableIndex,
      imported,
      failed,
      totalItems: items.length
    });
    
    return createResponse(200, { imported, failed, errors });
    
  } catch (error: any) {
    if (error.message.includes('Authorization')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    return createResponse(500, { error: 'Internal server error', details: error.message });
  }
}

async function handleTableOperations(event: APIGatewayEvent, tableIndex: string, pathParts: string[]): Promise<APIGatewayResponse> {
  try {
    const user = extractUserFromEvent(event);
    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const method = event.httpMethod;
    
    // GET /api/{tableIndex} - List all items
    if (method === 'GET' && pathParts.length === 2) {
      if (!hasPermission(user, config.name, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }
      
      const result = await docClient.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'pk = :pk',
        ExpressionAttributeValues: {
          ':pk': config.pk
        }
      }));
      
      return createResponse(200, { items: result.Items || [] });
    }
    
    // GET /api/{tableIndex}/{id} - Get specific item
    if (method === 'GET' && pathParts.length === 3) {
      if (!hasPermission(user, config.name, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }
      
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
    
    // POST /api/{tableIndex} - Create new item
    if (method === 'POST' && pathParts.length === 2) {
      if (!hasPermission(user, config.name, 'create')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }
      
      const body = JSON.parse(event.body || '{}');
      const id = body.id || generateId();
      
      const item = {
        ...body,
        pk: config.pk,
        sk: id,
        ...addTimestamps(body, false)
      };
      
      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      }));
      
      await writeAuditLog(user, 'CREATE', config.name, { id });
      
      return createResponse(201, item);
    }
    
    // PUT /api/{tableIndex}/{id} - Update item
    if (method === 'PUT' && pathParts.length === 3) {
      if (!hasPermission(user, config.name, 'update')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }
      
      const id = pathParts[2];
      const body = JSON.parse(event.body || '{}');
      
      // Check if item exists
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
      
      const updatedItem = {
        ...existing.Item,
        ...body,
        pk: config.pk,
        sk: id,
        ...addTimestamps(body, true)
      };
      
      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: updatedItem
      }));
      
      await writeAuditLog(user, 'UPDATE', config.name, { id });
      
      return createResponse(200, updatedItem);
    }
    
    // DELETE /api/{tableIndex}/{id} - Delete item
    if (method === 'DELETE' && pathParts.length === 3) {
      if (!hasPermission(user, config.name, 'delete')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }
      
      const id = pathParts[2];
      
      // Check if item exists
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
      
      await writeAuditLog(user, 'DELETE', config.name, { id });
      
      return createResponse(200, { message: 'Item deleted successfully' });
    }
    
    return createResponse(405, { error: 'Method not allowed' });
    
  } catch (error: any) {
    if (error.message.includes('Authorization')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    return createResponse(500, { error: 'Internal server error', details: error.message });
  }
}