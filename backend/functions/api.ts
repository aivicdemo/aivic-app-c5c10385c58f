import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { hasPermission, createUser, PERMISSIONS } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE || 'inventory-management-table';

interface ApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
};

const TABLE_CONFIGS = {
  '0': { name: 'ログインユーザー', pk: 'USER', permissions: { read: PERMISSIONS.READ_USERS, write: PERMISSIONS.WRITE_USERS, delete: PERMISSIONS.DELETE_USERS } },
  '1': { name: '商品マスタ', pk: 'PRODUCT', permissions: { read: PERMISSIONS.READ_PRODUCTS, write: PERMISSIONS.WRITE_PRODUCTS, delete: PERMISSIONS.DELETE_PRODUCTS } },
  '2': { name: '仕入先マスタ', pk: 'SUPPLIER', permissions: { read: PERMISSIONS.READ_SUPPLIERS, write: PERMISSIONS.WRITE_SUPPLIERS, delete: PERMISSIONS.DELETE_SUPPLIERS } },
  '3': { name: '在庫管理', pk: 'INVENTORY', permissions: { read: PERMISSIONS.READ_INVENTORY, write: PERMISSIONS.WRITE_INVENTORY, delete: PERMISSIONS.DELETE_INVENTORY } },
  '4': { name: '仕入実績', pk: 'PURCHASE_RECORD', permissions: { read: PERMISSIONS.READ_PURCHASE_RECORDS, write: PERMISSIONS.WRITE_PURCHASE_RECORDS, delete: PERMISSIONS.DELETE_PURCHASE_RECORDS } },
  '5': { name: '売上実績', pk: 'SALES_RECORD', permissions: { read: PERMISSIONS.READ_SALES_RECORDS, write: PERMISSIONS.WRITE_SALES_RECORDS, delete: PERMISSIONS.DELETE_SALES_RECORDS } },
  '6': { name: '月次集計', pk: 'MONTHLY_SUMMARY', permissions: { read: PERMISSIONS.READ_MONTHLY_SUMMARY, write: PERMISSIONS.WRITE_MONTHLY_SUMMARY, delete: PERMISSIONS.DELETE_MONTHLY_SUMMARY } },
  '7': { name: '発注推奨', pk: 'ORDER_RECOMMENDATION', permissions: { read: PERMISSIONS.READ_ORDER_RECOMMENDATIONS, write: PERMISSIONS.WRITE_ORDER_RECOMMENDATIONS, delete: PERMISSIONS.DELETE_ORDER_RECOMMENDATIONS } },
  '8': { name: '商品提案情報', pk: 'PRODUCT_PROPOSAL', permissions: { read: PERMISSIONS.READ_PRODUCT_PROPOSALS, write: PERMISSIONS.WRITE_PRODUCT_PROPOSALS, delete: PERMISSIONS.DELETE_PRODUCT_PROPOSALS } },
  '9': { name: '顧客マスタ', pk: 'CUSTOMER', permissions: { read: PERMISSIONS.READ_CUSTOMERS, write: PERMISSIONS.WRITE_CUSTOMERS, delete: PERMISSIONS.DELETE_CUSTOMERS } },
  '10': { name: 'ペット情報', pk: 'PET', permissions: { read: PERMISSIONS.READ_PETS, write: PERMISSIONS.WRITE_PETS, delete: PERMISSIONS.DELETE_PETS } },
  '11': { name: '顧客利用履歴', pk: 'CUSTOMER_HISTORY', permissions: { read: PERMISSIONS.READ_CUSTOMER_HISTORY, write: PERMISSIONS.WRITE_CUSTOMER_HISTORY, delete: PERMISSIONS.DELETE_CUSTOMER_HISTORY } },
  '12': { name: '需要予測', pk: 'DEMAND_FORECAST', permissions: { read: PERMISSIONS.READ_DEMAND_FORECAST, write: PERMISSIONS.WRITE_DEMAND_FORECAST, delete: PERMISSIONS.DELETE_DEMAND_FORECAST } },
  '13': { name: '発注履歴', pk: 'ORDER_HISTORY', permissions: { read: PERMISSIONS.READ_ORDER_HISTORY, write: PERMISSIONS.WRITE_ORDER_HISTORY, delete: PERMISSIONS.DELETE_ORDER_HISTORY } },
  '14': { name: '在庫調整履歴', pk: 'INVENTORY_ADJUSTMENT', permissions: { read: PERMISSIONS.READ_INVENTORY_ADJUSTMENTS, write: PERMISSIONS.WRITE_INVENTORY_ADJUSTMENTS, delete: PERMISSIONS.DELETE_INVENTORY_ADJUSTMENTS } }
};

function createResponse(statusCode: number, body: any): ApiResponse {
  return {
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(body)
  };
}

function getUserFromEvent(event: APIGatewayProxyEvent) {
  const authHeader = event.headers.Authorization || event.headers.authorization;
  if (!authHeader) {
    return null;
  }
  
  try {
    const token = authHeader.replace('Bearer ', '');
    const [userId, role] = token.split(':');
    if (!userId || !['admin', 'operator', 'viewer'].includes(role)) {
      return null;
    }
    return createUser(userId, role as 'admin' | 'operator' | 'viewer');
  } catch {
    return null;
  }
}

async function writeAuditLog(action: string, userId: string, details: any) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    action,
    userId,
    details,
    timestamp: new Date().toISOString()
  };
  
  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: auditLog
    }));
  } catch (error) {
    console.error('Failed to write audit log:', error);
  }
}

async function handleGetResources(event: APIGatewayProxyEvent): Promise<ApiResponse> {
  const user = getUserFromEvent(event);
  if (!user) {
    return createResponse(401, { error: 'Unauthorized' });
  }

  try {
    const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
      index,
      name: config.name,
      canRead: hasPermission(user, config.permissions.read),
      canWrite: hasPermission(user, config.permissions.write),
      canDelete: hasPermission(user, config.permissions.delete)
    }));

    return createResponse(200, { resources });
  } catch (error) {
    console.error('Error getting resources:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetTableData(event: APIGatewayProxyEvent, tableIndex: string): Promise<ApiResponse> {
  const user = getUserFromEvent(event);
  if (!user) {
    return createResponse(401, { error: 'Unauthorized' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!hasPermission(user, config.permissions.read)) {
    return createResponse(403, { error: 'Forbidden' });
  }

  try {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': config.pk
      }
    }));

    return createResponse(200, { items: result.Items || [] });
  } catch (error) {
    console.error('Error scanning table:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetTableItem(event: APIGatewayProxyEvent, tableIndex: string): Promise<ApiResponse> {
  const user = getUserFromEvent(event);
  if (!user) {
    return createResponse(401, { error: 'Unauthorized' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!hasPermission(user, config.permissions.read)) {
    return createResponse(403, { error: 'Forbidden' });
  }

  const itemId = event.pathParameters?.id;
  if (!itemId) {
    return createResponse(400, { error: 'Item ID is required' });
  }

  try {
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: itemId
      }
    }));

    if (!result.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    return createResponse(200, result.Item);
  } catch (error) {
    console.error('Error getting item:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleCreateTableItem(event: APIGatewayProxyEvent, tableIndex: string): Promise<ApiResponse> {
  const user = getUserFromEvent(event);
  if (!user) {
    return createResponse(401, { error: 'Unauthorized' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!hasPermission(user, config.permissions.write)) {
    return createResponse(403, { error: 'Forbidden' });
  }

  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }

  try {
    const data = JSON.parse(event.body);
    const now = new Date().toISOString();
    const itemId = randomUUID();
    
    const item = {
      ...data,
      pk: config.pk,
      sk: itemId,
      id: itemId,
      createdAt: now,
      updatedAt: now,
      createdBy: user.id,
      updatedBy: user.id
    };

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    }));

    await writeAuditLog('CREATE', user.id, { table: config.name, itemId, data });

    return createResponse(201, item);
  } catch (error) {
    console.error('Error creating item:', error);
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON in request body' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpdateTableItem(event: APIGatewayProxyEvent, tableIndex: string): Promise<ApiResponse> {
  const user = getUserFromEvent(event);
  if (!user) {
    return createResponse(401, { error: 'Unauthorized' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!hasPermission(user, config.permissions.write)) {
    return createResponse(403, { error: 'Forbidden' });
  }

  const itemId = event.pathParameters?.id;
  if (!itemId) {
    return createResponse(400, { error: 'Item ID is required' });
  }

  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }

  try {
    const data = JSON.parse(event.body);
    const now = new Date().toISOString();
    
    const updateExpressions: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, any> = {};
    
    Object.keys(data).forEach((key, index) => {
      if (key !== 'pk' && key !== 'sk' && key !== 'id' && key !== 'createdAt' && key !== 'createdBy') {
        const attrName = `#attr${index}`;
        const attrValue = `:val${index}`;
        updateExpressions.push(`${attrName} = ${attrValue}`);
        expressionAttributeNames[attrName] = key;
        expressionAttributeValues[attrValue] = data[key];
      }
    });
    
    updateExpressions.push('#updatedAt = :updatedAt');
    updateExpressions.push('#updatedBy = :updatedBy');
    expressionAttributeNames['#updatedAt'] = 'updatedAt';
    expressionAttributeNames['#updatedBy'] = 'updatedBy';
    expressionAttributeValues[':updatedAt'] = now;
    expressionAttributeValues[':updatedBy'] = user.id;

    const result = await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: itemId
      },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    }));

    await writeAuditLog('UPDATE', user.id, { table: config.name, itemId, data });

    return createResponse(200, result.Attributes);
  } catch (error) {
    console.error('Error updating item:', error);
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON in request body' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDeleteTableItem(event: APIGatewayProxyEvent, tableIndex: string): Promise<ApiResponse> {
  const user = getUserFromEvent(event);
  if (!user) {
    return createResponse(401, { error: 'Unauthorized' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!hasPermission(user, config.permissions.delete)) {
    return createResponse(403, { error: 'Forbidden' });
  }

  const itemId = event.pathParameters?.id;
  if (!itemId) {
    return createResponse(400, { error: 'Item ID is required' });
  }

  try {
    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: itemId
      }
    }));

    await writeAuditLog('DELETE', user.id, { table: config.name, itemId });

    return createResponse(204, {});
  } catch (error) {
    console.error('Error deleting item:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleBulkImport(event: APIGatewayProxyEvent, tableIndex: string): Promise<ApiResponse> {
  const user = getUserFromEvent(event);
  if (!user) {
    return createResponse(401, { error: 'Unauthorized' });
  }

  if (!hasPermission(user, PERMISSIONS.BULK_IMPORT)) {
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

    const now = new Date().toISOString();
    let imported = 0;
    let failed = 0;
    const errors: string[] = [];

    // Process items in batches of 25 (DynamoDB BatchWrite limit)
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      const writeRequests = batch.map(item => {
        const itemId = randomUUID();
        return {
          PutRequest: {
            Item: {
              ...item,
              pk: config.pk,
              sk: itemId,
              id: itemId,
              createdAt: now,
              updatedAt: now,
              createdBy: user.id,
              updatedBy: user.id
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
      } catch (error) {
        failed += batch.length;
        errors.push(`Batch ${Math.floor(i / 25) + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    await writeAuditLog('BULK_IMPORT', user.id, { table: config.name, imported, failed });

    return createResponse(200, { imported, failed, errors });
  } catch (error) {
    console.error('Error in bulk import:', error);
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON in request body' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  if (event.httpMethod === 'OPTIONS') {
    return createResponse(200, {});
  }

  const path = event.path;
  const method = event.httpMethod;

  try {
    // GET /resources
    if (method === 'GET' && path === '/resources') {
      return await handleGetResources(event);
    }

    // Table operations
    const tableMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(\w+))?$/);
    if (tableMatch) {
      const [, tableIndex, action, itemId] = tableMatch;
      
      if (action === 'bulk' && method === 'POST') {
        return await handleBulkImport(event, tableIndex);
      }
      
      if (!action) {
        // /api/{tableIndex}
        if (method === 'GET') {
          return await handleGetTableData(event, tableIndex);
        }
        if (method === 'POST') {
          return await handleCreateTableItem(event, tableIndex);
        }
      } else if (itemId) {
        // /api/{tableIndex}/{itemId}
        event.pathParameters = { ...event.pathParameters, id: action };
        if (method === 'GET') {
          return await handleGetTableItem(event, tableIndex);
        }
        if (method === 'PUT') {
          return await handleUpdateTableItem(event, tableIndex);
        }
        if (method === 'DELETE') {
          return await handleDeleteTableItem(event, tableIndex);
        }
      }
    }

    return createResponse(404, { error: 'Not found' });
  } catch (error) {
    console.error('Unhandled error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};