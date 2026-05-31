import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { User, checkPermission } from './rbac';
import { randomUUID } from 'crypto';

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

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = getCurrentUser(event);
    const method = event.httpMethod;
    const path = event.path;
    const pathParts = path.split('/').filter(p => p);
    
    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    if (path === '/resources' && method === 'GET') {
      checkPermission(user, 'resources', 'read');
      
      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        index,
        name: config.name,
        pk: config.pk
      }));
      
      return createResponse(200, { resources });
    }

    if (pathParts.length >= 2 && pathParts[0] === 'api') {
      const tableIndex = pathParts[1];
      const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      
      if (!tableConfig) {
        return createResponse(404, { error: 'Table not found' });
      }

      const isBulkEndpoint = pathParts[2] === 'bulk';
      const itemId = pathParts[2] && !isBulkEndpoint ? pathParts[2] : null;

      if (isBulkEndpoint && method === 'POST') {
        checkPermission(user, tableConfig.name, 'bulk');
        
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
            const writeRequests = chunk.map(item => {
              const processedItem = {
                ...item,
                pk: tableConfig.name,
                sk: item[tableConfig.pk] || randomUUID(),
                [tableConfig.pk]: item[tableConfig.pk] || randomUUID()
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
                [TABLE_NAME]: writeRequests
              }
            }));
            
            imported += chunk.length;
          } catch (error) {
            failed += chunk.length;
            errors.push(`Batch write failed: ${error}`);
          }
        }

        await createAuditLog('BULK_IMPORT', tableConfig.name, user.id, { imported, failed });
        
        return createResponse(200, { imported, failed, errors });
      }

      switch (method) {
        case 'GET':
          checkPermission(user, tableConfig.name, 'read');
          
          if (itemId) {
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
            const result = await docClient.send(new ScanCommand({
              TableName: TABLE_NAME,
              FilterExpression: 'pk = :pk',
              ExpressionAttributeValues: {
                ':pk': tableConfig.name
              }
            }));
            
            return createResponse(200, { items: result.Items || [] });
          }

        case 'POST':
          checkPermission(user, tableConfig.name, 'create');
          
          const createBody = JSON.parse(event.body || '{}');
          const newId = randomUUID();
          const newItem = {
            ...createBody,
            pk: tableConfig.name,
            sk: newId,
            [tableConfig.pk]: newId,
            createdBy: user.id,
            updatedBy: user.id
          };
          addTimestamps(newItem);
          
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: newItem
          }));
          
          await createAuditLog('CREATE', tableConfig.name, user.id, { itemId: newId });
          
          return createResponse(201, newItem);

        case 'PUT':
          if (!itemId) {
            return createResponse(400, { error: 'Item ID required for update' });
          }
          
          checkPermission(user, tableConfig.name, 'update');
          
          const updateBody = JSON.parse(event.body || '{}');
          const updateItem = {
            ...updateBody,
            pk: tableConfig.name,
            sk: itemId,
            [tableConfig.pk]: itemId,
            updatedBy: user.id
          };
          addTimestamps(updateItem, true);
          
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: updateItem
          }));
          
          await createAuditLog('UPDATE', tableConfig.name, user.id, { itemId });
          
          return createResponse(200, updateItem);

        case 'DELETE':
          if (!itemId) {
            return createResponse(400, { error: 'Item ID required for delete' });
          }
          
          checkPermission(user, tableConfig.name, 'delete');
          
          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: tableConfig.name,
              sk: itemId
            }
          }));
          
          await createAuditLog('DELETE', tableConfig.name, user.id, { itemId });
          
          return createResponse(200, { message: 'Item deleted successfully' });

        default:
          return createResponse(405, { error: 'Method not allowed' });
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });
    
  } catch (error: any) {
    console.error('Error:', error);
    
    if (error.message?.includes('Access denied')) {
      return createResponse(403, { error: error.message });
    }
    
    return createResponse(500, { error: 'Internal server error' });
  }
};