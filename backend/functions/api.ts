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

async function createAuditLog(user: User, action: string, resource: string, details: any = {}) {
  const auditItem = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.id,
    action,
    resource,
    details,
    timestamp: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditItem
  }));
}

function validateTableIndex(tableIndex: string): boolean {
  return tableIndex in TABLE_CONFIGS;
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
    
    if (pathParts[0] === 'api' && pathParts.length >= 2) {
      const tableIndex = pathParts[1];
      
      if (!validateTableIndex(tableIndex)) {
        return createResponse(404, { error: 'Table not found' });
      }
      
      const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      
      if (pathParts.length === 3 && pathParts[2] === 'bulk') {
        return await handleBulkImport(user, event, tableConfig);
      }
      
      return await handleTableOperations(user, event, tableConfig, pathParts);
    }
    
    return createResponse(404, { error: 'Endpoint not found' });
    
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

async function handleResourcesEndpoint(user: User, event: APIGatewayEvent): Promise<APIGatewayResponse> {
  if (event.httpMethod !== 'GET') {
    return createResponse(405, { error: 'Method not allowed' });
  }
  
  if (!hasPermission(user, 'resources', 'read')) {
    return createResponse(403, { error: 'Forbidden' });
  }
  
  const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
    index,
    name: config.name,
    pk: config.pk
  }));
  
  return createResponse(200, { resources });
}

async function handleBulkImport(user: User, event: APIGatewayEvent, tableConfig: any): Promise<APIGatewayResponse> {
  if (event.httpMethod !== 'POST') {
    return createResponse(405, { error: 'Method not allowed' });
  }
  
  if (!hasPermission(user, tableConfig.pk, 'bulk')) {
    return createResponse(403, { error: 'Forbidden' });
  }
  
  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }
  
  let requestBody;
  try {
    requestBody = JSON.parse(event.body);
  } catch (error) {
    return createResponse(400, { error: 'Invalid JSON in request body' });
  }
  
  if (!requestBody.items || !Array.isArray(requestBody.items)) {
    return createResponse(400, { error: 'items array is required' });
  }
  
  const items = requestBody.items;
  let imported = 0;
  let failed = 0;
  const errors: string[] = [];
  
  // Process in batches of 25 (DynamoDB BatchWrite limit)
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25);
    const putRequests = batch.map(item => {
      const processedItem = addTimestamps({
        ...item,
        pk: tableConfig.pk,
        sk: item.id || randomUUID(),
        id: item.id || randomUUID()
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
          [TABLE_NAME]: putRequests
        }
      }));
      imported += batch.length;
    } catch (error) {
      failed += batch.length;
      errors.push(`Batch ${Math.floor(i / 25) + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  await createAuditLog(user, 'BULK_IMPORT', tableConfig.pk, {
    imported,
    failed,
    totalItems: items.length
  });
  
  return createResponse(200, { imported, failed, errors });
}

async function handleTableOperations(user: User, event: APIGatewayEvent, tableConfig: any, pathParts: string[]): Promise<APIGatewayResponse> {
  const method = event.httpMethod;
  const hasId = pathParts.length >= 3;
  const itemId = hasId ? pathParts[2] : null;
  
  switch (method) {
    case 'GET':
      if (hasId) {
        return await handleGetItem(user, tableConfig, itemId!);
      } else {
        return await handleListItems(user, tableConfig, event.queryStringParameters);
      }
    
    case 'POST':
      if (hasId) {
        return createResponse(405, { error: 'Method not allowed' });
      }
      return await handleCreateItem(user, event, tableConfig);
    
    case 'PUT':
      if (!hasId) {
        return createResponse(400, { error: 'Item ID is required for PUT' });
      }
      return await handleUpdateItem(user, event, tableConfig, itemId!);
    
    case 'DELETE':
      if (!hasId) {
        return createResponse(400, { error: 'Item ID is required for DELETE' });
      }
      return await handleDeleteItem(user, tableConfig, itemId!);
    
    default:
      return createResponse(405, { error: 'Method not allowed' });
  }
}

async function handleListItems(user: User, tableConfig: any, queryParams: any): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'read')) {
    return createResponse(403, { error: 'Forbidden' });
  }
  
  try {
    const command = new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': tableConfig.pk
      }
    });
    
    const result = await docClient.send(command);
    return createResponse(200, { items: result.Items || [] });
  } catch (error) {
    console.error('List items error:', error);
    return createResponse(500, { error: 'Failed to retrieve items' });
  }
}

async function handleGetItem(user: User, tableConfig: any, itemId: string): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'read')) {
    return createResponse(403, { error: 'Forbidden' });
  }
  
  try {
    const command = new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: tableConfig.pk,
        sk: itemId
      }
    });
    
    const result = await docClient.send(command);
    
    if (!result.Item) {
      return createResponse(404, { error: 'Item not found' });
    }
    
    return createResponse(200, result.Item);
  } catch (error) {
    console.error('Get item error:', error);
    return createResponse(500, { error: 'Failed to retrieve item' });
  }
}

async function handleCreateItem(user: User, event: APIGatewayEvent, tableConfig: any): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'create')) {
    return createResponse(403, { error: 'Forbidden' });
  }
  
  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }
  
  let requestBody;
  try {
    requestBody = JSON.parse(event.body);
  } catch (error) {
    return createResponse(400, { error: 'Invalid JSON in request body' });
  }
  
  const itemId = requestBody.id || randomUUID();
  const item = addTimestamps({
    ...requestBody,
    pk: tableConfig.pk,
    sk: itemId,
    id: itemId,
    createdBy: user.id,
    updatedBy: user.id
  });
  
  try {
    const command = new PutCommand({
      TableName: TABLE_NAME,
      Item: item,
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)'
    });
    
    await docClient.send(command);
    await createAuditLog(user, 'CREATE', tableConfig.pk, { itemId });
    
    return createResponse(201, item);
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      return createResponse(409, { error: 'Item already exists' });
    }
    console.error('Create item error:', error);
    return createResponse(500, { error: 'Failed to create item' });
  }
}

async function handleUpdateItem(user: User, event: APIGatewayEvent, tableConfig: any, itemId: string): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'update')) {
    return createResponse(403, { error: 'Forbidden' });
  }
  
  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }
  
  let requestBody;
  try {
    requestBody = JSON.parse(event.body);
  } catch (error) {
    return createResponse(400, { error: 'Invalid JSON in request body' });
  }
  
  const updatedItem = addTimestamps({
    ...requestBody,
    pk: tableConfig.pk,
    sk: itemId,
    id: itemId,
    updatedBy: user.id
  }, true);
  
  try {
    const command = new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedItem,
      ConditionExpression: 'attribute_exists(pk) AND attribute_exists(sk)'
    });
    
    await docClient.send(command);
    await createAuditLog(user, 'UPDATE', tableConfig.pk, { itemId });
    
    return createResponse(200, updatedItem);
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      return createResponse(404, { error: 'Item not found' });
    }
    console.error('Update item error:', error);
    return createResponse(500, { error: 'Failed to update item' });
  }
}

async function handleDeleteItem(user: User, tableConfig: any, itemId: string): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'delete')) {
    return createResponse(403, { error: 'Forbidden' });
  }
  
  try {
    const command = new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: tableConfig.pk,
        sk: itemId
      },
      ConditionExpression: 'attribute_exists(pk) AND attribute_exists(sk)'
    });
    
    await docClient.send(command);
    await createAuditLog(user, 'DELETE', tableConfig.pk, { itemId });
    
    return createResponse(204, {});
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      return createResponse(404, { error: 'Item not found' });
    }
    console.error('Delete item error:', error);
    return createResponse(500, { error: 'Failed to delete item' });
  }
}