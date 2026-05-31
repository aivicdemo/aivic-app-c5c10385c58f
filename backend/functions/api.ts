import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { User, checkPermission } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface TableConfig {
  name: string;
  pkField: string;
  gsiFields?: string[];
}

const TABLES: Record<string, TableConfig> = {
  '0': { name: 'LoginUser', pkField: 'userId' },
  '1': { name: 'ProductMaster', pkField: 'productId' },
  '2': { name: 'SupplierMaster', pkField: 'supplierId' },
  '3': { name: 'InventoryManagement', pkField: 'inventoryId' },
  '4': { name: 'PurchaseRecord', pkField: 'purchaseRecordId' },
  '5': { name: 'SalesRecord', pkField: 'salesRecordId' },
  '6': { name: 'MonthlySummary', pkField: 'summaryId' },
  '7': { name: 'OrderRecommendation', pkField: 'orderRecommendationId' },
  '8': { name: 'ProductProposal', pkField: 'proposalId' },
  '9': { name: 'CustomerMaster', pkField: 'customerId' },
  '10': { name: 'PetInfo', pkField: 'petId' },
  '11': { name: 'CustomerUsageHistory', pkField: 'usageHistoryId' },
  '12': { name: 'DemandForecast', pkField: 'demandForecastId' },
  '13': { name: 'OrderHistory', pkField: 'orderHistoryId' },
  '14': { name: 'InventoryAdjustmentHistory', pkField: 'adjustmentHistoryId' }
};

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
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

function getCurrentUser(event: APIGatewayProxyEvent): User {
  const authHeader = event.headers.Authorization || event.headers.authorization;
  if (!authHeader) {
    throw new Error('Authorization header required');
  }
  
  try {
    const token = authHeader.replace('Bearer ', '');
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return {
      id: payload.sub || 'anonymous',
      role: payload.role || 'viewer'
    };
  } catch {
    return { id: 'anonymous', role: 'viewer' };
  }
}

async function createAuditLog(user: User, action: string, resource: string, details: any): Promise<void> {
  const auditItem = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.id,
    action,
    resource,
    details: JSON.stringify(details),
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditItem
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

function generateId(): string {
  return randomUUID();
}

async function handleGetResources(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const user = getCurrentUser(event);
    checkPermission(user, 'resources', 'read');

    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'attribute_exists(pk) AND pk <> :auditPk',
      ExpressionAttributeValues: {
        ':auditPk': 'AUDIT'
      }
    }));

    return createResponse(200, {
      items: result.Items || [],
      count: result.Count || 0
    });
  } catch (error: any) {
    if (error.message.includes('Access denied')) {
      return createResponse(403, { error: error.message });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleTableOperation(event: APIGatewayProxyEvent, tableIndex: string): Promise<APIGatewayProxyResult> {
  try {
    const user = getCurrentUser(event);
    const tableConfig = TABLES[tableIndex];
    
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }

    const method = event.httpMethod;
    const pathParts = event.path.split('/');
    const isBulkOperation = pathParts[pathParts.length - 1] === 'bulk';
    
    if (isBulkOperation && method === 'POST') {
      return await handleBulkImport(event, tableConfig, user);
    }

    switch (method) {
      case 'GET':
        return await handleGet(event, tableConfig, user);
      case 'POST':
        return await handleCreate(event, tableConfig, user);
      case 'PUT':
        return await handleUpdate(event, tableConfig, user);
      case 'DELETE':
        return await handleDelete(event, tableConfig, user);
      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error: any) {
    if (error.message.includes('Access denied')) {
      return createResponse(403, { error: error.message });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGet(event: APIGatewayProxyEvent, tableConfig: TableConfig, user: User): Promise<APIGatewayProxyResult> {
  checkPermission(user, tableConfig.name, 'read');
  
  const id = event.pathParameters?.id;
  
  if (id) {
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: tableConfig.name,
        sk: id
      }
    }));
    
    if (!result.Item) {
      return createResponse(404, { error: 'Item not found' });
    }
    
    return createResponse(200, result.Item);
  } else {
    const result = await docClient.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': tableConfig.name
      }
    }));
    
    return createResponse(200, {
      items: result.Items || [],
      count: result.Count || 0
    });
  }
}

async function handleCreate(event: APIGatewayProxyEvent, tableConfig: TableConfig, user: User): Promise<APIGatewayProxyResult> {
  checkPermission(user, tableConfig.name, 'create');
  
  if (!event.body) {
    return createResponse(400, { error: 'Request body required' });
  }
  
  const item = JSON.parse(event.body);
  const id = generateId();
  
  const dbItem = {
    pk: tableConfig.name,
    sk: id,
    [tableConfig.pkField]: id,
    ...addTimestamps(item),
    createdBy: user.id,
    updatedBy: user.id
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: dbItem
  }));
  
  await createAuditLog(user, 'CREATE', tableConfig.name, { id, item });
  
  return createResponse(201, dbItem);
}

async function handleUpdate(event: APIGatewayProxyEvent, tableConfig: TableConfig, user: User): Promise<APIGatewayProxyResult> {
  checkPermission(user, tableConfig.name, 'update');
  
  const id = event.pathParameters?.id;
  if (!id) {
    return createResponse(400, { error: 'ID parameter required' });
  }
  
  if (!event.body) {
    return createResponse(400, { error: 'Request body required' });
  }
  
  const updates = JSON.parse(event.body);
  addTimestamps(updates, true);
  updates.updatedBy = user.id;
  
  const updateExpressions: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, any> = {};
  
  Object.keys(updates).forEach((key, index) => {
    const attrName = `#attr${index}`;
    const attrValue = `:val${index}`;
    updateExpressions.push(`${attrName} = ${attrValue}`);
    expressionAttributeNames[attrName] = key;
    expressionAttributeValues[attrValue] = updates[key];
  });
  
  await docClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: tableConfig.name,
      sk: id
    },
    UpdateExpression: `SET ${updateExpressions.join(', ')}`,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
    ReturnValues: 'ALL_NEW'
  }));
  
  await createAuditLog(user, 'UPDATE', tableConfig.name, { id, updates });
  
  return createResponse(200, { message: 'Item updated successfully' });
}

async function handleDelete(event: APIGatewayProxyEvent, tableConfig: TableConfig, user: User): Promise<APIGatewayProxyResult> {
  checkPermission(user, tableConfig.name, 'delete');
  
  const id = event.pathParameters?.id;
  if (!id) {
    return createResponse(400, { error: 'ID parameter required' });
  }
  
  await docClient.send(new DeleteCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: tableConfig.name,
      sk: id
    }
  }));
  
  await createAuditLog(user, 'DELETE', tableConfig.name, { id });
  
  return createResponse(200, { message: 'Item deleted successfully' });
}

async function handleBulkImport(event: APIGatewayProxyEvent, tableConfig: TableConfig, user: User): Promise<APIGatewayProxyResult> {
  checkPermission(user, tableConfig.name, 'bulk');
  
  if (!event.body) {
    return createResponse(400, { error: 'Request body required' });
  }
  
  const { items } = JSON.parse(event.body);
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
      const id = generateId();
      return {
        PutRequest: {
          Item: {
            pk: tableConfig.name,
            sk: id,
            [tableConfig.pkField]: id,
            ...addTimestamps(item),
            createdBy: user.id,
            updatedBy: user.id
          }
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
    } catch (error: any) {
      failed += batch.length;
      errors.push(`Batch ${Math.floor(i / 25) + 1}: ${error.message}`);
    }
  }
  
  await createAuditLog(user, 'BULK_IMPORT', tableConfig.name, { imported, failed, totalItems: items.length });
  
  return createResponse(200, { imported, failed, errors });
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const path = event.path;
    
    if (path === '/resources') {
      return await handleGetResources(event);
    }
    
    const pathMatch = path.match(/^\/api\/(\d+)(?:\/(.+))?$/);
    if (pathMatch) {
      const tableIndex = pathMatch[1];
      return await handleTableOperation(event, tableIndex);
    }
    
    return createResponse(404, { error: 'Endpoint not found' });
  } catch (error: any) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};