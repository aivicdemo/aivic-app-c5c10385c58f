import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { User, hasPermission, requirePermission } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface TableConfig {
  name: string;
  pkField: string;
  sortKey?: string;
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
    throw new Error('No authorization header');
  }
  
  const role = event.headers['x-user-role'] as 'admin' | 'operator' | 'viewer' || 'viewer';
  const userId = event.headers['x-user-id'] || 'anonymous';
  
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

function validateTableIndex(tableIndex: string): TableConfig {
  const table = TABLES[tableIndex];
  if (!table) {
    throw new Error(`Invalid table index: ${tableIndex}`);
  }
  return table;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const user = getCurrentUser(event);
    const path = event.path;
    const method = event.httpMethod;
    const pathParts = path.split('/').filter(p => p);

    if (path === '/resources' && method === 'GET') {
      requirePermission(user, 'resources', 'read');
      
      const resources = Object.entries(TABLES).map(([index, config]) => ({
        index,
        name: config.name,
        pkField: config.pkField
      }));
      
      return createResponse(200, { resources });
    }

    if (pathParts.length >= 2 && pathParts[0] === 'api') {
      const tableIndex = pathParts[1];
      const table = validateTableIndex(tableIndex);
      
      if (pathParts.length === 3 && pathParts[2] === 'bulk' && method === 'POST') {
        requirePermission(user, table.name, 'bulk');
        
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
          try {
            const putRequests = chunk.map(item => {
              const processedItem = {
                ...item,
                pk: table.name,
                sk: item[table.pkField] || randomUUID(),
                [table.pkField]: item[table.pkField] || randomUUID()
              };
              addTimestamps(processedItem);
              
              return {
                PutRequest: {
                  Item: processedItem
                }
              };
            });
            
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
        
        await writeAuditLog('BULK_IMPORT', table.name, user.id, { imported, failed });
        
        return createResponse(200, { imported, failed, errors });
      }
      
      if (pathParts.length === 2) {
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
          const id = randomUUID();
          
          const item = {
            ...body,
            pk: table.name,
            sk: id,
            [table.pkField]: id,
            createdBy: user.id,
            updatedBy: user.id
          };
          
          addTimestamps(item);
          
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: item
          }));
          
          await writeAuditLog('CREATE', table.name, user.id, { id });
          
          return createResponse(201, item);
        }
      }
      
      if (pathParts.length === 3) {
        const itemId = pathParts[2];
        
        if (method === 'GET') {
          requirePermission(user, table.name, 'read');
          
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: table.name,
              sk: itemId
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
            ...body,
            pk: table.name,
            sk: itemId,
            [table.pkField]: itemId,
            updatedBy: user.id
          };
          
          addTimestamps(item, true);
          
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: item
          }));
          
          await writeAuditLog('UPDATE', table.name, user.id, { id: itemId });
          
          return createResponse(200, item);
        }
        
        if (method === 'DELETE') {
          requirePermission(user, table.name, 'delete');
          
          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: table.name,
              sk: itemId
            }
          }));
          
          await writeAuditLog('DELETE', table.name, user.id, { id: itemId });
          
          return createResponse(204, {});
        }
      }
    }
    
    return createResponse(404, { error: 'Not found' });
    
  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof Error) {
      if (error.message.includes('Insufficient permissions')) {
        return createResponse(403, { error: error.message });
      }
      if (error.message.includes('No authorization header')) {
        return createResponse(401, { error: 'Unauthorized' });
      }
      if (error.message.includes('Invalid table index')) {
        return createResponse(400, { error: error.message });
      }
    }
    
    return createResponse(500, { error: 'Internal server error' });
  }
};