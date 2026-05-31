import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { User, checkPermission } from './rbac';
import * as crypto from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

const TABLE_CONFIGS = {
  '0': { name: 'LoginUser', pk: 'userId' },
  '1': { name: 'ProductMaster', pk: 'productId' },
  '2': { name: 'SupplierMaster', pk: 'supplierId' },
  '3': { name: 'InventoryManagement', pk: 'inventoryId' },
  '4': { name: 'PurchaseRecord', pk: 'purchaseRecordId' },
  '5': { name: 'SalesRecord', pk: 'salesRecordId' },
  '6': { name: 'MonthlySummary', pk: 'summaryId' },
  '7': { name: 'OrderRecommendation', pk: 'recommendationId' },
  '8': { name: 'ProductProposal', pk: 'proposalId' },
  '9': { name: 'CustomerMaster', pk: 'customerId' },
  '10': { name: 'PetInfo', pk: 'petId' },
  '11': { name: 'CustomerUsageHistory', pk: 'usageHistoryId' },
  '12': { name: 'DemandForecast', pk: 'forecastId' },
  '13': { name: 'OrderHistory', pk: 'orderHistoryId' },
  '14': { name: 'InventoryAdjustmentHistory', pk: 'adjustmentHistoryId' }
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

async function createAuditLog(action: string, resource: string, userId: string, details?: any): Promise<void> {
  const auditItem = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${crypto.randomUUID()}`,
    action,
    resource,
    userId,
    timestamp: new Date().toISOString(),
    details: details || {}
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

function validateTableIndex(tableIndex: string): boolean {
  return tableIndex in TABLE_CONFIGS;
}

function getTableConfig(tableIndex: string) {
  if (!validateTableIndex(tableIndex)) {
    throw new Error('Invalid table index');
  }
  return TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
}

async function handleGetResources(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const user = getCurrentUser(event);
    checkPermission(user, 'resources', 'read');

    const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
      index,
      name: config.name,
      pk: config.pk
    }));

    return createResponse(200, { resources });
  } catch (error) {
    if (error instanceof Error && error.message === 'Insufficient permissions') {
      return createResponse(403, { error: 'Forbidden' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetTableItems(event: APIGatewayProxyEvent, tableIndex: string): Promise<APIGatewayProxyResult> {
  try {
    const user = getCurrentUser(event);
    const tableConfig = getTableConfig(tableIndex);
    checkPermission(user, tableConfig.name, 'read');

    const command = new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'attribute_exists(#pk)',
      ExpressionAttributeNames: {
        '#pk': tableConfig.pk
      }
    });

    const result = await docClient.send(command);
    return createResponse(200, { items: result.Items || [] });
  } catch (error) {
    if (error instanceof Error && error.message === 'Insufficient permissions') {
      return createResponse(403, { error: 'Forbidden' });
    }
    if (error instanceof Error && error.message === 'Invalid table index') {
      return createResponse(404, { error: 'Table not found' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetTableItem(event: APIGatewayProxyEvent, tableIndex: string, itemId: string): Promise<APIGatewayProxyResult> {
  try {
    const user = getCurrentUser(event);
    const tableConfig = getTableConfig(tableIndex);
    checkPermission(user, tableConfig.name, 'read');

    const command = new GetCommand({
      TableName: TABLE_NAME,
      Key: { [tableConfig.pk]: itemId }
    });

    const result = await docClient.send(command);
    if (!result.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    return createResponse(200, { item: result.Item });
  } catch (error) {
    if (error instanceof Error && error.message === 'Insufficient permissions') {
      return createResponse(403, { error: 'Forbidden' });
    }
    if (error instanceof Error && error.message === 'Invalid table index') {
      return createResponse(404, { error: 'Table not found' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleCreateTableItem(event: APIGatewayProxyEvent, tableIndex: string): Promise<APIGatewayProxyResult> {
  try {
    const user = getCurrentUser(event);
    const tableConfig = getTableConfig(tableIndex);
    checkPermission(user, tableConfig.name, 'create');

    if (!event.body) {
      return createResponse(400, { error: 'Request body is required' });
    }

    const item = JSON.parse(event.body);
    item[tableConfig.pk] = item[tableConfig.pk] || crypto.randomUUID();
    addTimestamps(item);

    const command = new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    });

    await docClient.send(command);
    await createAuditLog('CREATE', tableConfig.name, user.id, { itemId: item[tableConfig.pk] });

    return createResponse(201, { item });
  } catch (error) {
    if (error instanceof Error && error.message === 'Insufficient permissions') {
      return createResponse(403, { error: 'Forbidden' });
    }
    if (error instanceof Error && error.message === 'Invalid table index') {
      return createResponse(404, { error: 'Table not found' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpdateTableItem(event: APIGatewayProxyEvent, tableIndex: string, itemId: string): Promise<APIGatewayProxyResult> {
  try {
    const user = getCurrentUser(event);
    const tableConfig = getTableConfig(tableIndex);
    checkPermission(user, tableConfig.name, 'update');

    if (!event.body) {
      return createResponse(400, { error: 'Request body is required' });
    }

    const updates = JSON.parse(event.body);
    addTimestamps(updates, true);

    const updateExpressions: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, any> = {};

    Object.keys(updates).forEach((key, index) => {
      if (key !== tableConfig.pk) {
        const attrName = `#attr${index}`;
        const attrValue = `:val${index}`;
        updateExpressions.push(`${attrName} = ${attrValue}`);
        expressionAttributeNames[attrName] = key;
        expressionAttributeValues[attrValue] = updates[key];
      }
    });

    if (updateExpressions.length === 0) {
      return createResponse(400, { error: 'No valid fields to update' });
    }

    const command = new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { [tableConfig.pk]: itemId },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    });

    const result = await docClient.send(command);
    await createAuditLog('UPDATE', tableConfig.name, user.id, { itemId });

    return createResponse(200, { item: result.Attributes });
  } catch (error) {
    if (error instanceof Error && error.message === 'Insufficient permissions') {
      return createResponse(403, { error: 'Forbidden' });
    }
    if (error instanceof Error && error.message === 'Invalid table index') {
      return createResponse(404, { error: 'Table not found' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDeleteTableItem(event: APIGatewayProxyEvent, tableIndex: string, itemId: string): Promise<APIGatewayProxyResult> {
  try {
    const user = getCurrentUser(event);
    const tableConfig = getTableConfig(tableIndex);
    checkPermission(user, tableConfig.name, 'delete');

    const command = new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { [tableConfig.pk]: itemId },
      ReturnValues: 'ALL_OLD'
    });

    const result = await docClient.send(command);
    if (!result.Attributes) {
      return createResponse(404, { error: 'Item not found' });
    }

    await createAuditLog('DELETE', tableConfig.name, user.id, { itemId });
    return createResponse(200, { message: 'Item deleted successfully' });
  } catch (error) {
    if (error instanceof Error && error.message === 'Insufficient permissions') {
      return createResponse(403, { error: 'Forbidden' });
    }
    if (error instanceof Error && error.message === 'Invalid table index') {
      return createResponse(404, { error: 'Table not found' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleBulkImport(event: APIGatewayProxyEvent, tableIndex: string): Promise<APIGatewayProxyResult> {
  try {
    const user = getCurrentUser(event);
    const tableConfig = getTableConfig(tableIndex);
    checkPermission(user, tableConfig.name, 'bulk');

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

    // Process items in batches of 25 (DynamoDB BatchWrite limit)
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      const writeRequests = batch.map(item => {
        try {
          item[tableConfig.pk] = item[tableConfig.pk] || crypto.randomUUID();
          addTimestamps(item);
          return {
            PutRequest: {
              Item: item
            }
          };
        } catch (error) {
          failed++;
          errors.push(`Item ${i + batch.indexOf(item)}: ${error instanceof Error ? error.message : 'Unknown error'}`);
          return null;
        }
      }).filter(req => req !== null);

      if (writeRequests.length > 0) {
        try {
          const command = new BatchWriteCommand({
            RequestItems: {
              [TABLE_NAME]: writeRequests
            }
          });

          await docClient.send(command);
          imported += writeRequests.length;
        } catch (error) {
          failed += writeRequests.length;
          errors.push(`Batch ${Math.floor(i / 25)}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    }

    await createAuditLog('BULK_IMPORT', tableConfig.name, user.id, { imported, failed, totalItems: items.length });

    return createResponse(200, { imported, failed, errors });
  } catch (error) {
    if (error instanceof Error && error.message === 'Insufficient permissions') {
      return createResponse(403, { error: 'Forbidden' });
    }
    if (error instanceof Error && error.message === 'Invalid table index') {
      return createResponse(404, { error: 'Table not found' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const { httpMethod, path, pathParameters } = event;

    if (httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    // GET /resources
    if (httpMethod === 'GET' && path === '/resources') {
      return await handleGetResources(event);
    }

    // Extract table index and item ID from path
    const pathMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/bulk)?$/);
    if (!pathMatch) {
      return createResponse(404, { error: 'Not found' });
    }

    const tableIndex = pathMatch[1];
    const itemId = pathMatch[2];

    // Handle bulk import: POST /api/{tableIndex}/bulk
    if (httpMethod === 'POST' && path.endsWith('/bulk')) {
      return await handleBulkImport(event, tableIndex);
    }

    // Handle CRUD operations
    switch (httpMethod) {
      case 'GET':
        if (itemId) {
          return await handleGetTableItem(event, tableIndex, itemId);
        } else {
          return await handleGetTableItems(event, tableIndex);
        }
      case 'POST':
        return await handleCreateTableItem(event, tableIndex);
      case 'PUT':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID is required for update' });
        }
        return await handleUpdateTableItem(event, tableIndex, itemId);
      case 'DELETE':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID is required for delete' });
        }
        return await handleDeleteTableItem(event, tableIndex, itemId);
      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};