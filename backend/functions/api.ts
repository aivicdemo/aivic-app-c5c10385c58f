import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE || 'inventory-management';

interface APIGatewayEvent {
  httpMethod: string;
  path: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  body?: string;
  headers?: { [key: string]: string };
}

interface APIGatewayResponse {
  statusCode: number;
  headers?: { [key: string]: string };
  body: string;
}

const tableConfigs = {
  '0': { name: 'ログインユーザー', pk: 'USER' },
  '1': { name: '商品マスタ', pk: 'PRODUCT' },
  '2': { name: '仕入先マスタ', pk: 'SUPPLIER' },
  '3': { name: '在庫管理', pk: 'INVENTORY' },
  '4': { name: '仕入実績', pk: 'PURCHASE' },
  '5': { name: '売上実績', pk: 'SALES' },
  '6': { name: '月次集計', pk: 'MONTHLY' },
  '7': { name: '発注推奨', pk: 'ORDER_RECOMMEND' },
  '8': { name: '商品提案情報', pk: 'PRODUCT_PROPOSAL' },
  '9': { name: '顧客マスタ', pk: 'CUSTOMER' },
  '10': { name: 'ペット情報', pk: 'PET' },
  '11': { name: '顧客利用履歴', pk: 'CUSTOMER_HISTORY' },
  '12': { name: '需要予測', pk: 'DEMAND_FORECAST' },
  '13': { name: '発注履歴', pk: 'ORDER_HISTORY' },
  '14': { name: '在庫調整履歴', pk: 'INVENTORY_ADJUSTMENT' }
};

function createResponse(statusCode: number, body: any): APIGatewayResponse {
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

async function writeAuditLog(user: User, action: string, resource: string, details: any = {}) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.id,
    action,
    resource,
    details,
    timestamp: new Date().toISOString()
  };
  
  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: auditLog
    }));
  } catch (error) {
    console.error('Failed to write audit log:', error);
  }
}

function validateRequired(item: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (!item[field]) {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

function addTimestamps(item: any, isUpdate = false) {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

async function handleBulkImport(tableIndex: string, items: any[], user: User) {
  const config = tableConfigs[tableIndex as keyof typeof tableConfigs];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!hasPermission(user, config.pk, 'bulk')) {
    return createResponse(403, { error: 'Insufficient permissions for bulk import' });
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
        pk: config.pk,
        sk: item.id || randomUUID(),
        ...addTimestamps(item)
      };
      
      return {
        PutRequest: {
          Item: processedItem
        }
      };
    });

    try {
      const command = new BatchWriteCommand({
        RequestItems: {
          [TABLE_NAME]: writeRequests
        }
      });
      
      await docClient.send(command);
      imported += batch.length;
    } catch (error) {
      failed += batch.length;
      errors.push(`Batch ${Math.floor(i/25) + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  await writeAuditLog(user, 'BULK_IMPORT', config.pk, { imported, failed, total: items.length });

  return createResponse(200, { imported, failed, errors });
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    let user: User;
    try {
      user = extractUserFromEvent(event);
    } catch (error) {
      return createResponse(401, { error: 'Unauthorized' });
    }

    const path = event.path;
    const method = event.httpMethod;
    const pathParts = path.split('/').filter(p => p);

    // Handle /resources endpoint
    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(user, 'SYSTEM', 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }
      
      return createResponse(200, {
        tables: Object.entries(tableConfigs).map(([index, config]) => ({
          index,
          name: config.name,
          pk: config.pk
        }))
      });
    }

    // Handle table-specific endpoints
    if (pathParts.length >= 2 && pathParts[0] === 'api') {
      const tableIndex = pathParts[1];
      const config = tableConfigs[tableIndex as keyof typeof tableConfigs];
      
      if (!config) {
        return createResponse(404, { error: 'Table not found' });
      }

      // Handle bulk import
      if (pathParts[2] === 'bulk' && method === 'POST') {
        const body = event.body ? JSON.parse(event.body) : {};
        if (!body.items || !Array.isArray(body.items)) {
          return createResponse(400, { error: 'Invalid request body. Expected { items: [] }' });
        }
        return await handleBulkImport(tableIndex, body.items, user);
      }

      // Handle CRUD operations
      switch (method) {
        case 'GET':
          if (!hasPermission(user, config.pk, 'read')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          if (pathParts[2]) {
            // Get single item
            const id = pathParts[2];
            const command = new GetCommand({
              TableName: TABLE_NAME,
              Key: { pk: config.pk, sk: id }
            });
            
            const result = await docClient.send(command);
            if (!result.Item) {
              return createResponse(404, { error: 'Item not found' });
            }
            
            return createResponse(200, result.Item);
          } else {
            // Get all items
            const command = new ScanCommand({
              TableName: TABLE_NAME,
              FilterExpression: 'pk = :pk',
              ExpressionAttributeValues: {
                ':pk': config.pk
              }
            });
            
            const result = await docClient.send(command);
            return createResponse(200, { items: result.Items || [] });
          }

        case 'POST':
          if (!hasPermission(user, config.pk, 'create')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          const createBody = event.body ? JSON.parse(event.body) : {};
          const createItem = {
            ...createBody,
            pk: config.pk,
            sk: createBody.id || randomUUID(),
            ...addTimestamps(createBody)
          };

          const createCommand = new PutCommand({
            TableName: TABLE_NAME,
            Item: createItem
          });
          
          await docClient.send(createCommand);
          await writeAuditLog(user, 'CREATE', config.pk, { id: createItem.sk });
          
          return createResponse(201, createItem);

        case 'PUT':
          if (!hasPermission(user, config.pk, 'update')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          if (!pathParts[2]) {
            return createResponse(400, { error: 'ID required for update' });
          }

          const updateId = pathParts[2];
          const updateBody = event.body ? JSON.parse(event.body) : {};
          
          // Check if item exists
          const existingItem = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: config.pk, sk: updateId }
          }));
          
          if (!existingItem.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          const updatedItem = {
            ...existingItem.Item,
            ...updateBody,
            pk: config.pk,
            sk: updateId,
            ...addTimestamps(updateBody, true)
          };

          const updateCommand = new PutCommand({
            TableName: TABLE_NAME,
            Item: updatedItem
          });
          
          await docClient.send(updateCommand);
          await writeAuditLog(user, 'UPDATE', config.pk, { id: updateId });
          
          return createResponse(200, updatedItem);

        case 'DELETE':
          if (!hasPermission(user, config.pk, 'delete')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          if (!pathParts[2]) {
            return createResponse(400, { error: 'ID required for delete' });
          }

          const deleteId = pathParts[2];
          
          // Check if item exists
          const itemToDelete = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: config.pk, sk: deleteId }
          }));
          
          if (!itemToDelete.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          const deleteCommand = new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { pk: config.pk, sk: deleteId }
          });
          
          await docClient.send(deleteCommand);
          await writeAuditLog(user, 'DELETE', config.pk, { id: deleteId });
          
          return createResponse(200, { message: 'Item deleted successfully' });

        default:
          return createResponse(405, { error: 'Method not allowed' });
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });
    
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};