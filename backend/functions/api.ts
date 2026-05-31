import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { User, checkPermission } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE || 'inventory-management';

const TABLE_CONFIGS = {
  '0': { name: 'ログインユーザー', pk: 'USER' },
  '1': { name: '商品マスタ', pk: 'PRODUCT' },
  '2': { name: '仕入先マスタ', pk: 'SUPPLIER' },
  '3': { name: '在庫管理', pk: 'INVENTORY' },
  '4': { name: '仕入実績', pk: 'PURCHASE' },
  '5': { name: '売上実績', pk: 'SALES' },
  '6': { name: '月次集計', pk: 'MONTHLY' },
  '7': { name: '発注推奨', pk: 'ORDER_REC' },
  '8': { name: '商品提案情報', pk: 'PROPOSAL' },
  '9': { name: '顧客マスタ', pk: 'CUSTOMER' },
  '10': { name: 'ペット情報', pk: 'PET' },
  '11': { name: '顧客利用履歴', pk: 'USAGE' },
  '12': { name: '需要予測', pk: 'FORECAST' },
  '13': { name: '発注履歴', pk: 'ORDER_HIST' },
  '14': { name: '在庫調整履歴', pk: 'ADJUST_HIST' }
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

function validateTableIndex(tableIndex: string): string {
  if (!TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS]) {
    throw new Error('Invalid table index');
  }
  return tableIndex;
}

function addTimestamps(item: any, isUpdate = false): any {
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
      return createResponse(200, {
        tables: Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
          index,
          name: config.name,
          pk: config.pk
        }))
      });
    }

    if (pathParts.length >= 2 && pathParts[0] === 'api') {
      const tableIndex = validateTableIndex(pathParts[1]);
      const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      const resourceName = config.name;

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
          const putRequests = batch.map(item => {
            const processedItem = {
              ...item,
              pk: config.pk,
              sk: item.id || randomUUID(),
              id: item.id || randomUUID()
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

        await writeAuditLog('BULK_IMPORT', resourceName, user.id, { imported, failed });
        
        return createResponse(200, { imported, failed, errors });
      }

      // List items
      if (pathParts.length === 2 && method === 'GET') {
        checkPermission(user, resourceName, 'read');
        
        const result = await docClient.send(new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: {
            ':pk': config.pk
          }
        }));
        
        return createResponse(200, { items: result.Items || [] });
      }

      // Get item by ID
      if (pathParts.length === 3 && method === 'GET') {
        checkPermission(user, resourceName, 'read');
        
        const id = pathParts[2];
        const result = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk: config.pk, sk: id }
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
        const id = body.id || randomUUID();
        
        const item = {
          ...body,
          pk: config.pk,
          sk: id,
          id,
          createdBy: user.id,
          updatedBy: user.id
        };
        
        addTimestamps(item);
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        }));
        
        await writeAuditLog('CREATE', resourceName, user.id, { id });
        
        return createResponse(201, item);
      }

      // Update item
      if (pathParts.length === 3 && method === 'PUT') {
        checkPermission(user, resourceName, 'update');
        
        const id = pathParts[2];
        const body = JSON.parse(event.body || '{}');
        
        // Check if item exists
        const existing = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk: config.pk, sk: id }
        }));
        
        if (!existing.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        const updatedItem = {
          ...existing.Item,
          ...body,
          pk: config.pk,
          sk: id,
          id,
          updatedBy: user.id
        };
        
        addTimestamps(updatedItem, true);
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));
        
        await writeAuditLog('UPDATE', resourceName, user.id, { id });
        
        return createResponse(200, updatedItem);
      }

      // Delete item
      if (pathParts.length === 3 && method === 'DELETE') {
        checkPermission(user, resourceName, 'delete');
        
        const id = pathParts[2];
        
        // Check if item exists
        const existing = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk: config.pk, sk: id }
        }));
        
        if (!existing.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { pk: config.pk, sk: id }
        }));
        
        await writeAuditLog('DELETE', resourceName, user.id, { id });
        
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
      if (error.message.includes('Invalid table index')) {
        return createResponse(400, { error: error.message });
      }
    }
    
    return createResponse(500, { 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};