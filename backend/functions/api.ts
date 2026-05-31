import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE || 'inventory-management';

interface APIGatewayEvent {
  httpMethod: string;
  path: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  body?: string;
  headers?: { [key: string]: string };
}

interface APIResponse {
  statusCode: number;
  headers: { [key: string]: string };
  body: string;
}

const tableConfigs = {
  '0': { name: 'login_users', pk: 'userId' },
  '1': { name: 'products', pk: 'productId' },
  '2': { name: 'suppliers', pk: 'supplierId' },
  '3': { name: 'inventory', pk: 'inventoryId' },
  '4': { name: 'purchase_records', pk: 'purchaseRecordId' },
  '5': { name: 'sales_records', pk: 'salesRecordId' },
  '6': { name: 'monthly_summary', pk: 'summaryId' },
  '7': { name: 'order_recommendations', pk: 'recommendationId' },
  '8': { name: 'product_proposals', pk: 'proposalId' },
  '9': { name: 'customers', pk: 'customerId' },
  '10': { name: 'pets', pk: 'petId' },
  '11': { name: 'customer_usage_history', pk: 'usageHistoryId' },
  '12': { name: 'demand_forecast', pk: 'forecastId' },
  '13': { name: 'order_history', pk: 'orderHistoryId' },
  '14': { name: 'inventory_adjustment_history', pk: 'adjustmentHistoryId' }
};

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

async function createAuditLog(user: User, action: string, resource: string, details: any) {
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

function validateTableIndex(tableIndex: string): boolean {
  return tableIndex in tableConfigs;
}

function addTimestamps(item: any, isUpdate = false): any {
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

async function handleGetResources(event: APIGatewayEvent, user: User): Promise<APIResponse> {
  if (!hasPermission(user, 'resources', 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const resources = Object.entries(tableConfigs).map(([index, config]) => ({
      index,
      name: config.name,
      primaryKey: config.pk
    }));

    return createResponse(200, { resources });
  } catch (error) {
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetTableItems(event: APIGatewayEvent, user: User, tableIndex: string): Promise<APIResponse> {
  if (!hasPermission(user, 'table', 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  if (!validateTableIndex(tableIndex)) {
    return createResponse(404, { error: 'Table not found' });
  }

  try {
    const config = tableConfigs[tableIndex as keyof typeof tableConfigs];
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': config.name
      }
    }));

    return createResponse(200, { items: result.Items || [] });
  } catch (error) {
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetTableItem(event: APIGatewayEvent, user: User, tableIndex: string, itemId: string): Promise<APIResponse> {
  if (!hasPermission(user, 'table', 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  if (!validateTableIndex(tableIndex)) {
    return createResponse(404, { error: 'Table not found' });
  }

  try {
    const config = tableConfigs[tableIndex as keyof typeof tableConfigs];
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.name,
        sk: itemId
      }
    }));

    if (!result.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    return createResponse(200, { item: result.Item });
  } catch (error) {
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleCreateTableItem(event: APIGatewayEvent, user: User, tableIndex: string): Promise<APIResponse> {
  if (!hasPermission(user, 'table', 'create')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  if (!validateTableIndex(tableIndex)) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }

  try {
    const config = tableConfigs[tableIndex as keyof typeof tableConfigs];
    const body = JSON.parse(event.body);
    
    const item = {
      pk: config.name,
      sk: generateId(),
      [config.pk]: generateId(),
      ...body
    };
    
    addTimestamps(item);
    item.createdBy = user.id;
    item.updatedBy = user.id;

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    }));

    await createAuditLog(user, 'CREATE', config.name, { itemId: item.sk });

    return createResponse(201, { item });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON in request body' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpdateTableItem(event: APIGatewayEvent, user: User, tableIndex: string, itemId: string): Promise<APIResponse> {
  if (!hasPermission(user, 'table', 'update')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  if (!validateTableIndex(tableIndex)) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }

  try {
    const config = tableConfigs[tableIndex as keyof typeof tableConfigs];
    const body = JSON.parse(event.body);
    
    const existingItem = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.name,
        sk: itemId
      }
    }));

    if (!existingItem.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    const updatedItem = {
      ...existingItem.Item,
      ...body
    };
    
    addTimestamps(updatedItem, true);
    updatedItem.updatedBy = user.id;

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedItem
    }));

    await createAuditLog(user, 'UPDATE', config.name, { itemId });

    return createResponse(200, { item: updatedItem });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON in request body' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDeleteTableItem(event: APIGatewayEvent, user: User, tableIndex: string, itemId: string): Promise<APIResponse> {
  if (!hasPermission(user, 'table', 'delete')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  if (!validateTableIndex(tableIndex)) {
    return createResponse(404, { error: 'Table not found' });
  }

  try {
    const config = tableConfigs[tableIndex as keyof typeof tableConfigs];
    
    const existingItem = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.name,
        sk: itemId
      }
    }));

    if (!existingItem.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.name,
        sk: itemId
      }
    }));

    await createAuditLog(user, 'DELETE', config.name, { itemId });

    return createResponse(200, { message: 'Item deleted successfully' });
  } catch (error) {
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleBulkImport(event: APIGatewayEvent, user: User, tableIndex: string): Promise<APIResponse> {
  if (!hasPermission(user, 'table', 'bulk')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  if (!validateTableIndex(tableIndex)) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }

  try {
    const config = tableConfigs[tableIndex as keyof typeof tableConfigs];
    const body = JSON.parse(event.body);
    
    if (!body.items || !Array.isArray(body.items)) {
      return createResponse(400, { error: 'Request body must contain items array' });
    }

    const items = body.items.map((item: any) => {
      const processedItem = {
        pk: config.name,
        sk: generateId(),
        [config.pk]: generateId(),
        ...item
      };
      
      addTimestamps(processedItem);
      processedItem.createdBy = user.id;
      processedItem.updatedBy = user.id;
      
      return processedItem;
    });

    let imported = 0;
    let failed = 0;
    const errors: string[] = [];

    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      
      try {
        const writeRequests = batch.map(item => ({
          PutRequest: {
            Item: item
          }
        }));

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

    await createAuditLog(user, 'BULK_IMPORT', config.name, { imported, failed, total: items.length });

    return createResponse(200, { imported, failed, errors });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON in request body' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

export async function handler(event: APIGatewayEvent): Promise<APIResponse> {
  if (event.httpMethod === 'OPTIONS') {
    return createResponse(200, {});
  }

  try {
    const user = extractUserFromEvent(event);
    const { httpMethod, path } = event;

    if (httpMethod === 'GET' && path === '/resources') {
      return await handleGetResources(event, user);
    }

    const pathMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(bulk))?$/);
    if (!pathMatch) {
      return createResponse(404, { error: 'Endpoint not found' });
    }

    const [, tableIndex, itemId, bulkFlag] = pathMatch;

    if (bulkFlag === 'bulk' && httpMethod === 'POST') {
      return await handleBulkImport(event, user, tableIndex);
    }

    switch (httpMethod) {
      case 'GET':
        if (itemId) {
          return await handleGetTableItem(event, user, tableIndex, itemId);
        } else {
          return await handleGetTableItems(event, user, tableIndex);
        }
      case 'POST':
        return await handleCreateTableItem(event, user, tableIndex);
      case 'PUT':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID is required for updates' });
        }
        return await handleUpdateTableItem(event, user, tableIndex, itemId);
      case 'DELETE':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID is required for deletion' });
        }
        return await handleDeleteTableItem(event, user, tableIndex, itemId);
      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Authorization header missing') {
      return createResponse(401, { error: 'Unauthorized' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}