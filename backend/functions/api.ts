import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const tableName = process.env.MAIN_TABLE!;

interface APIGatewayEvent {
  httpMethod: string;
  path: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  body?: string;
  headers?: { [key: string]: string };
}

interface APIResponse {
  statusCode: number;
  headers: { [key: string]: string };
  body: string;
}

const tableConfigs = {
  '0': { name: 'LoginUser', pk: 'USER' },
  '1': { name: 'ProductMaster', pk: 'PRODUCT' },
  '2': { name: 'SupplierMaster', pk: 'SUPPLIER' },
  '3': { name: 'InventoryManagement', pk: 'INVENTORY' },
  '4': { name: 'PurchaseRecord', pk: 'PURCHASE' },
  '5': { name: 'SalesRecord', pk: 'SALES' },
  '6': { name: 'MonthlySummary', pk: 'MONTHLY' },
  '7': { name: 'OrderRecommendation', pk: 'ORDER_REC' },
  '8': { name: 'ProductProposal', pk: 'PROPOSAL' },
  '9': { name: 'CustomerMaster', pk: 'CUSTOMER' },
  '10': { name: 'PetInfo', pk: 'PET' },
  '11': { name: 'CustomerUsageHistory', pk: 'USAGE' },
  '12': { name: 'DemandForecast', pk: 'FORECAST' },
  '13': { name: 'OrderHistory', pk: 'ORDER_HIST' },
  '14': { name: 'InventoryAdjustmentHistory', pk: 'INV_ADJ' }
};

async function writeAuditLog(user: User, action: string, resource: string, details: any = {}) {
  const auditRecord = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.id,
    action,
    resource,
    details: JSON.stringify(details),
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: tableName,
    Item: auditRecord
  }));
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

function validateRequired(data: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (!data[field]) {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

async function handleGetResources(event: APIGatewayEvent, user: User): Promise<APIResponse> {
  if (!hasPermission(user, 'resources', 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const resources = Object.entries(tableConfigs).map(([index, config]) => ({
      index,
      name: config.name,
      pk: config.pk
    }));

    return createResponse(200, { resources });
  } catch (error) {
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleTableOperations(event: APIGatewayEvent, user: User, tableIndex: string): Promise<APIResponse> {
  const config = tableConfigs[tableIndex as keyof typeof tableConfigs];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  const method = event.httpMethod;
  const pathParts = event.path.split('/');
  const isBulkOperation = pathParts[pathParts.length - 1] === 'bulk';
  const itemId = event.pathParameters?.id;

  try {
    switch (method) {
      case 'GET':
        if (!hasPermission(user, config.name, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (itemId) {
          const result = await docClient.send(new GetCommand({
            TableName: tableName,
            Key: { pk: config.pk, sk: itemId }
          }));
          
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, result.Item);
        } else {
          const result = await docClient.send(new ScanCommand({
            TableName: tableName,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: { ':pk': config.pk }
          }));
          
          return createResponse(200, { items: result.Items || [] });
        }

      case 'POST':
        if (isBulkOperation) {
          if (!hasPermission(user, config.name, 'bulk')) {
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

          for (let i = 0; i < items.length; i += 25) {
            const batch = items.slice(i, i + 25);
            const writeRequests = batch.map(item => {
              const now = new Date().toISOString();
              const processedItem = {
                ...item,
                pk: config.pk,
                sk: item.id || randomUUID(),
                createdAt: now,
                updatedAt: now,
                createdBy: user.id,
                updatedBy: user.id
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
                  [tableName]: writeRequests
                }
              }));
              imported += batch.length;
            } catch (error) {
              failed += batch.length;
              errors.push(`Batch ${Math.floor(i/25) + 1}: ${error}`);
            }
          }

          await writeAuditLog(user, 'BULK_IMPORT', config.name, { imported, failed });
          
          return createResponse(200, { imported, failed, errors });
        } else {
          if (!hasPermission(user, config.name, 'create')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          const body = JSON.parse(event.body || '{}');
          const now = new Date().toISOString();
          const id = randomUUID();
          
          const item = {
            ...body,
            pk: config.pk,
            sk: id,
            createdAt: now,
            updatedAt: now,
            createdBy: user.id,
            updatedBy: user.id
          };

          await docClient.send(new PutCommand({
            TableName: tableName,
            Item: item
          }));

          await writeAuditLog(user, 'CREATE', config.name, { id });
          
          return createResponse(201, item);
        }

      case 'PUT':
        if (!hasPermission(user, config.name, 'update')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (!itemId) {
          return createResponse(400, { error: 'Item ID required for update' });
        }

        const updateBody = JSON.parse(event.body || '{}');
        const now = new Date().toISOString();
        
        const updateItem = {
          ...updateBody,
          pk: config.pk,
          sk: itemId,
          updatedAt: now,
          updatedBy: user.id
        };

        await docClient.send(new PutCommand({
          TableName: tableName,
          Item: updateItem
        }));

        await writeAuditLog(user, 'UPDATE', config.name, { id: itemId });
        
        return createResponse(200, updateItem);

      case 'DELETE':
        if (!hasPermission(user, config.name, 'delete')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (!itemId) {
          return createResponse(400, { error: 'Item ID required for delete' });
        }

        await docClient.send(new DeleteCommand({
          TableName: tableName,
          Key: { pk: config.pk, sk: itemId }
        }));

        await writeAuditLog(user, 'DELETE', config.name, { id: itemId });
        
        return createResponse(200, { message: 'Item deleted successfully' });

      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

export async function handler(event: APIGatewayEvent): Promise<APIResponse> {
  if (event.httpMethod === 'OPTIONS') {
    return createResponse(200, {});
  }

  try {
    const user = extractUserFromEvent(event);
    const pathParts = event.path.split('/').filter(p => p);

    if (pathParts.length === 1 && pathParts[0] === 'resources') {
      return await handleGetResources(event, user);
    }

    if (pathParts.length >= 2 && pathParts[0] === 'api') {
      const tableIndex = pathParts[1];
      return await handleTableOperations(event, user, tableIndex);
    }

    return createResponse(404, { error: 'Endpoint not found' });
  } catch (error) {
    console.error('Handler error:', error);
    if (error instanceof Error && error.message === 'Authorization header required') {
      return createResponse(401, { error: 'Unauthorized' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}