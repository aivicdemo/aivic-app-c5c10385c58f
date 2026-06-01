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
  const auditRecord = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.id,
    action,
    resource,
    details,
    timestamp: new Date().toISOString()
  };
  
  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: auditRecord
    }));
  } catch (error) {
    console.error('Failed to write audit log:', error);
  }
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

function generateId(): string {
  return randomUUID();
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
  } catch (error) {
    console.error('Error in handleGetResources:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetTableData(event: any): Promise<APIResponse> {
  try {
    const user = extractUserFromEvent(event);
    const tableIndex = event.pathParameters?.tableIndex;
    
    if (!validateTableIndex(tableIndex)) {
      return createResponse(404, { error: 'Table not found' });
    }
    
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
  } catch (error) {
    console.error('Error in handleGetTableData:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetTableItem(event: any): Promise<APIResponse> {
  try {
    const user = extractUserFromEvent(event);
    const tableIndex = event.pathParameters?.tableIndex;
    const itemId = event.pathParameters?.id;
    
    if (!validateTableIndex(tableIndex) || !itemId) {
      return createResponse(404, { error: 'Table or item not found' });
    }
    
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
  } catch (error) {
    console.error('Error in handleGetTableItem:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleCreateTableItem(event: any): Promise<APIResponse> {
  try {
    const user = extractUserFromEvent(event);
    const tableIndex = event.pathParameters?.tableIndex;
    
    if (!validateTableIndex(tableIndex)) {
      return createResponse(404, { error: 'Table not found' });
    }
    
    if (!hasPermission(user, 'table', 'create')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    const body = JSON.parse(event.body || '{}');
    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    const item = addTimestamps({
      pk: config.pk,
      sk: generateId(),
      ...body,
      createdBy: user.id,
      updatedBy: user.id
    });

    const command = new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    });

    await docClient.send(command);
    await writeAuditLog(user, 'CREATE', config.name, { itemId: item.sk });

    return createResponse(201, { item });
  } catch (error) {
    console.error('Error in handleCreateTableItem:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpdateTableItem(event: any): Promise<APIResponse> {
  try {
    const user = extractUserFromEvent(event);
    const tableIndex = event.pathParameters?.tableIndex;
    const itemId = event.pathParameters?.id;
    
    if (!validateTableIndex(tableIndex) || !itemId) {
      return createResponse(404, { error: 'Table or item not found' });
    }
    
    if (!hasPermission(user, 'table', 'update')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    const body = JSON.parse(event.body || '{}');
    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    const updatedItem = addTimestamps({
      ...body,
      updatedBy: user.id
    }, true);

    const updateExpressions: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, any> = {};

    Object.entries(updatedItem).forEach(([key, value], index) => {
      if (key !== 'pk' && key !== 'sk') {
        const attrName = `#attr${index}`;
        const attrValue = `:val${index}`;
        updateExpressions.push(`${attrName} = ${attrValue}`);
        expressionAttributeNames[attrName] = key;
        expressionAttributeValues[attrValue] = value;
      }
    });

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
    await writeAuditLog(user, 'UPDATE', config.name, { itemId });

    return createResponse(200, { item: result.Attributes });
  } catch (error) {
    console.error('Error in handleUpdateTableItem:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDeleteTableItem(event: any): Promise<APIResponse> {
  try {
    const user = extractUserFromEvent(event);
    const tableIndex = event.pathParameters?.tableIndex;
    const itemId = event.pathParameters?.id;
    
    if (!validateTableIndex(tableIndex) || !itemId) {
      return createResponse(404, { error: 'Table or item not found' });
    }
    
    if (!hasPermission(user, 'table', 'delete')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    const command = new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: itemId
      }
    });

    await docClient.send(command);
    await writeAuditLog(user, 'DELETE', config.name, { itemId });

    return createResponse(200, { message: 'Item deleted successfully' });
  } catch (error) {
    console.error('Error in handleDeleteTableItem:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleBulkImport(event: any): Promise<APIResponse> {
  try {
    const user = extractUserFromEvent(event);
    const tableIndex = event.pathParameters?.tableIndex;
    
    if (!validateTableIndex(tableIndex)) {
      return createResponse(404, { error: 'Table not found' });
    }
    
    if (!hasPermission(user, 'table', 'bulk')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    const body = JSON.parse(event.body || '{}');
    const items = body.items || [];
    
    if (!Array.isArray(items)) {
      return createResponse(400, { error: 'Items must be an array' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    let imported = 0;
    let failed = 0;
    const errors: string[] = [];

    // Process items in batches of 25 (DynamoDB BatchWrite limit)
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      const writeRequests = batch.map(item => {
        const processedItem = addTimestamps({
          pk: config.pk,
          sk: generateId(),
          ...item,
          createdBy: user.id,
          updatedBy: user.id
        });

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

        await docClient.send(command);
        imported += batch.length;
      } catch (error) {
        failed += batch.length;
        errors.push(`Batch ${Math.floor(i / 25) + 1}: ${error}`);
      }
    }

    await writeAuditLog(user, 'BULK_IMPORT', config.name, { 
      totalItems: items.length,
      imported,
      failed
    });

    return createResponse(200, {
      imported,
      failed,
      errors
    });
  } catch (error) {
    console.error('Error in handleBulkImport:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

export const handler = async (event: any): Promise<APIResponse> => {
  try {
    const method = event.httpMethod;
    const path = event.path;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    // Route handling
    if (method === 'GET' && path === '/resources') {
      return await handleGetResources(event);
    }
    
    if (method === 'GET' && path.match(/^\/api\/\d+$/)) {
      return await handleGetTableData(event);
    }
    
    if (method === 'GET' && path.match(/^\/api\/\d+\/[^/]+$/)) {
      return await handleGetTableItem(event);
    }
    
    if (method === 'POST' && path.match(/^\/api\/\d+$/)) {
      return await handleCreateTableItem(event);
    }
    
    if (method === 'POST' && path.match(/^\/api\/\d+\/bulk$/)) {
      return await handleBulkImport(event);
    }
    
    if (method === 'PUT' && path.match(/^\/api\/\d+\/[^/]+$/)) {
      return await handleUpdateTableItem(event);
    }
    
    if (method === 'DELETE' && path.match(/^\/api\/\d+\/[^/]+$/)) {
      return await handleDeleteTableItem(event);
    }

    return createResponse(404, { error: 'Endpoint not found' });
  } catch (error) {
    console.error('Unhandled error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};