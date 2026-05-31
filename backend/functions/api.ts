import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
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
  '7': { name: '発注推奨', pk: 'ORDER_RECOMMEND' },
  '8': { name: '商品提案情報', pk: 'PRODUCT_PROPOSAL' },
  '9': { name: '顧客マスタ', pk: 'CUSTOMER' },
  '10': { name: 'ペット情報', pk: 'PET' },
  '11': { name: '顧客利用履歴', pk: 'CUSTOMER_HISTORY' },
  '12': { name: '需要予測', pk: 'DEMAND_FORECAST' },
  '13': { name: '発注履歴', pk: 'ORDER_HISTORY' },
  '14': { name: '在庫調整履歴', pk: 'INVENTORY_ADJUSTMENT' }
};

interface APIGatewayEvent {
  httpMethod: string;
  path: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  body?: string;
  headers?: { [key: string]: string };
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

async function createAuditLog(user: User, action: string, resource: string, details: any) {
  const auditLog = {
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
    Item: auditLog
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

function addTimestamps(item: any, isUpdate = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

async function handleBulkImport(tableIndex: string, items: any[], user: User): Promise<any> {
  if (!hasPermission(user, 'bulk', 'bulk')) {
    throw new Error('Insufficient permissions for bulk import');
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    throw new Error('Invalid table index');
  }

  let imported = 0;
  let failed = 0;
  const errors: string[] = [];

  // Process in batches of 25 (DynamoDB BatchWrite limit)
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25);
    const putRequests = batch.map(item => {
      const processedItem = {
        ...item,
        pk: config.pk,
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
          [TABLE_NAME]: putRequests
        }
      }));
      imported += batch.length;
    } catch (error) {
      failed += batch.length;
      errors.push(`Batch ${Math.floor(i/25) + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  await createAuditLog(user, 'BULK_IMPORT', config.name, {
    tableIndex,
    imported,
    failed,
    totalItems: items.length
  });

  return { imported, failed, errors };
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const user = extractUserFromEvent(event);
    const path = event.path;
    const method = event.httpMethod;
    
    // Handle /resources endpoint
    if (path === '/resources' && method === 'GET') {
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

    // Parse table operations
    const pathMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(bulk))?$/);
    if (!pathMatch) {
      return createResponse(404, { error: 'Endpoint not found' });
    }

    const [, tableIndex, itemId, bulkFlag] = pathMatch;
    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    if (!config) {
      return createResponse(404, { error: 'Table not found' });
    }

    // Handle bulk import
    if (bulkFlag === 'bulk' && method === 'POST') {
      if (!hasPermission(user, config.pk, 'bulk')) {
        return createResponse(403, { error: 'Insufficient permissions for bulk operations' });
      }

      const body = JSON.parse(event.body || '{}');
      if (!body.items || !Array.isArray(body.items)) {
        return createResponse(400, { error: 'Invalid request body. Expected { items: [] }' });
      }

      const result = await handleBulkImport(tableIndex, body.items, user);
      return createResponse(200, result);
    }

    // Handle CRUD operations
    switch (method) {
      case 'GET':
        if (!hasPermission(user, config.pk, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (itemId) {
          // Get single item
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: config.pk, sk: itemId }
          }));
          
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, result.Item);
        } else {
          // List items
          const limit = parseInt(event.queryStringParameters?.limit || '50');
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: { ':pk': config.pk },
            Limit: limit
          }));
          
          return createResponse(200, {
            items: result.Items || [],
            count: result.Count || 0
          });
        }

      case 'POST':
        if (!hasPermission(user, config.pk, 'create')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const createBody = JSON.parse(event.body || '{}');
        const createItem = {
          ...createBody,
          pk: config.pk,
          sk: createBody.id || randomUUID(),
          id: createBody.id || randomUUID(),
          ...addTimestamps(createBody)
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: createItem
        }));

        await createAuditLog(user, 'CREATE', config.name, { itemId: createItem.id });
        return createResponse(201, createItem);

      case 'PUT':
        if (!hasPermission(user, config.pk, 'update')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (!itemId) {
          return createResponse(400, { error: 'Item ID required for update' });
        }

        const updateBody = JSON.parse(event.body || '{}');
        const updateItem = {
          ...updateBody,
          pk: config.pk,
          sk: itemId,
          id: itemId,
          ...addTimestamps(updateBody, true)
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updateItem
        }));

        await createAuditLog(user, 'UPDATE', config.name, { itemId });
        return createResponse(200, updateItem);

      case 'DELETE':
        if (!hasPermission(user, config.pk, 'delete')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (!itemId) {
          return createResponse(400, { error: 'Item ID required for deletion' });
        }

        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { pk: config.pk, sk: itemId }
        }));

        await createAuditLog(user, 'DELETE', config.name, { itemId });
        return createResponse(200, { message: 'Item deleted successfully' });

      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof Error) {
      if (error.message.includes('permissions')) {
        return createResponse(403, { error: error.message });
      }
      if (error.message.includes('not found')) {
        return createResponse(404, { error: error.message });
      }
      if (error.message.includes('required') || error.message.includes('Invalid')) {
        return createResponse(400, { error: error.message });
      }
    }
    
    return createResponse(500, { error: 'Internal server error' });
  }
};