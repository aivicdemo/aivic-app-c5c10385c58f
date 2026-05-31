import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { User, hasPermission, requirePermission } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface TableConfig {
  name: string;
  pkField: string;
  resource: string;
}

const TABLES: Record<string, TableConfig> = {
  '0': { name: 'LoginUser', pkField: 'userId', resource: 'users' },
  '1': { name: 'ProductMaster', pkField: 'productId', resource: 'products' },
  '2': { name: 'SupplierMaster', pkField: 'supplierId', resource: 'suppliers' },
  '3': { name: 'InventoryManagement', pkField: 'inventoryId', resource: 'inventory' },
  '4': { name: 'PurchaseRecord', pkField: 'purchaseRecordId', resource: 'purchases' },
  '5': { name: 'SalesRecord', pkField: 'salesRecordId', resource: 'sales' },
  '6': { name: 'MonthlySummary', pkField: 'summaryId', resource: 'summaries' },
  '7': { name: 'OrderRecommendation', pkField: 'recommendationId', resource: 'recommendations' },
  '8': { name: 'ProductProposal', pkField: 'proposalId', resource: 'proposals' },
  '9': { name: 'CustomerMaster', pkField: 'customerId', resource: 'customers' },
  '10': { name: 'PetInfo', pkField: 'petId', resource: 'pets' },
  '11': { name: 'CustomerUsageHistory', pkField: 'usageHistoryId', resource: 'usage' },
  '12': { name: 'DemandForecast', pkField: 'forecastId', resource: 'forecasts' },
  '13': { name: 'OrderHistory', pkField: 'orderHistoryId', resource: 'orders' },
  '14': { name: 'InventoryAdjustmentHistory', pkField: 'adjustmentHistoryId', resource: 'adjustments' }
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

async function writeAuditLog(action: string, resource: string, userId: string, details?: any): Promise<void> {
  const auditRecord = {
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
    Item: auditRecord
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
    const path = event.path;
    const method = event.httpMethod;
    const user = getCurrentUser(event);

    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    // GET /resources - リソース一覧
    if (path === '/resources' && method === 'GET') {
      requirePermission(user, 'system', 'read');
      
      const resources = Object.entries(TABLES).map(([index, config]) => ({
        index,
        name: config.name,
        resource: config.resource,
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

    // API endpoints
    const apiMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(\w+))?$/);
    if (!apiMatch) {
      return createResponse(404, { error: 'Endpoint not found' });
    }

    const [, tableIndex, resourceId, action] = apiMatch;
    const tableConfig = TABLES[tableIndex];
    
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }

    const { name: tableName, pkField, resource } = tableConfig;

    // Bulk import endpoint
    if (action === 'bulk' && method === 'POST') {
      requirePermission(user, resource, 'bulk');
      
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
            [pkField]: item[pkField] || randomUUID(),
            pk: tableName,
            sk: item[pkField] || randomUUID()
          };
          addTimestamps(processedItem);
          
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

      await writeAuditLog('BULK_IMPORT', resource, user.id, { imported, failed, total: items.length });
      
      return createResponse(200, { imported, failed, errors });
    }

    // List items
    if (!resourceId && method === 'GET') {
      requirePermission(user, resource, 'read');
      
      const command = new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: {
          ':pk': tableName
        }
      });
      
      const result = await docClient.send(command);
      return createResponse(200, { items: result.Items || [] });
    }

    // Get single item
    if (resourceId && method === 'GET') {
      requirePermission(user, resource, 'read');
      
      const command = new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableName,
          sk: resourceId
        }
      });
      
      const result = await docClient.send(command);
      if (!result.Item) {
        return createResponse(404, { error: 'Item not found' });
      }
      
      return createResponse(200, result.Item);
    }

    // Create item
    if (!resourceId && method === 'POST') {
      requirePermission(user, resource, 'create');
      
      const body = JSON.parse(event.body || '{}');
      const id = body[pkField] || randomUUID();
      
      const item = {
        ...body,
        [pkField]: id,
        pk: tableName,
        sk: id,
        createdBy: user.id,
        updatedBy: user.id
      };
      
      addTimestamps(item);
      
      const command = new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      });
      
      await docClient.send(command);
      await writeAuditLog('CREATE', resource, user.id, { id });
      
      return createResponse(201, item);
    }

    // Update item
    if (resourceId && method === 'PUT') {
      requirePermission(user, resource, 'update');
      
      const body = JSON.parse(event.body || '{}');
      
      // Check if item exists
      const getCommand = new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableName,
          sk: resourceId
        }
      });
      
      const existingItem = await docClient.send(getCommand);
      if (!existingItem.Item) {
        return createResponse(404, { error: 'Item not found' });
      }
      
      const updatedItem = {
        ...existingItem.Item,
        ...body,
        [pkField]: resourceId,
        pk: tableName,
        sk: resourceId,
        updatedBy: user.id
      };
      
      addTimestamps(updatedItem, true);
      
      const putCommand = new PutCommand({
        TableName: TABLE_NAME,
        Item: updatedItem
      });
      
      await docClient.send(putCommand);
      await writeAuditLog('UPDATE', resource, user.id, { id: resourceId });
      
      return createResponse(200, updatedItem);
    }

    // Delete item
    if (resourceId && method === 'DELETE') {
      requirePermission(user, resource, 'delete');
      
      // Check if item exists
      const getCommand = new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableName,
          sk: resourceId
        }
      });
      
      const existingItem = await docClient.send(getCommand);
      if (!existingItem.Item) {
        return createResponse(404, { error: 'Item not found' });
      }
      
      const deleteCommand = new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: tableName,
          sk: resourceId
        }
      });
      
      await docClient.send(deleteCommand);
      await writeAuditLog('DELETE', resource, user.id, { id: resourceId });
      
      return createResponse(200, { message: 'Item deleted successfully' });
    }

    return createResponse(405, { error: 'Method not allowed' });
    
  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof Error) {
      if (error.message.includes('Insufficient permissions')) {
        return createResponse(403, { error: error.message });
      }
      if (error.message.includes('Authorization header required')) {
        return createResponse(401, { error: 'Unauthorized' });
      }
      if (error.message.includes('not found')) {
        return createResponse(404, { error: error.message });
      }
      if (error.message.includes('validation') || error.message.includes('required')) {
        return createResponse(400, { error: error.message });
      }
    }
    
    return createResponse(500, { error: 'Internal server error' });
  }
};