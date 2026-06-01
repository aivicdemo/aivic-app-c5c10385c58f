import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { hasPermission, validateRole, Role } from './rbac';
import * as crypto from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface AuthContext {
  userId: string;
  role: Role;
}

const TABLE_MAPPINGS = {
  '0': 'LOGIN_USER',
  '1': 'PRODUCT_MASTER',
  '2': 'SUPPLIER_MASTER',
  '3': 'INVENTORY_MANAGEMENT',
  '4': 'PURCHASE_RECORD',
  '5': 'SALES_RECORD',
  '6': 'MONTHLY_SUMMARY',
  '7': 'ORDER_RECOMMENDATION',
  '8': 'PRODUCT_PROPOSAL',
  '9': 'CUSTOMER_MASTER',
  '10': 'PET_INFO',
  '11': 'CUSTOMER_USAGE_HISTORY',
  '12': 'DEMAND_FORECAST',
  '13': 'ORDER_HISTORY',
  '14': 'INVENTORY_ADJUSTMENT_HISTORY'
};

function getAuthContext(event: APIGatewayProxyEvent): AuthContext {
  const userId = event.headers['x-user-id'] || 'anonymous';
  const role = event.headers['x-user-role'] || 'viewer';
  
  if (!validateRole(role)) {
    throw new Error('Invalid role');
  }
  
  return { userId, role };
}

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-user-id, x-user-role'
    },
    body: JSON.stringify(body)
  };
}

async function createAuditLog(action: string, userId: string, details: any) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${crypto.randomUUID()}`,
    action,
    userId,
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

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = getAuthContext(event);
    const path = event.path;
    const method = event.httpMethod;
    
    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    // GET /resources - リソース一覧取得
    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(auth.role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const resources = Object.entries(TABLE_MAPPINGS).map(([index, tableName]) => ({
        index,
        tableName,
        endpoints: {
          list: `GET /api/${index}`,
          get: `GET /api/${index}/{id}`,
          create: `POST /api/${index}`,
          update: `PUT /api/${index}/{id}`,
          delete: `DELETE /api/${index}/{id}`,
          bulk: `POST /api/${index}/bulk`
        }
      }));

      return createResponse(200, { resources });
    }

    // API routes
    const apiMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(\w+))?$/);
    if (!apiMatch) {
      return createResponse(404, { error: 'Not found' });
    }

    const [, tableIndex, resourceId, action] = apiMatch;
    const tableName = TABLE_MAPPINGS[tableIndex as keyof typeof TABLE_MAPPINGS];
    
    if (!tableName) {
      return createResponse(404, { error: 'Table not found' });
    }

    // Bulk import endpoint
    if (resourceId === 'bulk' && method === 'POST') {
      if (!hasPermission(auth.role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
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
        const putRequests = batch.map(item => {
          const processedItem = {
            ...item,
            pk: tableName,
            sk: item.id || crypto.randomUUID(),
            id: item.id || crypto.randomUUID(),
            ...addTimestamps(item, false)
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
          errors.push(`Batch ${Math.floor(i/25) + 1}: ${error}`);
        }
      }

      await createAuditLog('BULK_IMPORT', auth.userId, {
        tableName,
        imported,
        failed,
        totalItems: items.length
      });

      return createResponse(200, { imported, failed, errors });
    }

    // List items
    if (method === 'GET' && !resourceId) {
      if (!hasPermission(auth.role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const result = await docClient.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'pk = :pk',
        ExpressionAttributeValues: {
          ':pk': tableName
        }
      }));

      return createResponse(200, { items: result.Items || [] });
    }

    // Get single item
    if (method === 'GET' && resourceId) {
      if (!hasPermission(auth.role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableName,
          sk: resourceId
        }
      }));

      if (!result.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      return createResponse(200, result.Item);
    }

    // Create item
    if (method === 'POST' && !resourceId) {
      if (!hasPermission(auth.role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const body = JSON.parse(event.body || '{}');
      const id = body.id || crypto.randomUUID();
      
      const item = {
        ...body,
        pk: tableName,
        sk: id,
        id,
        ...addTimestamps(body, false)
      };

      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      }));

      await createAuditLog('CREATE', auth.userId, { tableName, itemId: id });

      return createResponse(201, item);
    }

    // Update item
    if (method === 'PUT' && resourceId) {
      if (!hasPermission(auth.role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const body = JSON.parse(event.body || '{}');
      
      // Check if item exists
      const existing = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableName,
          sk: resourceId
        }
      }));

      if (!existing.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      const updatedItem = {
        ...existing.Item,
        ...body,
        pk: tableName,
        sk: resourceId,
        id: resourceId,
        ...addTimestamps(body, true)
      };

      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: updatedItem
      }));

      await createAuditLog('UPDATE', auth.userId, { tableName, itemId: resourceId });

      return createResponse(200, updatedItem);
    }

    // Delete item
    if (method === 'DELETE' && resourceId) {
      if (!hasPermission(auth.role, 'delete')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      // Check if item exists
      const existing = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableName,
          sk: resourceId
        }
      }));

      if (!existing.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      await docClient.send(new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableName,
          sk: resourceId
        }
      }));

      await createAuditLog('DELETE', auth.userId, { tableName, itemId: resourceId });

      return createResponse(200, { message: 'Item deleted successfully' });
    }

    return createResponse(405, { error: 'Method not allowed' });

  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON in request body' });
    }
    
    if (error.message === 'Invalid role') {
      return createResponse(403, { error: 'Invalid role' });
    }
    
    return createResponse(500, { error: 'Internal server error' });
  }
};