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

interface APIResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function createResponse(statusCode: number, body: any): APIResponse {
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
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.id,
    userRole: user.role,
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

function addTimestamps(item: any, isUpdate: boolean = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

function validateTableIndex(tableIndex: string): string {
  if (!TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS]) {
    throw new Error(`Invalid table index: ${tableIndex}`);
  }
  return tableIndex;
}

async function handleGetResources(event: any): Promise<APIResponse> {
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
    if (error.message.includes('Authorization') || error.message.includes('token')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetTableData(event: any, tableIndex: string): Promise<APIResponse> {
  try {
    validateTableIndex(tableIndex);
    const user = extractUserFromEvent(event);
    
    if (!hasPermission(user, 'table', 'read')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const command = new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': config.pk
      }
    });

    const result = await docClient.send(command);
    return createResponse(200, { items: result.Items || [] });
  } catch (error: any) {
    if (error.message.includes('Authorization') || error.message.includes('token')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    if (error.message.includes('Invalid table index')) {
      return createResponse(404, { error: error.message });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetTableItem(event: any, tableIndex: string, itemId: string): Promise<APIResponse> {
  try {
    validateTableIndex(tableIndex);
    const user = extractUserFromEvent(event);
    
    if (!hasPermission(user, 'table', 'read')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const command = new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: itemId
      }
    });

    const result = await docClient.send(command);
    if (!result.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    return createResponse(200, { item: result.Item });
  } catch (error: any) {
    if (error.message.includes('Authorization') || error.message.includes('token')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    if (error.message.includes('Invalid table index')) {
      return createResponse(404, { error: error.message });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleCreateTableItem(event: any, tableIndex: string): Promise<APIResponse> {
  try {
    validateTableIndex(tableIndex);
    const user = extractUserFromEvent(event);
    
    if (!hasPermission(user, 'table', 'create')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    const body = JSON.parse(event.body || '{}');
    if (!body || Object.keys(body).length === 0) {
      return createResponse(400, { error: 'Request body is required' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const item = {
      ...body,
      pk: config.pk,
      sk: body.id || randomUUID(),
      createdBy: user.id
    };
    addTimestamps(item);

    const command = new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    });

    await docClient.send(command);
    await writeAuditLog(user, 'CREATE', `${config.name}`, { itemId: item.sk });

    return createResponse(201, { item });
  } catch (error: any) {
    if (error.message.includes('Authorization') || error.message.includes('token')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    if (error.message.includes('Invalid table index')) {
      return createResponse(404, { error: error.message });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpdateTableItem(event: any, tableIndex: string, itemId: string): Promise<APIResponse> {
  try {
    validateTableIndex(tableIndex);
    const user = extractUserFromEvent(event);
    
    if (!hasPermission(user, 'table', 'update')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    const body = JSON.parse(event.body || '{}');
    if (!body || Object.keys(body).length === 0) {
      return createResponse(400, { error: 'Request body is required' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    // Check if item exists
    const getCommand = new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: itemId
      }
    });
    
    const existingItem = await docClient.send(getCommand);
    if (!existingItem.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    const updatedItem = {
      ...existingItem.Item,
      ...body,
      pk: config.pk,
      sk: itemId,
      updatedBy: user.id
    };
    addTimestamps(updatedItem, true);

    const putCommand = new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedItem
    });

    await docClient.send(putCommand);
    await writeAuditLog(user, 'UPDATE', `${config.name}`, { itemId });

    return createResponse(200, { item: updatedItem });
  } catch (error: any) {
    if (error.message.includes('Authorization') || error.message.includes('token')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    if (error.message.includes('Invalid table index')) {
      return createResponse(404, { error: error.message });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDeleteTableItem(event: any, tableIndex: string, itemId: string): Promise<APIResponse> {
  try {
    validateTableIndex(tableIndex);
    const user = extractUserFromEvent(event);
    
    if (!hasPermission(user, 'table', 'delete')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    // Check if item exists
    const getCommand = new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: itemId
      }
    });
    
    const existingItem = await docClient.send(getCommand);
    if (!existingItem.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    const deleteCommand = new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: itemId
      }
    });

    await docClient.send(deleteCommand);
    await writeAuditLog(user, 'DELETE', `${config.name}`, { itemId });

    return createResponse(200, { message: 'Item deleted successfully' });
  } catch (error: any) {
    if (error.message.includes('Authorization') || error.message.includes('token')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    if (error.message.includes('Invalid table index')) {
      return createResponse(404, { error: error.message });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleBulkImport(event: any, tableIndex: string): Promise<APIResponse> {
  try {
    validateTableIndex(tableIndex);
    const user = extractUserFromEvent(event);
    
    if (!hasPermission(user, 'table', 'bulk')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    const body = JSON.parse(event.body || '{}');
    if (!body.items || !Array.isArray(body.items)) {
      return createResponse(400, { error: 'items array is required' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    let imported = 0;
    let failed = 0;
    const errors: string[] = [];

    // Process in batches of 25 (DynamoDB BatchWrite limit)
    const batchSize = 25;
    for (let i = 0; i < body.items.length; i += batchSize) {
      const batch = body.items.slice(i, i + batchSize);
      const writeRequests = batch.map((item: any) => {
        const processedItem = {
          ...item,
          pk: config.pk,
          sk: item.id || randomUUID(),
          createdBy: user.id
        };
        addTimestamps(processedItem);
        
        return {
          PutRequest: {
            Item: processedItem
          }
        };
      });

      try {
        const batchCommand = new BatchWriteCommand({
          RequestItems: {
            [TABLE_NAME]: writeRequests
          }
        });

        const result = await docClient.send(batchCommand);
        
        // Handle unprocessed items
        if (result.UnprocessedItems && result.UnprocessedItems[TABLE_NAME]) {
          const unprocessedCount = result.UnprocessedItems[TABLE_NAME].length;
          failed += unprocessedCount;
          imported += (batch.length - unprocessedCount);
          errors.push(`${unprocessedCount} items in batch ${Math.floor(i/batchSize) + 1} were not processed`);
        } else {
          imported += batch.length;
        }
      } catch (error: any) {
        failed += batch.length;
        errors.push(`Batch ${Math.floor(i/batchSize) + 1} failed: ${error.message}`);
      }
    }

    await writeAuditLog(user, 'BULK_IMPORT', `${config.name}`, { 
      totalItems: body.items.length,
      imported,
      failed
    });

    return createResponse(200, { imported, failed, errors });
  } catch (error: any) {
    if (error.message.includes('Authorization') || error.message.includes('token')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    if (error.message.includes('Invalid table index')) {
      return createResponse(404, { error: error.message });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

export const handler = async (event: any): Promise<APIResponse> => {
  try {
    const method = event.httpMethod;
    const path = event.path;
    const pathParameters = event.pathParameters || {};

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    // Route: GET /resources
    if (method === 'GET' && path === '/resources') {
      return await handleGetResources(event);
    }

    // Route: GET /api/{tableIndex}
    if (method === 'GET' && path.match(/^\/api\/\d+$/)) {
      const tableIndex = pathParameters.tableIndex;
      return await handleGetTableData(event, tableIndex);
    }

    // Route: GET /api/{tableIndex}/{id}
    if (method === 'GET' && path.match(/^\/api\/\d+\/[^/]+$/)) {
      const tableIndex = pathParameters.tableIndex;
      const itemId = pathParameters.id;
      return await handleGetTableItem(event, tableIndex, itemId);
    }

    // Route: POST /api/{tableIndex}
    if (method === 'POST' && path.match(/^\/api\/\d+$/) && !path.includes('/bulk')) {
      const tableIndex = pathParameters.tableIndex;
      return await handleCreateTableItem(event, tableIndex);
    }

    // Route: POST /api/{tableIndex}/bulk
    if (method === 'POST' && path.match(/^\/api\/\d+\/bulk$/)) {
      const tableIndex = pathParameters.tableIndex;
      return await handleBulkImport(event, tableIndex);
    }

    // Route: PUT /api/{tableIndex}/{id}
    if (method === 'PUT' && path.match(/^\/api\/\d+\/[^/]+$/)) {
      const tableIndex = pathParameters.tableIndex;
      const itemId = pathParameters.id;
      return await handleUpdateTableItem(event, tableIndex, itemId);
    }

    // Route: DELETE /api/{tableIndex}/{id}
    if (method === 'DELETE' && path.match(/^\/api\/\d+\/[^/]+$/)) {
      const tableIndex = pathParameters.tableIndex;
      const itemId = pathParameters.id;
      return await handleDeleteTableItem(event, tableIndex, itemId);
    }

    return createResponse(404, { error: 'Not found' });
  } catch (error: any) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};