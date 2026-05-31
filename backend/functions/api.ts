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

function getUserFromEvent(event: APIGatewayProxyEvent): User {
  const authHeader = event.headers.Authorization || event.headers.authorization;
  if (!authHeader) {
    throw new Error('Authorization header required');
  }
  
  try {
    const token = authHeader.replace('Bearer ', '');
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return {
      id: payload.sub || payload.userId || 'anonymous',
      role: payload.role || 'viewer'
    };
  } catch {
    return { id: 'anonymous', role: 'viewer' };
  }
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
    const user = getUserFromEvent(event);
    const method = event.httpMethod;
    const path = event.path;
    
    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }
    
    if (path === '/resources' && method === 'GET') {
      checkPermission(user, 'resources', 'read');
      
      const resources = Object.entries(TABLES).map(([index, config]) => ({
        index,
        name: config.name,
        pkField: config.pkField
      }));
      
      return createResponse(200, { resources });
    }
    
    const pathParts = path.split('/').filter(p => p);
    if (pathParts.length < 2 || pathParts[0] !== 'api') {
      return createResponse(404, { error: 'Not found' });
    }
    
    const tableIndex = pathParts[1];
    const tableConfig = TABLES[tableIndex];
    
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }
    
    const resourceName = tableConfig.name;
    
    // Bulk import endpoint
    if (pathParts[2] === 'bulk' && method === 'POST') {
      checkPermission(user, resourceName, 'bulk');
      
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
            pk: resourceName,
            sk: item[tableConfig.pkField] || randomUUID(),
            ...addTimestamps(item)
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
              [TABLE_NAME]: writeRequests
            }
          }));
          imported += batch.length;
        } catch (error) {
          failed += batch.length;
          errors.push(`Batch ${Math.floor(i/25) + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
      
      await createAuditLog(user, 'BULK_IMPORT', resourceName, { imported, failed, total: items.length });
      
      return createResponse(200, { imported, failed, errors });
    }
    
    // CRUD operations
    switch (method) {
      case 'GET':
        checkPermission(user, resourceName, 'read');
        
        if (pathParts[2]) {
          // Get single item
          const id = pathParts[2];
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: resourceName, sk: id }
          }));
          
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, result.Item);
        } else {
          // List items
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: {
              ':pk': resourceName
            }
          }));
          
          return createResponse(200, { items: result.Items || [] });
        }
      
      case 'POST':
        checkPermission(user, resourceName, 'create');
        
        const createBody = JSON.parse(event.body || '{}');
        const newItem = {
          ...createBody,
          pk: resourceName,
          sk: createBody[tableConfig.pkField] || randomUUID(),
          createdBy: user.id,
          updatedBy: user.id,
          ...addTimestamps(createBody)
        };
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: newItem
        }));
        
        await createAuditLog(user, 'CREATE', resourceName, { id: newItem.sk });
        
        return createResponse(201, newItem);
      
      case 'PUT':
        checkPermission(user, resourceName, 'update');
        
        if (!pathParts[2]) {
          return createResponse(400, { error: 'ID required for update' });
        }
        
        const updateId = pathParts[2];
        const updateBody = JSON.parse(event.body || '{}');
        
        // Check if item exists
        const existingItem = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk: resourceName, sk: updateId }
        }));
        
        if (!existingItem.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        const updatedItem = {
          ...existingItem.Item,
          ...updateBody,
          pk: resourceName,
          sk: updateId,
          updatedBy: user.id,
          ...addTimestamps(updateBody, true)
        };
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));
        
        await createAuditLog(user, 'UPDATE', resourceName, { id: updateId });
        
        return createResponse(200, updatedItem);
      
      case 'DELETE':
        checkPermission(user, resourceName, 'delete');
        
        if (!pathParts[2]) {
          return createResponse(400, { error: 'ID required for delete' });
        }
        
        const deleteId = pathParts[2];
        
        // Check if item exists
        const itemToDelete = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk: resourceName, sk: deleteId }
        }));
        
        if (!itemToDelete.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { pk: resourceName, sk: deleteId }
        }));
        
        await createAuditLog(user, 'DELETE', resourceName, { id: deleteId });
        
        return createResponse(200, { message: 'Item deleted successfully' });
      
      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
    
  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof Error) {
      if (error.message.includes('Access denied')) {
        return createResponse(403, { error: error.message });
      }
      if (error.message.includes('Authorization header required')) {
        return createResponse(401, { error: 'Unauthorized' });
      }
      if (error.message.includes('not found')) {
        return createResponse(404, { error: error.message });
      }
      if (error.message.includes('required') || error.message.includes('invalid')) {
        return createResponse(400, { error: error.message });
      }
    }
    
    return createResponse(500, { error: 'Internal server error' });
  }
};