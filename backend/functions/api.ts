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
  '14': { name: '在庫調整履歴', pk: 'ADJUST_HIST' }
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

function validateRequired(data: any, fields: string[]): string[] {
  const errors: string[] = [];
  for (const field of fields) {
    if (!data[field]) {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

function addTimestamps(item: any, isUpdate = false) {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    let user: User;
    try {
      user = extractUserFromEvent(event);
    } catch (error) {
      return createResponse(401, { error: 'Unauthorized' });
    }

    const path = event.pathParameters?.proxy || '';
    const pathParts = path.split('/');
    
    if (pathParts[0] === 'resources') {
      return await handleResourcesEndpoint(user, event);
    }

    if (pathParts[0] === 'api' && pathParts[1] && TABLE_CONFIGS[pathParts[1] as keyof typeof TABLE_CONFIGS]) {
      const tableIndex = pathParts[1];
      const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      
      if (pathParts[2] === 'bulk') {
        return await handleBulkImport(user, event, tableConfig);
      }
      
      return await handleTableEndpoint(user, event, tableConfig, pathParts);
    }

    return createResponse(404, { error: 'Not found' });
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

async function handleResourcesEndpoint(user: User, event: APIGatewayEvent): Promise<APIGatewayResponse> {
  if (!hasPermission(user, 'resources', 'read')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  if (event.httpMethod !== 'GET') {
    return createResponse(405, { error: 'Method not allowed' });
  }

  try {
    const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
      id: index,
      name: config.name,
      pk: config.pk
    }));

    return createResponse(200, { resources });
  } catch (error) {
    console.error('Resources error:', error);
    return createResponse(500, { error: 'Failed to fetch resources' });
  }
}

async function handleBulkImport(user: User, event: APIGatewayEvent, tableConfig: any): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'bulk')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  if (event.httpMethod !== 'POST') {
    return createResponse(405, { error: 'Method not allowed' });
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

    // Process in batches of 25 (DynamoDB BatchWrite limit)
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      const writeRequests = batch.map(item => {
        const processedItem = {
          ...item,
          pk: tableConfig.pk,
          sk: item.id || randomUUID(),
          id: item.id || randomUUID(),
          ...addTimestamps(item)
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
      } catch (error) {
        failed += batch.length;
        errors.push(`Batch ${Math.floor(i/25) + 1}: ${error}`);
      }
    }

    await writeAuditLog(user, 'BULK_IMPORT', tableConfig.pk, { imported, failed });

    return createResponse(200, { imported, failed, errors });
  } catch (error) {
    console.error('Bulk import error:', error);
    return createResponse(500, { error: 'Failed to import data' });
  }
}

async function handleTableEndpoint(user: User, event: APIGatewayEvent, tableConfig: any, pathParts: string[]): Promise<APIGatewayResponse> {
  const method = event.httpMethod;
  const id = pathParts[2];

  switch (method) {
    case 'GET':
      if (id) {
        return await handleGetItem(user, tableConfig, id);
      } else {
        return await handleListItems(user, tableConfig, event);
      }
    case 'POST':
      return await handleCreateItem(user, tableConfig, event);
    case 'PUT':
      if (!id) {
        return createResponse(400, { error: 'ID required for update' });
      }
      return await handleUpdateItem(user, tableConfig, id, event);
    case 'DELETE':
      if (!id) {
        return createResponse(400, { error: 'ID required for delete' });
      }
      return await handleDeleteItem(user, tableConfig, id);
    default:
      return createResponse(405, { error: 'Method not allowed' });
  }
}

async function handleListItems(user: User, tableConfig: any, event: APIGatewayEvent): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'read')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  try {
    const params: any = {
      TableName: TABLE_NAME,
      FilterExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': tableConfig.pk
      }
    };

    const queryParams = event.queryStringParameters || {};
    if (queryParams.limit) {
      params.Limit = parseInt(queryParams.limit);
    }
    if (queryParams.lastKey) {
      params.ExclusiveStartKey = JSON.parse(decodeURIComponent(queryParams.lastKey));
    }

    const result = await docClient.send(new ScanCommand(params));
    
    return createResponse(200, {
      items: result.Items || [],
      lastKey: result.LastEvaluatedKey ? encodeURIComponent(JSON.stringify(result.LastEvaluatedKey)) : null,
      count: result.Count || 0
    });
  } catch (error) {
    console.error('List items error:', error);
    return createResponse(500, { error: 'Failed to fetch items' });
  }
}

async function handleGetItem(user: User, tableConfig: any, id: string): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'read')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  try {
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: tableConfig.pk,
        sk: id
      }
    }));

    if (!result.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    return createResponse(200, { item: result.Item });
  } catch (error) {
    console.error('Get item error:', error);
    return createResponse(500, { error: 'Failed to fetch item' });
  }
}

async function handleCreateItem(user: User, tableConfig: any, event: APIGatewayEvent): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'create')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    
    // Basic validation
    const errors = validateRequired(body, ['name']);
    if (errors.length > 0) {
      return createResponse(400, { errors });
    }

    const id = randomUUID();
    const item = {
      ...body,
      pk: tableConfig.pk,
      sk: id,
      id,
      createdBy: user.id,
      updatedBy: user.id,
      ...addTimestamps(body)
    };

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    }));

    await writeAuditLog(user, 'CREATE', tableConfig.pk, { id });

    return createResponse(201, { item });
  } catch (error) {
    console.error('Create item error:', error);
    return createResponse(500, { error: 'Failed to create item' });
  }
}

async function handleUpdateItem(user: User, tableConfig: any, id: string, event: APIGatewayEvent): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'update')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    
    // Check if item exists
    const existing = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: tableConfig.pk,
        sk: id
      }
    }));

    if (!existing.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    const updatedItem = {
      ...existing.Item,
      ...body,
      updatedBy: user.id,
      ...addTimestamps(body, true)
    };

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedItem
    }));

    await writeAuditLog(user, 'UPDATE', tableConfig.pk, { id });

    return createResponse(200, { item: updatedItem });
  } catch (error) {
    console.error('Update item error:', error);
    return createResponse(500, { error: 'Failed to update item' });
  }
}

async function handleDeleteItem(user: User, tableConfig: any, id: string): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'delete')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  try {
    // Check if item exists
    const existing = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: tableConfig.pk,
        sk: id
      }
    }));

    if (!existing.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: tableConfig.pk,
        sk: id
      }
    }));

    await writeAuditLog(user, 'DELETE', tableConfig.pk, { id });

    return createResponse(200, { message: 'Item deleted successfully' });
  } catch (error) {
    console.error('Delete item error:', error);
    return createResponse(500, { error: 'Failed to delete item' });
  }
}