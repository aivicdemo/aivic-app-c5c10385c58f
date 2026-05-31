import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
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
  pathParameters: any;
  queryStringParameters: any;
  body: string | null;
  headers: any;
}

interface APIGatewayResponse {
  statusCode: number;
  headers: any;
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

async function writeAuditLog(user: User, action: string, resource: string, details: any) {
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

function validateRequired(data: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
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

async function handleList(tableIndex: string, user: User, queryParams: any) {
  if (!hasPermission(user, 'resources', 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  try {
    const limit = queryParams?.limit ? parseInt(queryParams.limit) : 50;
    const lastKey = queryParams?.lastKey ? JSON.parse(decodeURIComponent(queryParams.lastKey)) : undefined;

    const command = new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': config.pk
      },
      Limit: limit,
      ExclusiveStartKey: lastKey
    });

    const result = await docClient.send(command);
    
    return createResponse(200, {
      items: result.Items || [],
      lastKey: result.LastEvaluatedKey ? encodeURIComponent(JSON.stringify(result.LastEvaluatedKey)) : null,
      count: result.Count || 0
    });
  } catch (error) {
    console.error('List error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGet(tableIndex: string, id: string, user: User) {
  if (!hasPermission(user, 'resources', 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
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
        sk: id
      }
    });

    const result = await docClient.send(command);
    
    if (!result.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    return createResponse(200, result.Item);
  } catch (error) {
    console.error('Get error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleCreate(tableIndex: string, data: any, user: User) {
  if (!hasPermission(user, 'resources', 'create')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  try {
    const id = data.id || randomUUID();
    const item = {
      pk: config.pk,
      sk: id,
      id,
      ...data,
      createdBy: user.id,
      updatedBy: user.id
    };
    
    addTimestamps(item);

    const command = new PutCommand({
      TableName: TABLE_NAME,
      Item: item,
      ConditionExpression: 'attribute_not_exists(pk)'
    });

    await docClient.send(command);
    await writeAuditLog(user, 'CREATE', config.name, { id, tableIndex });

    return createResponse(201, item);
  } catch (error: any) {
    console.error('Create error:', error);
    if (error.name === 'ConditionalCheckFailedException') {
      return createResponse(409, { error: 'Item already exists' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpdate(tableIndex: string, id: string, data: any, user: User) {
  if (!hasPermission(user, 'resources', 'update')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  try {
    const updateData = {
      ...data,
      updatedBy: user.id
    };
    addTimestamps(updateData, true);

    const updateExpression = [];
    const expressionAttributeNames: any = {};
    const expressionAttributeValues: any = {};

    for (const [key, value] of Object.entries(updateData)) {
      if (key !== 'pk' && key !== 'sk' && key !== 'id') {
        updateExpression.push(`#${key} = :${key}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:${key}`] = value;
      }
    }

    const command = new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: id
      },
      UpdateExpression: `SET ${updateExpression.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ConditionExpression: 'attribute_exists(pk)',
      ReturnValues: 'ALL_NEW'
    });

    const result = await docClient.send(command);
    await writeAuditLog(user, 'UPDATE', config.name, { id, tableIndex, changes: data });

    return createResponse(200, result.Attributes);
  } catch (error: any) {
    console.error('Update error:', error);
    if (error.name === 'ConditionalCheckFailedException') {
      return createResponse(404, { error: 'Item not found' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDelete(tableIndex: string, id: string, user: User) {
  if (!hasPermission(user, 'resources', 'delete')) {
    return createResponse(403, { error: 'Insufficient permissions' });
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
        sk: id
      },
      ConditionExpression: 'attribute_exists(pk)',
      ReturnValues: 'ALL_OLD'
    });

    const result = await docClient.send(command);
    await writeAuditLog(user, 'DELETE', config.name, { id, tableIndex });

    return createResponse(200, { message: 'Item deleted successfully', item: result.Attributes });
  } catch (error: any) {
    console.error('Delete error:', error);
    if (error.name === 'ConditionalCheckFailedException') {
      return createResponse(404, { error: 'Item not found' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleBulkImport(tableIndex: string, items: any[], user: User) {
  if (!hasPermission(user, 'resources', 'bulk')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!Array.isArray(items) || items.length === 0) {
    return createResponse(400, { error: 'Items array is required and must not be empty' });
  }

  try {
    let imported = 0;
    let failed = 0;
    const errors: string[] = [];

    // Process in batches of 25 (DynamoDB BatchWrite limit)
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      const writeRequests = batch.map(item => {
        const id = item.id || randomUUID();
        const processedItem = {
          pk: config.pk,
          sk: id,
          id,
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
        const command = new BatchWriteCommand({
          RequestItems: {
            [TABLE_NAME]: writeRequests
          }
        });

        const result = await docClient.send(command);
        
        // Handle unprocessed items
        if (result.UnprocessedItems && result.UnprocessedItems[TABLE_NAME]) {
          const unprocessedCount = result.UnprocessedItems[TABLE_NAME].length;
          failed += unprocessedCount;
          imported += (batch.length - unprocessedCount);
          errors.push(`${unprocessedCount} items in batch ${Math.floor(i/25) + 1} were not processed`);
        } else {
          imported += batch.length;
        }
      } catch (batchError: any) {
        console.error('Batch write error:', batchError);
        failed += batch.length;
        errors.push(`Batch ${Math.floor(i/25) + 1} failed: ${batchError.message}`);
      }
    }

    await writeAuditLog(user, 'BULK_IMPORT', config.name, { 
      tableIndex, 
      totalItems: items.length, 
      imported, 
      failed 
    });

    return createResponse(200, {
      imported,
      failed,
      errors
    });
  } catch (error: any) {
    console.error('Bulk import error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  if (event.httpMethod === 'OPTIONS') {
    return createResponse(200, {});
  }

  try {
    const user = extractUserFromEvent(event);
    const path = event.pathParameters?.proxy || '';
    const pathParts = path.split('/');

    // Handle /resources endpoint
    if (path === 'resources' && event.httpMethod === 'GET') {
      if (!hasPermission(user, 'resources', 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }
      
      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        index,
        name: config.name,
        pk: config.pk
      }));
      
      return createResponse(200, { resources });
    }

    // Handle table-specific endpoints
    if (pathParts.length >= 1) {
      const tableIndex = pathParts[0];
      const itemId = pathParts[1];
      const action = pathParts[2];

      // Handle bulk import: POST /api/{tableIndex}/bulk
      if (action === 'bulk' && event.httpMethod === 'POST') {
        const body = event.body ? JSON.parse(event.body) : {};
        return await handleBulkImport(tableIndex, body.items || [], user);
      }

      // Handle CRUD operations
      switch (event.httpMethod) {
        case 'GET':
          if (itemId) {
            return await handleGet(tableIndex, itemId, user);
          } else {
            return await handleList(tableIndex, user, event.queryStringParameters);
          }
        
        case 'POST':
          const createBody = event.body ? JSON.parse(event.body) : {};
          return await handleCreate(tableIndex, createBody, user);
        
        case 'PUT':
          if (!itemId) {
            return createResponse(400, { error: 'Item ID is required for update' });
          }
          const updateBody = event.body ? JSON.parse(event.body) : {};
          return await handleUpdate(tableIndex, itemId, updateBody, user);
        
        case 'DELETE':
          if (!itemId) {
            return createResponse(400, { error: 'Item ID is required for delete' });
          }
          return await handleDelete(tableIndex, itemId, user);
        
        default:
          return createResponse(405, { error: 'Method not allowed' });
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });
  } catch (error: any) {
    console.error('Handler error:', error);
    if (error.message.includes('Authorization') || error.message.includes('token')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
};