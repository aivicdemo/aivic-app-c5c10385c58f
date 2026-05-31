import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { getUserFromEvent, checkPermission } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

const TABLE_CONFIGS = {
  '0': { name: 'LoginUser', pk: 'userId' },
  '1': { name: 'Product', pk: 'productId' },
  '2': { name: 'Supplier', pk: 'supplierId' },
  '3': { name: 'Inventory', pk: 'inventoryId' },
  '4': { name: 'PurchaseRecord', pk: 'purchaseRecordId' },
  '5': { name: 'SalesRecord', pk: 'salesRecordId' },
  '6': { name: 'MonthlySummary', pk: 'summaryId' },
  '7': { name: 'OrderRecommendation', pk: 'recommendationId' },
  '8': { name: 'ProductProposal', pk: 'proposalId' },
  '9': { name: 'Customer', pk: 'customerId' },
  '10': { name: 'Pet', pk: 'petId' },
  '11': { name: 'CustomerUsageHistory', pk: 'usageHistoryId' },
  '12': { name: 'DemandForecast', pk: 'forecastId' },
  '13': { name: 'OrderHistory', pk: 'orderHistoryId' },
  '14': { name: 'InventoryAdjustmentHistory', pk: 'adjustmentHistoryId' }
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
  headers?: { [key: string]: string };
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

async function createAuditLog(action: string, details: any, userId: string): Promise<void> {
  const auditItem = {
    pk: 'AUDIT',
    sk: `${Date.now()}-${randomUUID()}`,
    action,
    details,
    userId,
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditItem
  }));
}

async function handleGetResources(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  try {
    const user = getUserFromEvent(event);
    checkPermission(user, 'read:all');
    
    const command = new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'pk <> :auditPk',
      ExpressionAttributeValues: {
        ':auditPk': 'AUDIT'
      }
    });
    
    const result = await docClient.send(command);
    
    return createResponse(200, {
      items: result.Items || [],
      count: result.Count || 0
    });
  } catch (error: any) {
    if (error.message.includes('Insufficient permissions')) {
      return createResponse(403, { error: 'Forbidden' });
    }
    if (error.message.includes('authorization')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleTableOperations(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  try {
    const user = getUserFromEvent(event);
    const pathParts = event.path.split('/');
    const tableIndex = pathParts[2];
    const operation = pathParts[3];
    
    if (!TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS]) {
      return createResponse(404, { error: 'Table not found' });
    }
    
    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    if (operation === 'bulk' && event.httpMethod === 'POST') {
      return await handleBulkImport(event, user, tableConfig);
    }
    
    switch (event.httpMethod) {
      case 'GET':
        return await handleTableGet(event, user, tableConfig);
      case 'POST':
        return await handleTablePost(event, user, tableConfig);
      case 'PUT':
        return await handleTablePut(event, user, tableConfig);
      case 'DELETE':
        return await handleTableDelete(event, user, tableConfig);
      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error: any) {
    if (error.message.includes('Insufficient permissions')) {
      return createResponse(403, { error: 'Forbidden' });
    }
    if (error.message.includes('authorization')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleTableGet(event: APIGatewayEvent, user: any, tableConfig: any): Promise<APIGatewayResponse> {
  checkPermission(user, 'read:all');
  
  const id = event.pathParameters?.id;
  
  if (id) {
    const command = new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: tableConfig.name,
        sk: id
      }
    });
    
    const result = await docClient.send(command);
    
    if (!result.Item) {
      return createResponse(404, { error: 'Item not found' });
    }
    
    return createResponse(200, result.Item);
  } else {
    const command = new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': tableConfig.name
      }
    });
    
    const result = await docClient.send(command);
    
    return createResponse(200, {
      items: result.Items || [],
      count: result.Count || 0
    });
  }
}

async function handleTablePost(event: APIGatewayEvent, user: any, tableConfig: any): Promise<APIGatewayResponse> {
  checkPermission(user, 'write:all');
  
  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }
  
  const data = JSON.parse(event.body);
  const id = randomUUID();
  const now = new Date().toISOString();
  
  const item = {
    pk: tableConfig.name,
    sk: id,
    [tableConfig.pk]: id,
    ...data,
    createdAt: now,
    updatedAt: now,
    createdBy: user.id,
    updatedBy: user.id
  };
  
  const command = new PutCommand({
    TableName: TABLE_NAME,
    Item: item
  });
  
  await docClient.send(command);
  
  await createAuditLog('CREATE', {
    table: tableConfig.name,
    itemId: id,
    data: item
  }, user.id);
  
  return createResponse(201, item);
}

async function handleTablePut(event: APIGatewayEvent, user: any, tableConfig: any): Promise<APIGatewayResponse> {
  checkPermission(user, 'write:all');
  
  const id = event.pathParameters?.id;
  if (!id) {
    return createResponse(400, { error: 'ID is required' });
  }
  
  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }
  
  const data = JSON.parse(event.body);
  const now = new Date().toISOString();
  
  const updateExpression = [];
  const expressionAttributeNames: any = {};
  const expressionAttributeValues: any = {};
  
  for (const [key, value] of Object.entries(data)) {
    if (key !== 'pk' && key !== 'sk' && key !== tableConfig.pk) {
      updateExpression.push(`#${key} = :${key}`);
      expressionAttributeNames[`#${key}`] = key;
      expressionAttributeValues[`:${key}`] = value;
    }
  }
  
  updateExpression.push('#updatedAt = :updatedAt');
  updateExpression.push('#updatedBy = :updatedBy');
  expressionAttributeNames['#updatedAt'] = 'updatedAt';
  expressionAttributeNames['#updatedBy'] = 'updatedBy';
  expressionAttributeValues[':updatedAt'] = now;
  expressionAttributeValues[':updatedBy'] = user.id;
  
  const command = new UpdateCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: tableConfig.name,
      sk: id
    },
    UpdateExpression: `SET ${updateExpression.join(', ')}`,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: expressionAttributeValues,
    ReturnValues: 'ALL_NEW'
  });
  
  const result = await docClient.send(command);
  
  await createAuditLog('UPDATE', {
    table: tableConfig.name,
    itemId: id,
    data: result.Attributes
  }, user.id);
  
  return createResponse(200, result.Attributes);
}

async function handleTableDelete(event: APIGatewayEvent, user: any, tableConfig: any): Promise<APIGatewayResponse> {
  checkPermission(user, 'delete:all');
  
  const id = event.pathParameters?.id;
  if (!id) {
    return createResponse(400, { error: 'ID is required' });
  }
  
  const command = new DeleteCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: tableConfig.name,
      sk: id
    },
    ReturnValues: 'ALL_OLD'
  });
  
  const result = await docClient.send(command);
  
  if (!result.Attributes) {
    return createResponse(404, { error: 'Item not found' });
  }
  
  await createAuditLog('DELETE', {
    table: tableConfig.name,
    itemId: id,
    data: result.Attributes
  }, user.id);
  
  return createResponse(200, { message: 'Item deleted successfully' });
}

async function handleBulkImport(event: APIGatewayEvent, user: any, tableConfig: any): Promise<APIGatewayResponse> {
  checkPermission(user, 'bulk:import');
  
  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }
  
  const { items } = JSON.parse(event.body);
  
  if (!Array.isArray(items)) {
    return createResponse(400, { error: 'Items must be an array' });
  }
  
  let imported = 0;
  let failed = 0;
  const errors: string[] = [];
  const now = new Date().toISOString();
  
  // Process in batches of 25 (DynamoDB BatchWrite limit)
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25);
    const writeRequests = batch.map(item => {
      const id = randomUUID();
      return {
        PutRequest: {
          Item: {
            pk: tableConfig.name,
            sk: id,
            [tableConfig.pk]: id,
            ...item,
            createdAt: now,
            updatedAt: now,
            createdBy: user.id,
            updatedBy: user.id
          }
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
    } catch (error: any) {
      failed += batch.length;
      errors.push(`Batch ${Math.floor(i / 25) + 1}: ${error.message}`);
    }
  }
  
  await createAuditLog('BULK_IMPORT', {
    table: tableConfig.name,
    imported,
    failed,
    total: items.length
  }, user.id);
  
  return createResponse(200, {
    imported,
    failed,
    errors
  });
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  if (event.httpMethod === 'OPTIONS') {
    return createResponse(200, {});
  }
  
  try {
    if (event.path === '/resources') {
      return await handleGetResources(event);
    }
    
    if (event.path.startsWith('/api/')) {
      return await handleTableOperations(event);
    }
    
    return createResponse(404, { error: 'Not found' });
  } catch (error: any) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};