import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
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
  if (!authHeader) return 'viewer';
  
  const token = authHeader.replace('Bearer ', '');
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return validateRole(payload.role) ? payload.role : 'viewer';
  } catch {
    return 'viewer';
  }
}

async function createAuditLog(action: string, details: any, userId?: string): Promise<void> {
  const auditItem = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    action,
    details,
    userId: userId || 'system',
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditItem
  }));
}

function validateTableIndex(tableIndex: string): boolean {
  return tableIndex in TABLE_CONFIGS;
}

function addTimestamps(item: any, isUpdate: boolean = false): any {
  const now = new Date().toISOString();
  const result = { ...item };
  
  if (!isUpdate) {
    result.createdAt = now;
  }
  result.updatedAt = now;
  
  return result;
}

async function handleGetResources(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  const role = getUserRole(event);
  
  if (!hasPermission(role, 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }
  
  try {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'pk <> :auditPk',
      ExpressionAttributeValues: {
        ':auditPk': 'AUDIT'
      }
    }));
    
    return createResponse(200, {
      items: result.Items || [],
      count: result.Count || 0
    });
  } catch (error) {
    console.error('Error fetching resources:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetTableItems(event: APIGatewayEvent, tableIndex: string): Promise<APIGatewayResponse> {
  const role = getUserRole(event);
  
  if (!hasPermission(role, 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }
  
  if (!validateTableIndex(tableIndex)) {
    return createResponse(404, { error: 'Table not found' });
  }
  
  try {
    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': config.pk
      }
    }));
    
    return createResponse(200, {
      items: result.Items || [],
      count: result.Count || 0,
      tableName: config.name
    });
  } catch (error) {
    console.error('Error fetching table items:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetItem(event: APIGatewayEvent, tableIndex: string, itemId: string): Promise<APIGatewayResponse> {
  const role = getUserRole(event);
  
  if (!hasPermission(role, 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }
  
  if (!validateTableIndex(tableIndex)) {
    return createResponse(404, { error: 'Table not found' });
  }
  
  try {
    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
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
    console.error('Error fetching item:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleCreateItem(event: APIGatewayEvent, tableIndex: string): Promise<APIGatewayResponse> {
  const role = getUserRole(event);
  
  if (!hasPermission(role, 'write')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }
  
  if (!validateTableIndex(tableIndex)) {
    return createResponse(404, { error: 'Table not found' });
  }
  
  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }
  
  try {
    const body = JSON.parse(event.body);
    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    const item = addTimestamps({
      pk: config.pk,
      sk: randomUUID(),
      ...body
    });
    
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    }));
    
    await createAuditLog('CREATE', { table: config.name, itemId: item.sk }, 'system');
    
    return createResponse(201, item);
  } catch (error) {
    console.error('Error creating item:', error);
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON in request body' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpdateItem(event: APIGatewayEvent, tableIndex: string, itemId: string): Promise<APIGatewayResponse> {
  const role = getUserRole(event);
  
  if (!hasPermission(role, 'write')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }
  
  if (!validateTableIndex(tableIndex)) {
    return createResponse(404, { error: 'Table not found' });
  }
  
  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }
  
  try {
    const body = JSON.parse(event.body);
    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    // Check if item exists
    const existingItem = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: itemId
      }
    }));
    
    if (!existingItem.Item) {
      return createResponse(404, { error: 'Item not found' });
    }
    
    const updatedItem = addTimestamps({
      ...existingItem.Item,
      ...body,
      pk: config.pk,
      sk: itemId
    }, true);
    
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedItem
    }));
    
    await createAuditLog('UPDATE', { table: config.name, itemId }, 'system');
    
    return createResponse(200, updatedItem);
  } catch (error) {
    console.error('Error updating item:', error);
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON in request body' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDeleteItem(event: APIGatewayEvent, tableIndex: string, itemId: string): Promise<APIGatewayResponse> {
  const role = getUserRole(event);
  
  if (!hasPermission(role, 'delete')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }
  
  if (!validateTableIndex(tableIndex)) {
    return createResponse(404, { error: 'Table not found' });
  }
  
  try {
    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    // Check if item exists
    const existingItem = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: itemId
      }
    }));
    
    if (!existingItem.Item) {
      return createResponse(404, { error: 'Item not found' });
    }
    
    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: itemId
      }
    }));
    
    await createAuditLog('DELETE', { table: config.name, itemId }, 'system');
    
    return createResponse(200, { message: 'Item deleted successfully' });
  } catch (error) {
    console.error('Error deleting item:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleBulkImport(event: APIGatewayEvent, tableIndex: string): Promise<APIGatewayResponse> {
  const role = getUserRole(event);
  
  if (!hasPermission(role, 'write')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }
  
  if (!validateTableIndex(tableIndex)) {
    return createResponse(404, { error: 'Table not found' });
  }
  
  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }
  
  try {
    const body = JSON.parse(event.body);
    
    if (!body.items || !Array.isArray(body.items)) {
      return createResponse(400, { error: 'Request body must contain items array' });
    }
    
    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const items = body.items;
    let imported = 0;
    let failed = 0;
    const errors: string[] = [];
    
    // Process items in batches of 25 (DynamoDB BatchWrite limit)
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      const writeRequests = batch.map(item => {
        const processedItem = addTimestamps({
          pk: config.pk,
          sk: randomUUID(),
          ...item
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
            [TABLE_NAME]: writeRequests
          }
        }));
        imported += batch.length;
      } catch (error) {
        failed += batch.length;
        errors.push(`Batch ${Math.floor(i / 25) + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
    
    await createAuditLog('BULK_IMPORT', { 
      table: config.name, 
      imported, 
      failed, 
      totalItems: items.length 
    }, 'system');
    
    return createResponse(200, {
      imported,
      failed,
      errors
    });
  } catch (error) {
    console.error('Error in bulk import:', error);
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON in request body' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  if (event.httpMethod === 'OPTIONS') {
    return createResponse(200, {});
  }
  
  const path = event.path;
  const method = event.httpMethod;
  
  try {
    // GET /resources
    if (method === 'GET' && path === '/resources') {
      return await handleGetResources(event);
    }
    
    // API routes pattern: /api/{tableIndex}[/{itemId}][/bulk]
    const apiMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(bulk))?$/);
    if (apiMatch) {
      const tableIndex = apiMatch[1];
      const itemId = apiMatch[2];
      const isBulk = apiMatch[3] === 'bulk';
      
      if (isBulk && method === 'POST') {
        return await handleBulkImport(event, tableIndex);
      }
      
      if (itemId) {
        // Item-specific operations
        switch (method) {
          case 'GET':
            return await handleGetItem(event, tableIndex, itemId);
          case 'PUT':
            return await handleUpdateItem(event, tableIndex, itemId);
          case 'DELETE':
            return await handleDeleteItem(event, tableIndex, itemId);
          default:
            return createResponse(405, { error: 'Method not allowed' });
        }
      } else {
        // Table-level operations
        switch (method) {
          case 'GET':
            return await handleGetTableItems(event, tableIndex);
          case 'POST':
            return await handleCreateItem(event, tableIndex);
          default:
            return createResponse(405, { error: 'Method not allowed' });
        }
      }
    }
    
    return createResponse(404, { error: 'Endpoint not found' });
  } catch (error) {
    console.error('Unhandled error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};