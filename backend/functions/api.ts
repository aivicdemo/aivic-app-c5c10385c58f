import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { User, hasPermission } from './rbac';
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
  '7': { name: 'OrderRecommendation', pkField: 'orderRecommendationId', resource: 'recommendations' },
  '8': { name: 'ProductProposal', pkField: 'proposalId', resource: 'proposals' },
  '9': { name: 'CustomerMaster', pkField: 'customerId', resource: 'customers' },
  '10': { name: 'PetInfo', pkField: 'petId', resource: 'pets' },
  '11': { name: 'CustomerUsageHistory', pkField: 'usageHistoryId', resource: 'usage' },
  '12': { name: 'DemandForecast', pkField: 'demandForecastId', resource: 'forecasts' },
  '13': { name: 'OrderHistory', pkField: 'orderHistoryId', resource: 'orders' },
  '14': { name: 'InventoryAdjustmentHistory', pkField: 'adjustmentHistoryId', resource: 'adjustments' }
};

function getCurrentUser(event: APIGatewayProxyEvent): User {
  const authHeader = event.headers.Authorization || event.headers.authorization;
  if (!authHeader) {
    throw new Error('Authorization header required');
  }
  
  const role = event.headers['x-user-role'] as 'admin' | 'operator' | 'viewer';
  const userId = event.headers['x-user-id'];
  
  if (!role || !userId) {
    throw new Error('User role and ID required');
  }
  
  return { id: userId, role };
}

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-user-role, x-user-id'
    },
    body: JSON.stringify(body)
  };
}

async function createAuditLog(user: User, action: string, resource: string, details: any): Promise<void> {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.id,
    userRole: user.role,
    action,
    resource,
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
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const user = getCurrentUser(event);
    const path = event.path;
    const method = event.httpMethod;

    // Handle /resources endpoint
    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(user, 'system', 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }
      
      const resources = Object.entries(TABLES).map(([index, config]) => ({
        index,
        name: config.name,
        resource: config.resource
      }));
      
      return createResponse(200, { resources });
    }

    // Parse table operations
    const pathMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(\w+))?$/);
    if (!pathMatch) {
      return createResponse(404, { error: 'Invalid path' });
    }

    const [, tableIndex, operation, itemId] = pathMatch;
    const tableConfig = TABLES[tableIndex];
    
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }

    // Handle bulk import
    if (operation === 'bulk' && method === 'POST') {
      if (!hasPermission(user, tableConfig.resource, 'bulk')) {
        return createResponse(403, { error: 'Insufficient permissions for bulk operations' });
      }

      const body = JSON.parse(event.body || '{}');
      const items = body.items || [];
      
      if (!Array.isArray(items)) {
        return createResponse(400, { error: 'Items must be an array' });
      }

      let imported = 0;
      let failed = 0;
      const errors: string[] = [];

      // Process in batches of 25 (DynamoDB limit)
      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        const writeRequests = batch.map(item => {
          const processedItem = {
            ...item,
            pk: tableConfig.name,
            sk: item[tableConfig.pkField] || randomUUID(),
            [tableConfig.pkField]: item[tableConfig.pkField] || randomUUID()
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
              [TABLE_NAME]: writeRequests
            }
          }));
          imported += batch.length;
        } catch (error) {
          failed += batch.length;
          errors.push(`Batch ${Math.floor(i/25) + 1}: ${error}`);
        }
      }

      await createAuditLog(user, 'BULK_IMPORT', tableConfig.resource, {
        imported,
        failed,
        totalItems: items.length
      });

      return createResponse(200, { imported, failed, errors });
    }

    // Handle CRUD operations
    switch (method) {
      case 'GET':
        if (!hasPermission(user, tableConfig.resource, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (itemId) {
          // Get single item
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: tableConfig.name,
              sk: itemId
            }
          }));
          
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, result.Item);
        } else {
          // List items
          const result = await docClient.send(new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: 'pk = :pk',
            ExpressionAttributeValues: {
              ':pk': tableConfig.name
            }
          }));
          
          return createResponse(200, { items: result.Items || [] });
        }

      case 'POST':
        if (!hasPermission(user, tableConfig.resource, 'create')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const createBody = JSON.parse(event.body || '{}');
        const newId = randomUUID();
        const newItem = {
          ...createBody,
          pk: tableConfig.name,
          sk: newId,
          [tableConfig.pkField]: newId,
          createdBy: user.id,
          updatedBy: user.id
        };
        addTimestamps(newItem);

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: newItem
        }));

        await createAuditLog(user, 'CREATE', tableConfig.resource, { id: newId });
        return createResponse(201, newItem);

      case 'PUT':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID required for update' });
        }
        
        if (!hasPermission(user, tableConfig.resource, 'update')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const updateBody = JSON.parse(event.body || '{}');
        const updatedItem = {
          ...updateBody,
          pk: tableConfig.name,
          sk: itemId,
          [tableConfig.pkField]: itemId,
          updatedBy: user.id
        };
        addTimestamps(updatedItem, true);

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));

        await createAuditLog(user, 'UPDATE', tableConfig.resource, { id: itemId });
        return createResponse(200, updatedItem);

      case 'DELETE':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID required for delete' });
        }
        
        if (!hasPermission(user, tableConfig.resource, 'delete')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.name,
            sk: itemId
          }
        }));

        await createAuditLog(user, 'DELETE', tableConfig.resource, { id: itemId });
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
      if (error.message.includes('Authorization') || error.message.includes('required')) {
        return createResponse(401, { error: error.message });
      }
      if (error.message.includes('not found')) {
        return createResponse(404, { error: error.message });
      }
      if (error.message.includes('validation') || error.message.includes('invalid')) {
        return createResponse(400, { error: error.message });
      }
    }
    
    return createResponse(500, { error: 'Internal server error' });
  }
};