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
  '7': { name: '発注推奨', pk: 'ORDER_REC' },
  '8': { name: '商品提案情報', pk: 'PROPOSAL' },
  '9': { name: '顧客マスタ', pk: 'CUSTOMER' },
  '10': { name: 'ペット情報', pk: 'PET' },
  '11': { name: '顧客利用履歴', pk: 'USAGE' },
  '12': { name: '需要予測', pk: 'FORECAST' },
  '13': { name: '発注履歴', pk: 'ORDER_HIST' },
  '14': { name: '在庫調整履歴', pk: 'INV_ADJ' }
};

interface APIGatewayEvent {
  httpMethod: string;
  pathParameters: { [key: string]: string } | null;
  queryStringParameters: { [key: string]: string } | null;
  body: string | null;
  headers: { [key: string]: string };
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

async function handleGetResources(event: APIGatewayEvent, user: User): Promise<APIGatewayResponse> {
  if (!hasPermission(user, 'resources', 'read')) {
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
    console.error('Error getting resources:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetTableItems(tableIndex: string, user: User): Promise<APIGatewayResponse> {
  if (!validateTableIndex(tableIndex)) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!hasPermission(user, TABLE_CONFIGS[tableIndex].name, 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const config = TABLE_CONFIGS[tableIndex];
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
    console.error('Error getting table items:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetTableItem(tableIndex: string, id: string, user: User): Promise<APIGatewayResponse> {
  if (!validateTableIndex(tableIndex)) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!hasPermission(user, TABLE_CONFIGS[tableIndex].name, 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const config = TABLE_CONFIGS[tableIndex];
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
    console.error('Error getting table item:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleCreateTableItem(tableIndex: string, body: string, user: User): Promise<APIGatewayResponse> {
  if (!validateTableIndex(tableIndex)) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!hasPermission(user, TABLE_CONFIGS[tableIndex].name, 'create')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const data = JSON.parse(body);
    const config = TABLE_CONFIGS[tableIndex];
    
    const item = {
      pk: config.pk,
      sk: generateId(),
      ...data,
      createdBy: user.id,
      updatedBy: user.id
    };
    
    addTimestamps(item);

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    }));

    await writeAuditLog(user, 'CREATE', config.name, { itemId: item.sk });

    return createResponse(201, item);
  } catch (error) {
    console.error('Error creating table item:', error);
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpdateTableItem(tableIndex: string, id: string, body: string, user: User): Promise<APIGatewayResponse> {
  if (!validateTableIndex(tableIndex)) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!hasPermission(user, TABLE_CONFIGS[tableIndex].name, 'update')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const data = JSON.parse(body);
    const config = TABLE_CONFIGS[tableIndex];
    
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

    const updatedItem = {
      ...existingItem.Item,
      ...data,
      updatedBy: user.id
    };
    
    addTimestamps(updatedItem, true);

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedItem
    }));

    await writeAuditLog(user, 'UPDATE', config.name, { itemId: id });

    return createResponse(200, updatedItem);
  } catch (error) {
    console.error('Error updating table item:', error);
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDeleteTableItem(tableIndex: string, id: string, user: User): Promise<APIGatewayResponse> {
  if (!validateTableIndex(tableIndex)) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!hasPermission(user, TABLE_CONFIGS[tableIndex].name, 'delete')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const config = TABLE_CONFIGS[tableIndex];
    
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

    await writeAuditLog(user, 'DELETE', config.name, { itemId: id });

    return createResponse(200, { message: 'Item deleted successfully' });
  } catch (error) {
    console.error('Error deleting table item:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleBulkImport(tableIndex: string, body: string, user: User): Promise<APIGatewayResponse> {
  if (!validateTableIndex(tableIndex)) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!hasPermission(user, TABLE_CONFIGS[tableIndex].name, 'bulk')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const { items } = JSON.parse(body);
    
    if (!Array.isArray(items)) {
      return createResponse(400, { error: 'Items must be an array' });
    }

    const config = TABLE_CONFIGS[tableIndex];
    let imported = 0;
    let failed = 0;
    const errors: string[] = [];

    // Process items in batches of 25 (DynamoDB BatchWrite limit)
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      const writeRequests = batch.map(item => {
        const processedItem = {
          pk: config.pk,
          sk: generateId(),
          ...item,
          createdBy: user.id,
          updatedBy: user.id
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
        errors.push(`Batch ${Math.floor(i / 25) + 1}: ${error.message}`);
      }
    }

    await writeAuditLog(user, 'BULK_IMPORT', config.name, { 
      imported, 
      failed, 
      totalItems: items.length 
    });

    return createResponse(200, {
      imported,
      failed,
      errors
    });
  } catch (error) {
    console.error('Error in bulk import:', error);
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  if (event.httpMethod === 'OPTIONS') {
    return createResponse(200, {});
  }

  try {
    const user = extractUserFromEvent(event);
    const { httpMethod, pathParameters } = event;
    const path = event.pathParameters?.proxy || '';
    const pathParts = path.split('/').filter(Boolean);

    // Handle /resources endpoint
    if (pathParts.length === 1 && pathParts[0] === 'resources') {
      if (httpMethod === 'GET') {
        return await handleGetResources(event, user);
      }
      return createResponse(405, { error: 'Method not allowed' });
    }

    // Handle /api/{tableIndex} endpoints
    if (pathParts.length >= 2 && pathParts[0] === 'api') {
      const tableIndex = pathParts[1];
      
      // Bulk import endpoint: POST /api/{tableIndex}/bulk
      if (pathParts.length === 3 && pathParts[2] === 'bulk' && httpMethod === 'POST') {
        return await handleBulkImport(tableIndex, event.body || '{}', user);
      }
      
      // Table item endpoints
      if (pathParts.length === 2) {
        // GET /api/{tableIndex} - List items
        if (httpMethod === 'GET') {
          return await handleGetTableItems(tableIndex, user);
        }
        // POST /api/{tableIndex} - Create item
        if (httpMethod === 'POST') {
          return await handleCreateTableItem(tableIndex, event.body || '{}', user);
        }
      }
      
      if (pathParts.length === 3) {
        const itemId = pathParts[2];
        // GET /api/{tableIndex}/{id} - Get item
        if (httpMethod === 'GET') {
          return await handleGetTableItem(tableIndex, itemId, user);
        }
        // PUT /api/{tableIndex}/{id} - Update item
        if (httpMethod === 'PUT') {
          return await handleUpdateTableItem(tableIndex, itemId, event.body || '{}', user);
        }
        // DELETE /api/{tableIndex}/{id} - Delete item
        if (httpMethod === 'DELETE') {
          return await handleDeleteTableItem(tableIndex, itemId, user);
        }
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });
  } catch (error) {
    console.error('Handler error:', error);
    if (error.message === 'Authorization header missing' || error.message === 'Invalid token') {
      return createResponse(401, { error: 'Unauthorized' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
};