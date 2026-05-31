import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { User, checkPermission } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface TableConfig {
  name: string;
  pkField: string;
  skField?: string;
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
  const authHeader = event.headers.Authorization || event.headers.authorization;
  if (!authHeader) {
    throw new Error('Authorization header required');
  }
  
  const role = event.headers['x-user-role'] as 'admin' | 'operator' | 'viewer';
  const userId = event.headers['x-user-id'];
  
  if (!role || !userId) {
    throw new Error('User role and ID required');
  }
  
  return { userId, role };
}

async function createAuditLog(action: string, resource: string, userId: string, details?: any): Promise<void> {
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

function validateTableIndex(tableIndex: string): TableConfig {
  const config = TABLES[tableIndex];
  if (!config) {
    throw new Error(`Invalid table index: ${tableIndex}`);
  }
  return config;
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
    const user = getCurrentUser(event);
    const method = event.httpMethod;
    const path = event.path;
    const pathSegments = path.split('/').filter(Boolean);
    
    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }
    
    if (path === '/resources' && method === 'GET') {
      checkPermission(user, 'resources', 'read');
      
      const resources = Object.entries(TABLES).map(([index, config]) => ({
        index,
        name: config.name,
        pkField: config.pkField,
        skField: config.skField
      }));
      
      return createResponse(200, { resources });
    }
    
    if (pathSegments.length >= 2 && pathSegments[0] === 'api') {
      const tableIndex = pathSegments[1];
      const config = validateTableIndex(tableIndex);
      const resourceName = config.name;
      
      if (pathSegments.length === 3 && pathSegments[2] === 'bulk' && method === 'POST') {
        checkPermission(user, resourceName, 'bulk');
        
        const body = JSON.parse(event.body || '{}');
        const items = body.items || [];
        
        if (!Array.isArray(items)) {
          return createResponse(400, { error: 'Items must be an array' });
        }
        
        let imported = 0;
        let failed = 0;
        const errors: string[] = [];
        
        const chunks = [];
        for (let i = 0; i < items.length; i += 25) {
          chunks.push(items.slice(i, i + 25));
        }
        
        for (const chunk of chunks) {
          const putRequests = chunk.map(item => {
            const processedItem = {
              ...item,
              pk: config.name,
              sk: item[config.pkField] || randomUUID()
            };
            
            if (!processedItem[config.pkField]) {
              processedItem[config.pkField] = processedItem.sk;
            }
            
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
            imported += chunk.length;
          } catch (error) {
            failed += chunk.length;
            errors.push(`Batch write failed: ${error}`);
          }
        }
        
        await createAuditLog('BULK_IMPORT', resourceName, user.userId, {
          imported,
          failed,
          totalItems: items.length
        });
        
        return createResponse(200, { imported, failed, errors });
      }
      
      if (method === 'GET' && pathSegments.length === 2) {
        checkPermission(user, resourceName, 'read');
        
        const result = await docClient.send(new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: 'pk = :pk',
          ExpressionAttributeValues: {
            ':pk': config.name
          }
        }));
        
        return createResponse(200, { items: result.Items || [] });
      }
      
      if (method === 'GET' && pathSegments.length === 3) {
        checkPermission(user, resourceName, 'read');
        
        const id = pathSegments[2];
        const result = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: config.name,
            sk: id
          }
        }));
        
        if (!result.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        return createResponse(200, result.Item);
      }
      
      if (method === 'POST' && pathSegments.length === 2) {
        checkPermission(user, resourceName, 'create');
        
        const body = JSON.parse(event.body || '{}');
        const id = body[config.pkField] || randomUUID();
        
        const item = {
          ...body,
          pk: config.name,
          sk: id,
          [config.pkField]: id,
          createdBy: user.userId,
          updatedBy: user.userId
        };
        
        addTimestamps(item);
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        }));
        
        await createAuditLog('CREATE', resourceName, user.userId, { id });
        
        return createResponse(201, item);
      }
      
      if (method === 'PUT' && pathSegments.length === 3) {
        checkPermission(user, resourceName, 'update');
        
        const id = pathSegments[2];
        const body = JSON.parse(event.body || '{}');
        
        const existingItem = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: config.name,
            sk: id
          }
        }));
        
        if (!existingItem.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        const updatedItem = {
          ...existingItem.Item,
          ...body,
          pk: config.name,
          sk: id,
          [config.pkField]: id,
          updatedBy: user.userId
        };
        
        addTimestamps(updatedItem, true);
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));
        
        await createAuditLog('UPDATE', resourceName, user.userId, { id });
        
        return createResponse(200, updatedItem);
      }
      
      if (method === 'DELETE' && pathSegments.length === 3) {
        checkPermission(user, resourceName, 'delete');
        
        const id = pathSegments[2];
        
        const existingItem = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: config.name,
            sk: id
          }
        }));
        
        if (!existingItem.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: config.name,
            sk: id
          }
        }));
        
        await createAuditLog('DELETE', resourceName, user.userId, { id });
        
        return createResponse(200, { message: 'Item deleted successfully' });
      }
    }
    
    return createResponse(404, { error: 'Endpoint not found' });
    
  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof Error) {
      if (error.message.includes('Access denied')) {
        return createResponse(403, { error: error.message });
      }
      if (error.message.includes('Authorization') || error.message.includes('User role')) {
        return createResponse(401, { error: error.message });
      }
      if (error.message.includes('Invalid table') || error.message.includes('not found')) {
        return createResponse(404, { error: error.message });
      }
      if (error.message.includes('must be') || error.message.includes('required')) {
        return createResponse(400, { error: error.message });
      }
    }
    
    return createResponse(500, { error: 'Internal server error' });
  }
};