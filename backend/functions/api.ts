import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { User, requirePermission } from './rbac';
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

function validateTableIndex(tableIndex: string): TableConfig {
  const table = TABLES[tableIndex];
  if (!table) {
    throw new Error(`Invalid table index: ${tableIndex}`);
  }
  return table;
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
      requirePermission(user, 'resources', 'read');
      
      const resources = Object.entries(TABLES).map(([index, config]) => ({
        index,
        name: config.name,
        pk: config.pk,
        sk: config.sk
      }));
      
      return createResponse(200, { resources });
    }

    if (pathSegments.length >= 2 && pathSegments[0] === 'api') {
      const tableIndex = pathSegments[1];
      const table = validateTableIndex(tableIndex);
      
      if (pathSegments.length === 3 && pathSegments[2] === 'bulk' && method === 'POST') {
        requirePermission(user, table.name, 'bulk');
        
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
          const putRequests = batch.map(item => {
            const processedItem = {
              ...item,
              [table.pk]: item[table.pk] || randomUUID(),
              ...addTimestamps(item, false)
            };
            
            return {
              PutRequest: {
                Item: {
                  pk: table.name,
                  sk: processedItem[table.pk],
                  ...processedItem
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
          } catch (error) {
            failed += batch.length;
            errors.push(`Batch ${Math.floor(i/25) + 1}: ${error}`);
          }
        }
        
        await writeAuditLog('bulk_import', table.name, user.id, { imported, failed });
        
        return createResponse(200, { imported, failed, errors });
      }
      
      if (pathSegments.length === 2) {
        if (method === 'GET') {
          requirePermission(user, table.name, 'read');
          
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: {
              ':pk': table.name
            }
          }));
          
          return createResponse(200, { items: result.Items || [] });
        }
        
        if (method === 'POST') {
          requirePermission(user, table.name, 'create');
          
          const body = JSON.parse(event.body || '{}');
          const id = body[table.pk] || randomUUID();
          
          const item = {
            pk: table.name,
            sk: id,
            [table.pk]: id,
            ...body,
            ...addTimestamps(body, false)
          };
          
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: item
          }));
          
          await writeAuditLog('create', table.name, user.id, { id });
          
          return createResponse(201, item);
        }
      }
      
      if (pathSegments.length === 3) {
        const id = pathSegments[2];
        
        if (method === 'GET') {
          requirePermission(user, table.name, 'read');
          
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: table.name,
              sk: id
            }
          }));
          
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, result.Item);
        }
        
        if (method === 'PUT') {
          requirePermission(user, table.name, 'update');
          
          const body = JSON.parse(event.body || '{}');
          
          const item = {
            pk: table.name,
            sk: id,
            [table.pk]: id,
            ...body,
            ...addTimestamps(body, true)
          };
          
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: item
          }));
          
          await writeAuditLog('update', table.name, user.id, { id });
          
          return createResponse(200, item);
        }
        
        if (method === 'DELETE') {
          requirePermission(user, table.name, 'delete');
          
          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: table.name,
              sk: id
            }
          }));
          
          await writeAuditLog('delete', table.name, user.id, { id });
          
          return createResponse(204, {});
        }
      }
    }
    
    return createResponse(404, { error: 'Not found' });
    
  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof Error && error.message.includes('Access denied')) {
      return createResponse(403, { error: error.message });
    }
    
    if (error instanceof Error && error.message.includes('Invalid table index')) {
      return createResponse(400, { error: error.message });
    }
    
    return createResponse(500, { error: 'Internal server error' });
  }
};