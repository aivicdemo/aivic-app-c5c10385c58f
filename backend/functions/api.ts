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

function getCurrentUser(event: APIGatewayProxyEvent): User {
  const role = event.headers['x-user-role'] || 'viewer';
  const userId = event.headers['x-user-id'] || 'anonymous';
  return { id: userId, role: role as 'admin' | 'operator' | 'viewer' };
}

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-user-role, x-user-id'
    },
    body: JSON.stringify(body)
  };
}

async function writeAuditLog(action: string, resource: string, userId: string, details?: any): Promise<void> {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    action,
    resource,
    userId,
    timestamp: new Date().toISOString(),
    details: details || {}
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

function addTimestamps(item: any, isUpdate: boolean = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

async function handleGetResources(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const user = getCurrentUser(event);
    checkPermission(user, 'resources', 'read');

    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'attribute_not_exists(pk) OR pk <> :audit',
      ExpressionAttributeValues: {
        ':audit': 'AUDIT'
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

async function handleGetTableItems(event: APIGatewayProxyEvent, tableIndex: string): Promise<APIGatewayProxyResult> {
  try {
    const user = getCurrentUser(event);
    const tableConfig = TABLES[tableIndex];
    
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }

    checkPermission(user, tableConfig.name, 'read');

    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'entityType = :entityType',
      ExpressionAttributeValues: {
        ':entityType': tableConfig.name
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

async function handleGetTableItem(event: APIGatewayProxyEvent, tableIndex: string): Promise<APIGatewayProxyResult> {
  try {
    const user = getCurrentUser(event);
    const tableConfig = TABLES[tableIndex];
    const itemId = event.pathParameters?.id;
    
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }
    
    if (!itemId) {
      return createResponse(400, { error: 'Item ID is required' });
    }

    checkPermission(user, tableConfig.name, 'read');

    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `${tableConfig.name}#${itemId}`,
        sk: `${tableConfig.name}#${itemId}`
      }
    }));

    if (!result.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    return createResponse(200, result.Item);
  } catch (error: any) {
    if (error.message.includes('Access denied')) {
      return createResponse(403, { error: error.message });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleCreateTableItem(event: APIGatewayProxyEvent, tableIndex: string): Promise<APIGatewayProxyResult> {
  try {
    const user = getCurrentUser(event);
    const tableConfig = TABLES[tableIndex];
    
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }

    checkPermission(user, tableConfig.name, 'create');

    const body = JSON.parse(event.body || '{}');
    const itemId = randomUUID();
    
    const item = {
      ...body,
      [tableConfig.pkField]: itemId,
      pk: `${tableConfig.name}#${itemId}`,
      sk: `${tableConfig.name}#${itemId}`,
      entityType: tableConfig.name,
      createdBy: user.id,
      updatedBy: user.id
    };
    
    addTimestamps(item);

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    }));

    await writeAuditLog('CREATE', tableConfig.name, user.id, { itemId });

    return createResponse(201, item);
  } catch (error: any) {
    if (error.message.includes('Access denied')) {
      return createResponse(403, { error: error.message });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpdateTableItem(event: APIGatewayProxyEvent, tableIndex: string): Promise<APIGatewayProxyResult> {
  try {
    const user = getCurrentUser(event);
    const tableConfig = TABLES[tableIndex];
    const itemId = event.pathParameters?.id;
    
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }
    
    if (!itemId) {
      return createResponse(400, { error: 'Item ID is required' });
    }

    checkPermission(user, tableConfig.name, 'update');

    const body = JSON.parse(event.body || '{}');
    
    const updateExpression = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, any> = {};
    
    for (const [key, value] of Object.entries(body)) {
      if (key !== tableConfig.pkField && key !== 'pk' && key !== 'sk') {
        updateExpression.push(`#${key} = :${key}`);
        expressionAttributeNames[`#${key}`] = key;
        expressionAttributeValues[`:${key}`] = value;
      }
    }
    
    updateExpression.push('#updatedAt = :updatedAt');
    updateExpression.push('#updatedBy = :updatedBy');
    expressionAttributeNames['#updatedAt'] = 'updatedAt';
    expressionAttributeNames['#updatedBy'] = 'updatedBy';
    expressionAttributeValues[':updatedAt'] = new Date().toISOString();
    expressionAttributeValues[':updatedBy'] = user.id;

    const result = await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `${tableConfig.name}#${itemId}`,
        sk: `${tableConfig.name}#${itemId}`
      },
      UpdateExpression: `SET ${updateExpression.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    }));

    await writeAuditLog('UPDATE', tableConfig.name, user.id, { itemId });

    return createResponse(200, result.Attributes);
  } catch (error: any) {
    if (error.message.includes('Access denied')) {
      return createResponse(403, { error: error.message });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDeleteTableItem(event: APIGatewayProxyEvent, tableIndex: string): Promise<APIGatewayProxyResult> {
  try {
    const user = getCurrentUser(event);
    const tableConfig = TABLES[tableIndex];
    const itemId = event.pathParameters?.id;
    
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }
    
    if (!itemId) {
      return createResponse(400, { error: 'Item ID is required' });
    }

    checkPermission(user, tableConfig.name, 'delete');

    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `${tableConfig.name}#${itemId}`,
        sk: `${tableConfig.name}#${itemId}`
      }
    }));

    await writeAuditLog('DELETE', tableConfig.name, user.id, { itemId });

    return createResponse(200, { message: 'Item deleted successfully' });
  } catch (error: any) {
    if (error.message.includes('Access denied')) {
      return createResponse(403, { error: error.message });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleBulkImport(event: APIGatewayProxyEvent, tableIndex: string): Promise<APIGatewayProxyResult> {
  try {
    const user = getCurrentUser(event);
    const tableConfig = TABLES[tableIndex];
    
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }

    checkPermission(user, tableConfig.name, 'bulk');

    const body = JSON.parse(event.body || '{}');
    const items = body.items || [];
    
    if (!Array.isArray(items)) {
      return createResponse(400, { error: 'items must be an array' });
    }

    let imported = 0;
    let failed = 0;
    const errors: string[] = [];

    // Process items in batches of 25 (DynamoDB BatchWrite limit)
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      const writeRequests = [];
      
      for (const item of batch) {
        try {
          const itemId = randomUUID();
          const processedItem = {
            ...item,
            [tableConfig.pkField]: itemId,
            pk: `${tableConfig.name}#${itemId}`,
            sk: `${tableConfig.name}#${itemId}`,
            entityType: tableConfig.name,
            createdBy: user.id,
            updatedBy: user.id
          };
          
          addTimestamps(processedItem);
          
          writeRequests.push({
            PutRequest: {
              Item: processedItem
            }
          });
        } catch (error: any) {
          failed++;
          errors.push(`Item ${i}: ${error.message}`);
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
        } catch (error: any) {
          failed += writeRequests.length;
          errors.push(`Batch ${Math.floor(i/25)}: ${error.message}`);
        }
      }
    }

    await writeAuditLog('BULK_IMPORT', tableConfig.name, user.id, { imported, failed });

    return createResponse(200, { imported, failed, errors });
  } catch (error: any) {
    if (error.message.includes('Access denied')) {
      return createResponse(403, { error: error.message });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const method = event.httpMethod;
    const path = event.path;
    
    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }
    
    // GET /resources
    if (method === 'GET' && path === '/resources') {
      return await handleGetResources(event);
    }
    
    // Table-specific routes
    const tableMatch = path.match(/^\/api\/(\d+)(?:\/([^/]+))?(?:\/([^/]+))?$/);
    if (tableMatch) {
      const tableIndex = tableMatch[1];
      const action = tableMatch[2];
      const itemId = tableMatch[3];
      
      // POST /api/{tableIndex}/bulk
      if (method === 'POST' && action === 'bulk') {
        return await handleBulkImport(event, tableIndex);
      }
      
      // GET /api/{tableIndex}
      if (method === 'GET' && !action) {
        return await handleGetTableItems(event, tableIndex);
      }
      
      // GET /api/{tableIndex}/{id}
      if (method === 'GET' && action && !itemId) {
        event.pathParameters = { id: action };
        return await handleGetTableItem(event, tableIndex);
      }
      
      // POST /api/{tableIndex}
      if (method === 'POST' && !action) {
        return await handleCreateTableItem(event, tableIndex);
      }
      
      // PUT /api/{tableIndex}/{id}
      if (method === 'PUT' && action && !itemId) {
        event.pathParameters = { id: action };
        return await handleUpdateTableItem(event, tableIndex);
      }
      
      // DELETE /api/{tableIndex}/{id}
      if (method === 'DELETE' && action && !itemId) {
        event.pathParameters = { id: action };
        return await handleDeleteTableItem(event, tableIndex);
      }
    }
    
    return createResponse(404, { error: 'Endpoint not found' });
  } catch (error: any) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};