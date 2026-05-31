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
    sk: `${Date.now()}_${randomUUID()}`,
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

function validateTableIndex(tableIndex: string): TableConfig {
  const table = TABLES[tableIndex];
  if (!table) {
    throw new Error(`Invalid table index: ${tableIndex}`);
  }
  return table;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = getCurrentUser(event);
    const method = event.httpMethod;
    const path = event.path;
    
    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    if (path === '/resources') {
      checkPermission(user, 'resources', 'read');
      
      const resources = Object.entries(TABLES).map(([index, config]) => ({
        index,
        name: config.name,
        pkField: config.pkField,
        skField: config.skField
      }));
      
      return createResponse(200, { resources });
    }

    const pathParts = path.split('/').filter(p => p);
    if (pathParts.length < 2 || pathParts[0] !== 'api') {
      return createResponse(404, { error: 'Not found' });
    }

    const tableIndex = pathParts[1];
    const table = validateTableIndex(tableIndex);
    const resourceId = pathParts[2];
    const isBulkOperation = pathParts[2] === 'bulk';

    if (isBulkOperation && method === 'POST') {
      checkPermission(user, table.name, 'bulk');
      
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
          const processedItem = {
            ...item,
            [table.pkField]: item[table.pkField] || randomUUID(),
            pk: table.name,
            sk: item[table.pkField] || randomUUID()
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

      await createAuditLog('BULK_IMPORT', table.name, user.id, { imported, failed });
      
      return createResponse(200, { imported, failed, errors });
    }

    switch (method) {
      case 'GET':
        checkPermission(user, table.name, 'read');
        
        if (resourceId) {
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: table.name,
              sk: resourceId
            }
          }));
          
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, result.Item);
        } else {
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: {
              ':pk': table.name
            }
          }));
          
          return createResponse(200, { items: result.Items || [] });
        }

      case 'POST':
        checkPermission(user, table.name, 'create');
        
        const createBody = JSON.parse(event.body || '{}');
        const newId = createBody[table.pkField] || randomUUID();
        
        const newItem = {
          ...createBody,
          [table.pkField]: newId,
          pk: table.name,
          sk: newId,
          createdBy: user.id,
          updatedBy: user.id
        };
        
        addTimestamps(newItem);
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: newItem
        }));
        
        await createAuditLog('CREATE', table.name, user.id, { id: newId });
        
        return createResponse(201, newItem);

      case 'PUT':
        checkPermission(user, table.name, 'update');
        
        if (!resourceId) {
          return createResponse(400, { error: 'Resource ID required for update' });
        }
        
        const updateBody = JSON.parse(event.body || '{}');
        const updatedItem = {
          ...updateBody,
          [table.pkField]: resourceId,
          pk: table.name,
          sk: resourceId,
          updatedBy: user.id
        };
        
        addTimestamps(updatedItem, true);
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));
        
        await createAuditLog('UPDATE', table.name, user.id, { id: resourceId });
        
        return createResponse(200, updatedItem);

      case 'DELETE':
        checkPermission(user, table.name, 'delete');
        
        if (!resourceId) {
          return createResponse(400, { error: 'Resource ID required for delete' });
        }
        
        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: table.name,
            sk: resourceId
          }
        }));
        
        await createAuditLog('DELETE', table.name, user.id, { id: resourceId });
        
        return createResponse(204, {});

      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof Error) {
      if (error.message.includes('Access denied')) {
        return createResponse(403, { error: error.message });
      }
      if (error.message.includes('Invalid table index')) {
        return createResponse(400, { error: error.message });
      }
    }
    
    return createResponse(500, { error: 'Internal server error' });
  }
};