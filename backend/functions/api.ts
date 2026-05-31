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
  const auditItem = {
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

function addTimestamps(item: any, isUpdate = false) {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

export const handler = async (event: any): Promise<APIResponse> => {
  try {
    const method = event.httpMethod;
    const path = event.path;
    const pathParams = event.pathParameters || {};
    
    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    let user: User;
    try {
      user = extractUserFromEvent(event);
    } catch (error) {
      return createResponse(401, { error: 'Unauthorized' });
    }

    // GET /resources
    if (method === 'GET' && path === '/resources') {
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

    // Extract table index from path
    const tableMatch = path.match(/^\/api\/(\d+)/);
    if (!tableMatch) {
      return createResponse(404, { error: 'Not found' });
    }
    
    const tableIndex = tableMatch[1];
    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }

    const resourceName = tableConfig.name;
    const pk = tableConfig.pk;

    // GET /api/{tableIndex} - List items
    if (method === 'GET' && path === `/api/${tableIndex}`) {
      if (!hasPermission(user, resourceName, 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }
      
      const result = await docClient.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'pk = :pk',
        ExpressionAttributeValues: {
          ':pk': pk
        }
      }));
      
      return createResponse(200, { items: result.Items || [] });
    }

    // GET /api/{tableIndex}/{id} - Get item by ID
    if (method === 'GET' && pathParams.id) {
      if (!hasPermission(user, resourceName, 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }
      
      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: pk,
          sk: pathParams.id
        }
      }));
      
      if (!result.Item) {
        return createResponse(404, { error: 'Item not found' });
      }
      
      return createResponse(200, { item: result.Item });
    }

    // POST /api/{tableIndex}/bulk - Bulk import
    if (method === 'POST' && path.endsWith('/bulk')) {
      if (!hasPermission(user, resourceName, 'bulk')) {
        return createResponse(403, { error: 'Forbidden' });
      }
      
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
        const writeRequests = [];
        
        for (const item of batch) {
          try {
            const processedItem = {
              ...item,
              pk: pk,
              sk: item.id || randomUUID(),
              ...addTimestamps(item)
            };
            
            writeRequests.push({
              PutRequest: {
                Item: processedItem
              }
            });
          } catch (error) {
            failed++;
            errors.push(`Item ${i}: ${error}`);
          }
        }
        
        if (writeRequests.length > 0) {
          try {
            await docClient.send(new BatchWriteCommand({
              RequestItems: {
                [TABLE_NAME]: writeRequests
              }
            }));
            imported += writeRequests.length;
          } catch (error) {
            failed += writeRequests.length;
            errors.push(`Batch write failed: ${error}`);
          }
        }
      }
      
      await writeAuditLog(user, 'BULK_IMPORT', resourceName, { imported, failed });
      
      return createResponse(200, { imported, failed, errors });
    }

    // POST /api/{tableIndex} - Create item
    if (method === 'POST' && path === `/api/${tableIndex}`) {
      if (!hasPermission(user, resourceName, 'create')) {
        return createResponse(403, { error: 'Forbidden' });
      }
      
      const body = JSON.parse(event.body || '{}');
      const item = {
        ...body,
        pk: pk,
        sk: body.id || randomUUID(),
        createdBy: user.id,
        updatedBy: user.id,
        ...addTimestamps(body)
      };
      
      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      }));
      
      await writeAuditLog(user, 'CREATE', resourceName, { id: item.sk });
      
      return createResponse(201, { item });
    }

    // PUT /api/{tableIndex}/{id} - Update item
    if (method === 'PUT' && pathParams.id) {
      if (!hasPermission(user, resourceName, 'update')) {
        return createResponse(403, { error: 'Forbidden' });
      }
      
      const body = JSON.parse(event.body || '{}');
      
      // Check if item exists
      const existing = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: pk,
          sk: pathParams.id
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
      
      await writeAuditLog(user, 'UPDATE', resourceName, { id: pathParams.id });
      
      return createResponse(200, { item: updatedItem });
    }

    // DELETE /api/{tableIndex}/{id} - Delete item
    if (method === 'DELETE' && pathParams.id) {
      if (!hasPermission(user, resourceName, 'delete')) {
        return createResponse(403, { error: 'Forbidden' });
      }
      
      // Check if item exists
      const existing = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: pk,
          sk: pathParams.id
        }
      }));
      
      if (!existing.Item) {
        return createResponse(404, { error: 'Item not found' });
      }
      
      await docClient.send(new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: pk,
          sk: pathParams.id
        }
      }));
      
      await writeAuditLog(user, 'DELETE', resourceName, { id: pathParams.id });
      
      return createResponse(200, { message: 'Item deleted successfully' });
    }

    return createResponse(404, { error: 'Not found' });
    
  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};