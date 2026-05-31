import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createUser, checkPermission, PERMISSIONS } from './rbac';
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

interface RequestContext {
  user: any;
  tableIndex: string;
  action: string;
  resourceId?: string;
}

function parseEvent(event: APIGatewayProxyEvent): RequestContext {
  const path = event.path || '';
  const method = event.httpMethod;
  
  // Extract user from headers (simplified)
  const userId = event.headers['x-user-id'] || 'anonymous';
  const userRole = (event.headers['x-user-role'] as 'admin' | 'operator' | 'viewer') || 'viewer';
  const user = createUser(userId, userRole);
  
  // Parse path: /resources or /api/{tableIndex}/... or /api/{tableIndex}/bulk
  if (path === '/resources') {
    return { user, tableIndex: '', action: 'list_resources', resourceId: undefined };
  }
  
  const pathParts = path.split('/').filter(p => p);
  if (pathParts.length >= 3 && pathParts[0] === 'api') {
    const tableIndex = pathParts[1];
    const resourceId = pathParts[2] === 'bulk' ? undefined : pathParts[2];
    const isBulk = pathParts[2] === 'bulk';
    
    let action = '';
    if (isBulk && method === 'POST') {
      action = 'bulk_import';
    } else if (method === 'GET' && resourceId) {
      action = 'get';
    } else if (method === 'GET') {
      action = 'list';
    } else if (method === 'POST') {
      action = 'create';
    } else if (method === 'PUT') {
      action = 'update';
    } else if (method === 'DELETE') {
      action = 'delete';
    }
    
    return { user, tableIndex, action, resourceId };
  }
  
  return { user, tableIndex: '', action: 'unknown', resourceId: undefined };
}

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-User-Id,X-User-Role'
    },
    body: JSON.stringify(body)
  };
}

async function writeAuditLog(action: string, userId: string, details: any): Promise<void> {
  const auditRecord = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    action,
    userId,
    timestamp: new Date().toISOString(),
    details,
    createdAt: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditRecord
  }));
}

async function handleListResources(context: RequestContext): Promise<APIGatewayProxyResult> {
  try {
    checkPermission(context.user, PERMISSIONS.READ_ALL);
    
    const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
      index,
      name: config.name,
      pk: config.pk
    }));
    
    return createResponse(200, { resources });
  } catch (error: any) {
    if (error.message.includes('Insufficient permissions')) {
      return createResponse(403, { error: 'Forbidden' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleList(context: RequestContext): Promise<APIGatewayProxyResult> {
  try {
    checkPermission(context.user, PERMISSIONS.READ_ALL);
    
    const config = TABLE_CONFIGS[context.tableIndex as keyof typeof TABLE_CONFIGS];
    if (!config) {
      return createResponse(404, { error: 'Table not found' });
    }
    
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': config.pk
      }
    }));
    
    return createResponse(200, { items: result.Items || [] });
  } catch (error: any) {
    if (error.message.includes('Insufficient permissions')) {
      return createResponse(403, { error: 'Forbidden' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGet(context: RequestContext): Promise<APIGatewayProxyResult> {
  try {
    checkPermission(context.user, PERMISSIONS.READ_ALL);
    
    const config = TABLE_CONFIGS[context.tableIndex as keyof typeof TABLE_CONFIGS];
    if (!config) {
      return createResponse(404, { error: 'Table not found' });
    }
    
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: context.resourceId
      }
    }));
    
    if (!result.Item) {
      return createResponse(404, { error: 'Item not found' });
    }
    
    return createResponse(200, result.Item);
  } catch (error: any) {
    if (error.message.includes('Insufficient permissions')) {
      return createResponse(403, { error: 'Forbidden' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleCreate(context: RequestContext, body: any): Promise<APIGatewayProxyResult> {
  try {
    checkPermission(context.user, PERMISSIONS.WRITE_ALL);
    
    const config = TABLE_CONFIGS[context.tableIndex as keyof typeof TABLE_CONFIGS];
    if (!config) {
      return createResponse(404, { error: 'Table not found' });
    }
    
    if (!body || typeof body !== 'object') {
      return createResponse(400, { error: 'Invalid request body' });
    }
    
    const now = new Date().toISOString();
    const id = body.id || randomUUID();
    
    const item = {
      ...body,
      pk: config.pk,
      sk: id,
      id,
      createdAt: now,
      updatedAt: now,
      createdBy: context.user.id,
      updatedBy: context.user.id
    };
    
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    }));
    
    await writeAuditLog('CREATE', context.user.id, {
      table: config.name,
      itemId: id
    });
    
    return createResponse(201, item);
  } catch (error: any) {
    if (error.message.includes('Insufficient permissions')) {
      return createResponse(403, { error: 'Forbidden' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpdate(context: RequestContext, body: any): Promise<APIGatewayProxyResult> {
  try {
    checkPermission(context.user, PERMISSIONS.WRITE_ALL);
    
    const config = TABLE_CONFIGS[context.tableIndex as keyof typeof TABLE_CONFIGS];
    if (!config) {
      return createResponse(404, { error: 'Table not found' });
    }
    
    if (!body || typeof body !== 'object') {
      return createResponse(400, { error: 'Invalid request body' });
    }
    
    const now = new Date().toISOString();
    
    const updateExpression = 'SET updatedAt = :updatedAt, updatedBy = :updatedBy';
    const expressionAttributeValues: any = {
      ':updatedAt': now,
      ':updatedBy': context.user.id
    };
    
    // Add other fields to update
    const fieldsToUpdate = Object.keys(body).filter(key => !['pk', 'sk', 'id', 'createdAt', 'createdBy'].includes(key));
    const updateExpressions = ['SET updatedAt = :updatedAt, updatedBy = :updatedBy'];
    
    fieldsToUpdate.forEach(field => {
      updateExpressions.push(`${field} = :${field}`);
      expressionAttributeValues[`:${field}`] = body[field];
    });
    
    await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: context.resourceId
      },
      UpdateExpression: updateExpressions.join(', '),
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    }));
    
    await writeAuditLog('UPDATE', context.user.id, {
      table: config.name,
      itemId: context.resourceId
    });
    
    return createResponse(200, { message: 'Updated successfully' });
  } catch (error: any) {
    if (error.message.includes('Insufficient permissions')) {
      return createResponse(403, { error: 'Forbidden' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDelete(context: RequestContext): Promise<APIGatewayProxyResult> {
  try {
    checkPermission(context.user, PERMISSIONS.DELETE_ALL);
    
    const config = TABLE_CONFIGS[context.tableIndex as keyof typeof TABLE_CONFIGS];
    if (!config) {
      return createResponse(404, { error: 'Table not found' });
    }
    
    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: context.resourceId
      }
    }));
    
    await writeAuditLog('DELETE', context.user.id, {
      table: config.name,
      itemId: context.resourceId
    });
    
    return createResponse(200, { message: 'Deleted successfully' });
  } catch (error: any) {
    if (error.message.includes('Insufficient permissions')) {
      return createResponse(403, { error: 'Forbidden' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleBulkImport(context: RequestContext, body: any): Promise<APIGatewayProxyResult> {
  try {
    checkPermission(context.user, PERMISSIONS.BULK_IMPORT);
    
    const config = TABLE_CONFIGS[context.tableIndex as keyof typeof TABLE_CONFIGS];
    if (!config) {
      return createResponse(404, { error: 'Table not found' });
    }
    
    if (!body || !Array.isArray(body.items)) {
      return createResponse(400, { error: 'Invalid request body. Expected { items: [] }' });
    }
    
    const items = body.items;
    let imported = 0;
    let failed = 0;
    const errors: string[] = [];
    
    const now = new Date().toISOString();
    
    // Process in batches of 25 (DynamoDB BatchWrite limit)
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      const writeRequests = batch.map(item => {
        const id = item.id || randomUUID();
        return {
          PutRequest: {
            Item: {
              ...item,
              pk: config.pk,
              sk: id,
              id,
              createdAt: now,
              updatedAt: now,
              createdBy: context.user.id,
              updatedBy: context.user.id
            }
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
        errors.push(`Batch ${Math.floor(i / 25) + 1}: ${error.message}`);
      }
    }
    
    await writeAuditLog('BULK_IMPORT', context.user.id, {
      table: config.name,
      imported,
      failed,
      total: items.length
    });
    
    return createResponse(200, { imported, failed, errors });
  } catch (error: any) {
    if (error.message.includes('Insufficient permissions')) {
      return createResponse(403, { error: 'Forbidden' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const context = parseEvent(event);
    let body: any = null;
    
    if (event.body) {
      try {
        body = JSON.parse(event.body);
      } catch {
        return createResponse(400, { error: 'Invalid JSON body' });
      }
    }
    
    switch (context.action) {
      case 'list_resources':
        return await handleListResources(context);
      case 'list':
        return await handleList(context);
      case 'get':
        return await handleGet(context);
      case 'create':
        return await handleCreate(context, body);
      case 'update':
        return await handleUpdate(context, body);
      case 'delete':
        return await handleDelete(context);
      case 'bulk_import':
        return await handleBulkImport(context, body);
      default:
        return createResponse(404, { error: 'Endpoint not found' });
    }
  } catch (error: any) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};