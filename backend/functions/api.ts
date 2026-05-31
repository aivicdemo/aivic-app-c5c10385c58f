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
  pk: string;
  sk?: string;
}

const TABLES: Record<string, TableConfig> = {
  '0': { name: 'LoginUser', pk: 'userId' },
  '1': { name: 'ProductMaster', pk: 'productId' },
  '2': { name: 'SupplierMaster', pk: 'supplierId' },
  '3': { name: 'InventoryManagement', pk: 'inventoryId' },
  '4': { name: 'PurchaseRecord', pk: 'purchaseRecordId' },
  '5': { name: 'SalesRecord', pk: 'salesRecordId' },
  '6': { name: 'MonthlySummary', pk: 'summaryId' },
  '7': { name: 'OrderRecommendation', pk: 'orderRecommendationId' },
  '8': { name: 'ProductProposal', pk: 'proposalId' },
  '9': { name: 'CustomerMaster', pk: 'customerId' },
  '10': { name: 'PetInfo', pk: 'petId' },
  '11': { name: 'CustomerUsageHistory', pk: 'usageHistoryId' },
  '12': { name: 'DemandForecast', pk: 'demandForecastId' },
  '13': { name: 'OrderHistory', pk: 'orderHistoryId' },
  '14': { name: 'InventoryAdjustmentHistory', pk: 'adjustmentHistoryId' }
};

function getCurrentUser(event: APIGatewayProxyEvent): User {
  const userRole = event.headers['x-user-role'] || 'viewer';
  const userId = event.headers['x-user-id'] || 'anonymous';
  return {
    id: userId,
    role: userRole as 'admin' | 'operator' | 'viewer'
  };
}

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(body)
  };
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
    const pathParts = path.split('/').filter(p => p);
    
    if (path === '/resources' && method === 'GET') {
      checkPermission(user, 'resources', 'read');
      
      const resources = Object.entries(TABLES).map(([index, config]) => ({
        index,
        name: config.name,
        pk: config.pk,
        sk: config.sk
      }));
      
      return createResponse(200, { resources });
    }
    
    if (pathParts.length >= 2 && pathParts[0] === 'api') {
      const tableIndex = pathParts[1];
      const tableConfig = TABLES[tableIndex];
      
      if (!tableConfig) {
        return createResponse(404, { error: 'Table not found' });
      }
      
      const resourceName = tableConfig.name;
      
      // Bulk import endpoint
      if (pathParts.length === 3 && pathParts[2] === 'bulk' && method === 'POST') {
        checkPermission(user, resourceName, 'bulk');
        
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
          const writeRequests = batch.map(item => {
            const processedItem = {
              ...item,
              [tableConfig.pk]: item[tableConfig.pk] || randomUUID(),
              ...addTimestamps(item)
            };
            processedItem.pk = `${tableConfig.name}#${processedItem[tableConfig.pk]}`;
            
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
        
        await createAuditLog('BULK_IMPORT', resourceName, user.id, { imported, failed });
        
        return createResponse(200, { imported, failed, errors });
      }
      
      // List items
      if (pathParts.length === 2 && method === 'GET') {
        checkPermission(user, resourceName, 'read');
        
        const result = await docClient.send(new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: 'begins_with(pk, :pkPrefix)',
          ExpressionAttributeValues: {
            ':pkPrefix': `${tableConfig.name}#`
          }
        }));
        
        return createResponse(200, { items: result.Items || [] });
      }
      
      // Get item by ID
      if (pathParts.length === 3 && method === 'GET') {
        checkPermission(user, resourceName, 'read');
        
        const itemId = pathParts[2];
        const result = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: `${tableConfig.name}#${itemId}`
          }
        }));
        
        if (!result.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        return createResponse(200, result.Item);
      }
      
      // Create item
      if (pathParts.length === 2 && method === 'POST') {
        checkPermission(user, resourceName, 'create');
        
        const body = JSON.parse(event.body || '{}');
        const itemId = body[tableConfig.pk] || randomUUID();
        
        const item = {
          ...body,
          [tableConfig.pk]: itemId,
          pk: `${tableConfig.name}#${itemId}`,
          ...addTimestamps(body)
        };
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        }));
        
        await createAuditLog('CREATE', resourceName, user.id, { itemId });
        
        return createResponse(201, item);
      }
      
      // Update item
      if (pathParts.length === 3 && method === 'PUT') {
        checkPermission(user, resourceName, 'update');
        
        const itemId = pathParts[2];
        const body = JSON.parse(event.body || '{}');
        
        // Check if item exists
        const existingItem = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: `${tableConfig.name}#${itemId}`
          }
        }));
        
        if (!existingItem.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        const updatedItem = {
          ...existingItem.Item,
          ...body,
          [tableConfig.pk]: itemId,
          pk: `${tableConfig.name}#${itemId}`,
          ...addTimestamps(body, true)
        };
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));
        
        await createAuditLog('UPDATE', resourceName, user.id, { itemId });
        
        return createResponse(200, updatedItem);
      }
      
      // Delete item
      if (pathParts.length === 3 && method === 'DELETE') {
        checkPermission(user, resourceName, 'delete');
        
        const itemId = pathParts[2];
        
        // Check if item exists
        const existingItem = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: `${tableConfig.name}#${itemId}`
          }
        }));
        
        if (!existingItem.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: `${tableConfig.name}#${itemId}`
          }
        }));
        
        await createAuditLog('DELETE', resourceName, user.id, { itemId });
        
        return createResponse(200, { message: 'Item deleted successfully' });
      }
    }
    
    return createResponse(404, { error: 'Endpoint not found' });
    
  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof Error && error.message.includes('Access denied')) {
      return createResponse(403, { error: error.message });
    }
    
    return createResponse(500, { error: 'Internal server error' });
  }
};