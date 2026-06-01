import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, getUserFromEvent, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

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

function createResponse(statusCode: number, body: any) {
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

async function writeAuditLog(user: User, action: string, resource: string, details: any) {
  const auditItem = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.id,
    action,
    resource,
    details,
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditItem
  }));
}

function validateTableIndex(tableIndex: string): string {
  if (!tableConfigs[tableIndex as keyof typeof tableConfigs]) {
    throw new Error('Invalid table index');
  }
  return tableIndex;
}

function addTimestamps(item: any, isUpdate = false): any {
  const now = new Date().toISOString();
  const result = { ...item };
  
  if (!isUpdate) {
    result.createdAt = now;
  }
  result.updatedAt = now;
  
  return result;
}

export const handler = async (event: any) => {
  try {
    const method = event.httpMethod;
    const path = event.path;
    const pathParams = event.pathParameters || {};
    
    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    let user: User;
    try {
      user = getUserFromEvent(event);
    } catch {
      return createResponse(401, { error: 'Unauthorized' });
    }

    if (path === '/resources') {
      if (!hasPermission(user, 'resources', 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }
      
      const resources = Object.entries(tableConfigs).map(([index, config]) => ({
        index,
        name: config.name,
        pk: config.pk
      }));
      
      return createResponse(200, { resources });
    }

    const tableIndexMatch = path.match(/^\/api\/(\d+)/);
    if (!tableIndexMatch) {
      return createResponse(404, { error: 'Not found' });
    }

    const tableIndex = validateTableIndex(tableIndexMatch[1]);
    const config = tableConfigs[tableIndex as keyof typeof tableConfigs];
    const resourceName = config.name;

    if (path.includes('/bulk') && method === 'POST') {
      if (!hasPermission(user, resourceName, 'bulk')) {
        return createResponse(403, { error: 'Forbidden' });
      }

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
        const writeRequests = chunk.map(item => {
          const processedItem = addTimestamps({
            ...item,
            pk: config.pk,
            sk: item.id || randomUUID()
          });
          
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
          imported += chunk.length;
        } catch (error) {
          failed += chunk.length;
          errors.push(`Batch write failed: ${error}`);
        }
      }

      await writeAuditLog(user, 'bulk_import', resourceName, { imported, failed });
      
      return createResponse(200, { imported, failed, errors });
    }

    const idMatch = path.match(/^\/api\/\d+\/(.+)$/);
    const itemId = idMatch ? idMatch[1] : null;

    switch (method) {
      case 'GET':
        if (!hasPermission(user, resourceName, 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        if (itemId) {
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: config.pk, sk: itemId }
          }));
          
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, result.Item);
        } else {
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: { ':pk': config.pk }
          }));
          
          return createResponse(200, { items: result.Items || [] });
        }

      case 'POST':
        if (!hasPermission(user, resourceName, 'create')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const createBody = JSON.parse(event.body || '{}');
        const newItem = addTimestamps({
          ...createBody,
          pk: config.pk,
          sk: createBody.id || randomUUID(),
          createdBy: user.id,
          updatedBy: user.id
        });

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: newItem
        }));

        await writeAuditLog(user, 'create', resourceName, { id: newItem.sk });
        
        return createResponse(201, newItem);

      case 'PUT':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID required' });
        }
        
        if (!hasPermission(user, resourceName, 'update')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const updateBody = JSON.parse(event.body || '{}');
        const updatedItem = addTimestamps({
          ...updateBody,
          pk: config.pk,
          sk: itemId,
          updatedBy: user.id
        }, true);

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));

        await writeAuditLog(user, 'update', resourceName, { id: itemId });
        
        return createResponse(200, updatedItem);

      case 'DELETE':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID required' });
        }
        
        if (!hasPermission(user, resourceName, 'delete')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { pk: config.pk, sk: itemId }
        }));

        await writeAuditLog(user, 'delete', resourceName, { id: itemId });
        
        return createResponse(200, { message: 'Item deleted successfully' });

      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};