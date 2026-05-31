import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, validateRole, Role } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface APIGatewayEvent {
  httpMethod: string;
  path: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  body?: string;
  headers: { [key: string]: string };
}

interface APIGatewayResponse {
  statusCode: number;
  headers: { [key: string]: string };
  body: string;
}

const TABLE_CONFIGS = {
  'login-users': { pk: 'LOGIN_USER', name: 'ログインユーザー' },
  'products': { pk: 'PRODUCT', name: '商品マスタ' },
  'suppliers': { pk: 'SUPPLIER', name: '仕入先マスタ' },
  'inventory': { pk: 'INVENTORY', name: '在庫管理' },
  'purchase-records': { pk: 'PURCHASE_RECORD', name: '仕入実績' },
  'sales-records': { pk: 'SALES_RECORD', name: '売上実績' },
  'monthly-summary': { pk: 'MONTHLY_SUMMARY', name: '月次集計' },
  'order-recommendations': { pk: 'ORDER_RECOMMENDATION', name: '発注推奨' },
  'product-proposals': { pk: 'PRODUCT_PROPOSAL', name: '商品提案情報' },
  'customers': { pk: 'CUSTOMER', name: '顧客マスタ' },
  'pets': { pk: 'PET', name: 'ペット情報' },
  'customer-history': { pk: 'CUSTOMER_HISTORY', name: '顧客利用履歴' },
  'demand-forecast': { pk: 'DEMAND_FORECAST', name: '需要予測' },
  'order-history': { pk: 'ORDER_HISTORY', name: '発注履歴' },
  'inventory-adjustments': { pk: 'INVENTORY_ADJUSTMENT', name: '在庫調整履歴' }
};

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

function getUserRole(event: APIGatewayEvent): Role {
  const authHeader = event.headers.Authorization || event.headers.authorization;
  if (!authHeader) {
    throw new Error('Authorization header required');
  }
  
  try {
    const token = authHeader.replace('Bearer ', '');
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return validateRole(payload.role);
  } catch (error) {
    throw new Error('Invalid token');
  }
}

async function createAuditLog(action: string, resourceType: string, resourceId: string, userId: string, details?: any) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    action,
    resourceType,
    resourceId,
    userId,
    timestamp: new Date().toISOString(),
    details: details || {}
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
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

function validateTableKey(tableKey: string): string {
  if (!TABLE_CONFIGS[tableKey as keyof typeof TABLE_CONFIGS]) {
    throw new Error('Invalid table key');
  }
  return tableKey;
}

function getTableConfig(tableKey: string) {
  return TABLE_CONFIGS[tableKey as keyof typeof TABLE_CONFIGS];
}

async function handleGetResources(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  try {
    const role = getUserRole(event);
    
    if (!hasPermission(role, 'read')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    const resources = Object.entries(TABLE_CONFIGS).map(([key, config]) => ({
      key,
      name: config.name,
      pk: config.pk
    }));

    return createResponse(200, { resources });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Authorization')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetItems(event: APIGatewayEvent, tableKey: string): Promise<APIGatewayResponse> {
  try {
    const role = getUserRole(event);
    
    if (!hasPermission(role, 'read')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    const config = getTableConfig(tableKey);
    const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit) : 50;
    const lastKey = event.queryStringParameters?.lastKey;

    const params: any = {
      TableName: TABLE_NAME,
      FilterExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': config.pk
      },
      Limit: Math.min(limit, 100)
    };

    if (lastKey) {
      params.ExclusiveStartKey = JSON.parse(decodeURIComponent(lastKey));
    }

    const result = await docClient.send(new ScanCommand(params));
    
    return createResponse(200, {
      items: result.Items || [],
      lastEvaluatedKey: result.LastEvaluatedKey,
      count: result.Count
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Authorization')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetItem(event: APIGatewayEvent, tableKey: string): Promise<APIGatewayResponse> {
  try {
    const role = getUserRole(event);
    
    if (!hasPermission(role, 'read')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    const id = event.pathParameters?.id;
    if (!id) {
      return createResponse(400, { error: 'ID parameter required' });
    }

    const config = getTableConfig(tableKey);
    
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
  } catch (error) {
    if (error instanceof Error && error.message.includes('Authorization')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleCreateItem(event: APIGatewayEvent, tableKey: string): Promise<APIGatewayResponse> {
  try {
    const role = getUserRole(event);
    
    if (!hasPermission(role, 'write')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    if (!event.body) {
      return createResponse(400, { error: 'Request body required' });
    }

    const data = JSON.parse(event.body);
    const config = getTableConfig(tableKey);
    const id = randomUUID();
    
    const item = addTimestamps({
      pk: config.pk,
      sk: id,
      id,
      ...data
    });

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    }));

    await createAuditLog('CREATE', config.name, id, 'system', { tableKey });

    return createResponse(201, item);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Authorization')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpdateItem(event: APIGatewayEvent, tableKey: string): Promise<APIGatewayResponse> {
  try {
    const role = getUserRole(event);
    
    if (!hasPermission(role, 'write')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    const id = event.pathParameters?.id;
    if (!id) {
      return createResponse(400, { error: 'ID parameter required' });
    }

    if (!event.body) {
      return createResponse(400, { error: 'Request body required' });
    }

    const data = JSON.parse(event.body);
    const config = getTableConfig(tableKey);
    
    // Check if item exists
    const existingItem = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: id
      }
    }));

    if (!existingItem.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    const updatedItem = addTimestamps({
      ...existingItem.Item,
      ...data
    }, true);

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedItem
    }));

    await createAuditLog('UPDATE', config.name, id, 'system', { tableKey });

    return createResponse(200, updatedItem);
  } catch (error) {
    if (error instanceof Error && error.message.includes('Authorization')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDeleteItem(event: APIGatewayEvent, tableKey: string): Promise<APIGatewayResponse> {
  try {
    const role = getUserRole(event);
    
    if (!hasPermission(role, 'delete')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    const id = event.pathParameters?.id;
    if (!id) {
      return createResponse(400, { error: 'ID parameter required' });
    }

    const config = getTableConfig(tableKey);
    
    // Check if item exists
    const existingItem = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: id
      }
    }));

    if (!existingItem.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: id
      }
    }));

    await createAuditLog('DELETE', config.name, id, 'system', { tableKey });

    return createResponse(204, {});
  } catch (error) {
    if (error instanceof Error && error.message.includes('Authorization')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleBulkImport(event: APIGatewayEvent, tableKey: string): Promise<APIGatewayResponse> {
  try {
    const role = getUserRole(event);
    
    if (!hasPermission(role, 'write')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    if (!event.body) {
      return createResponse(400, { error: 'Request body required' });
    }

    const { items } = JSON.parse(event.body);
    if (!Array.isArray(items)) {
      return createResponse(400, { error: 'Items must be an array' });
    }

    const config = getTableConfig(tableKey);
    let imported = 0;
    let failed = 0;
    const errors: string[] = [];

    // Process in batches of 25 (DynamoDB BatchWrite limit)
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      const putRequests = batch.map(item => {
        const id = randomUUID();
        return {
          PutRequest: {
            Item: addTimestamps({
              pk: config.pk,
              sk: id,
              id,
              ...item
            })
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

    await createAuditLog('BULK_IMPORT', config.name, 'bulk', 'system', { 
      tableKey, 
      imported, 
      failed, 
      total: items.length 
    });

    return createResponse(200, { imported, failed, errors });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Authorization')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

export async function handler(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  if (event.httpMethod === 'OPTIONS') {
    return createResponse(200, {});
  }

  try {
    const path = event.path;
    const method = event.httpMethod;

    // GET /resources
    if (method === 'GET' && path === '/resources') {
      return await handleGetResources(event);
    }

    // API routes: /api/{tableKey} or /api/{tableKey}/{id} or /api/{tableKey}/bulk
    const apiMatch = path.match(/^\/api\/([^/]+)(?:\/([^/]+))?$/);
    if (!apiMatch) {
      return createResponse(404, { error: 'Not found' });
    }

    const [, tableKey, idOrAction] = apiMatch;
    
    try {
      validateTableKey(tableKey);
    } catch (error) {
      return createResponse(404, { error: 'Table not found' });
    }

    // Bulk import: POST /api/{tableKey}/bulk
    if (method === 'POST' && idOrAction === 'bulk') {
      return await handleBulkImport(event, tableKey);
    }

    // Collection operations: /api/{tableKey}
    if (!idOrAction) {
      if (method === 'GET') {
        return await handleGetItems(event, tableKey);
      }
      if (method === 'POST') {
        return await handleCreateItem(event, tableKey);
      }
    }

    // Item operations: /api/{tableKey}/{id}
    if (idOrAction && idOrAction !== 'bulk') {
      if (method === 'GET') {
        return await handleGetItem(event, tableKey);
      }
      if (method === 'PUT') {
        return await handleUpdateItem(event, tableKey);
      }
      if (method === 'DELETE') {
        return await handleDeleteItem(event, tableKey);
      }
    }

    return createResponse(405, { error: 'Method not allowed' });
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}