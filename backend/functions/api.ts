import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission } from './rbac';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE || 'inventory-management';

interface APIGatewayEvent {
  httpMethod: string;
  path: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  body?: string;
  headers: { [key: string]: string };
  requestContext: {
    authorizer?: {
      userId: string;
      role: string;
    };
  };
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

function validateAuth(event: APIGatewayEvent): { userId: string; role: string } | null {
  const auth = event.requestContext.authorizer;
  if (!auth || !auth.userId || !auth.role) {
    return null;
  }
  return { userId: auth.userId, role: auth.role };
}

async function createAuditLog(action: string, resource: string, userId: string, details?: any): Promise<void> {
  const auditItem = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${crypto.randomUUID()}`,
    action,
    resource,
    userId,
    details: details || {},
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditItem
  }));
}

function validateRequired(item: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (!item[field]) {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

function generateId(): string {
  return crypto.randomUUID();
}

function getCurrentTimestamp(): string {
  return new Date().toISOString();
}

async function handleGetResources(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  const auth = validateAuth(event);
  if (!auth) {
    return createResponse(401, { error: 'Unauthorized' });
  }

  if (!hasPermission(auth.role, 'resources', 'read')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  try {
    const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
      index,
      name: config.name,
      pk: config.pk
    }));

    return createResponse(200, { resources });
  } catch (error) {
    console.error('Error getting resources:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetTableList(event: APIGatewayEvent, tableIndex: string): Promise<APIGatewayResponse> {
  const auth = validateAuth(event);
  if (!auth) {
    return createResponse(401, { error: 'Unauthorized' });
  }

  if (!hasPermission(auth.role, 'table', 'read')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  try {
    const command = new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': config.pk
      }
    });

    const result = await docClient.send(command);
    return createResponse(200, { items: result.Items || [] });
  } catch (error) {
    console.error('Error getting table list:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetTableItem(event: APIGatewayEvent, tableIndex: string, itemId: string): Promise<APIGatewayResponse> {
  const auth = validateAuth(event);
  if (!auth) {
    return createResponse(401, { error: 'Unauthorized' });
  }

  if (!hasPermission(auth.role, 'table', 'read')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  try {
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

    return createResponse(200, result.Item);
  } catch (error) {
    console.error('Error getting table item:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleCreateTableItem(event: APIGatewayEvent, tableIndex: string): Promise<APIGatewayResponse> {
  const auth = validateAuth(event);
  if (!auth) {
    return createResponse(401, { error: 'Unauthorized' });
  }

  if (!hasPermission(auth.role, 'table', 'create')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }

  try {
    const item = JSON.parse(event.body);
    const id = generateId();
    const timestamp = getCurrentTimestamp();

    const newItem = {
      ...item,
      pk: config.pk,
      sk: id,
      id,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: auth.userId,
      updatedBy: auth.userId
    };

    const command = new PutCommand({
      TableName: TABLE_NAME,
      Item: newItem
    });

    await docClient.send(command);
    await createAuditLog('CREATE', config.name, auth.userId, { itemId: id });

    return createResponse(201, newItem);
  } catch (error) {
    console.error('Error creating table item:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpdateTableItem(event: APIGatewayEvent, tableIndex: string, itemId: string): Promise<APIGatewayResponse> {
  const auth = validateAuth(event);
  if (!auth) {
    return createResponse(401, { error: 'Unauthorized' });
  }

  if (!hasPermission(auth.role, 'table', 'update')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }

  try {
    const updates = JSON.parse(event.body);
    const timestamp = getCurrentTimestamp();

    const updateExpressions: string[] = [];
    const expressionAttributeNames: { [key: string]: string } = {};
    const expressionAttributeValues: { [key: string]: any } = {};

    Object.keys(updates).forEach((key, index) => {
      if (key !== 'pk' && key !== 'sk' && key !== 'id' && key !== 'createdAt' && key !== 'createdBy') {
        const attrName = `#attr${index}`;
        const attrValue = `:val${index}`;
        updateExpressions.push(`${attrName} = ${attrValue}`);
        expressionAttributeNames[attrName] = key;
        expressionAttributeValues[attrValue] = updates[key];
      }
    });

    updateExpressions.push('#updatedAt = :updatedAt');
    updateExpressions.push('#updatedBy = :updatedBy');
    expressionAttributeNames['#updatedAt'] = 'updatedAt';
    expressionAttributeNames['#updatedBy'] = 'updatedBy';
    expressionAttributeValues[':updatedAt'] = timestamp;
    expressionAttributeValues[':updatedBy'] = auth.userId;

    const command = new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: itemId
      },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    });

    const result = await docClient.send(command);
    await createAuditLog('UPDATE', config.name, auth.userId, { itemId });

    return createResponse(200, result.Attributes);
  } catch (error) {
    console.error('Error updating table item:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDeleteTableItem(event: APIGatewayEvent, tableIndex: string, itemId: string): Promise<APIGatewayResponse> {
  const auth = validateAuth(event);
  if (!auth) {
    return createResponse(401, { error: 'Unauthorized' });
  }

  if (!hasPermission(auth.role, 'table', 'delete')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  try {
    const command = new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: itemId
      },
      ReturnValues: 'ALL_OLD'
    });

    const result = await docClient.send(command);
    if (!result.Attributes) {
      return createResponse(404, { error: 'Item not found' });
    }

    await createAuditLog('DELETE', config.name, auth.userId, { itemId });

    return createResponse(200, { message: 'Item deleted successfully' });
  } catch (error) {
    console.error('Error deleting table item:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleBulkImport(event: APIGatewayEvent, tableIndex: string): Promise<APIGatewayResponse> {
  const auth = validateAuth(event);
  if (!auth) {
    return createResponse(401, { error: 'Unauthorized' });
  }

  if (!hasPermission(auth.role, 'table', 'bulk')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }

  try {
    const { items } = JSON.parse(event.body);
    if (!Array.isArray(items)) {
      return createResponse(400, { error: 'Items must be an array' });
    }

    const timestamp = getCurrentTimestamp();
    let imported = 0;
    let failed = 0;
    const errors: string[] = [];

    // Process items in batches of 25 (DynamoDB BatchWrite limit)
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      const writeRequests = batch.map(item => {
        const id = generateId();
        return {
          PutRequest: {
            Item: {
              ...item,
              pk: config.pk,
              sk: id,
              id,
              createdAt: timestamp,
              updatedAt: timestamp,
              createdBy: auth.userId,
              updatedBy: auth.userId
            }
          }
        };
      });

      try {
        const command = new BatchWriteCommand({
          RequestItems: {
            [TABLE_NAME]: writeRequests
          }
        });

        await docClient.send(command);
        imported += batch.length;
      } catch (error) {
        failed += batch.length;
        errors.push(`Batch ${Math.floor(i / 25) + 1}: ${error}`);
      }
    }

    await createAuditLog('BULK_IMPORT', config.name, auth.userId, { imported, failed });

    return createResponse(200, { imported, failed, errors });
  } catch (error) {
    console.error('Error in bulk import:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

export async function handler(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  console.log('Event:', JSON.stringify(event, null, 2));

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

    // API routes pattern: /api/{tableIndex}[/{itemId}] or /api/{tableIndex}/bulk
    const apiMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(bulk))?$/);
    if (apiMatch) {
      const [, tableIndex, itemId, bulk] = apiMatch;

      if (bulk === 'bulk' && method === 'POST') {
        return await handleBulkImport(event, tableIndex);
      }

      if (itemId) {
        // Item-specific operations
        switch (method) {
          case 'GET':
            return await handleGetTableItem(event, tableIndex, itemId);
          case 'PUT':
            return await handleUpdateTableItem(event, tableIndex, itemId);
          case 'DELETE':
            return await handleDeleteTableItem(event, tableIndex, itemId);
        }
      } else {
        // Collection operations
        switch (method) {
          case 'GET':
            return await handleGetTableList(event, tableIndex);
          case 'POST':
            return await handleCreateTableItem(event, tableIndex);
        }
      }
    }

    return createResponse(404, { error: 'Not found' });
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}