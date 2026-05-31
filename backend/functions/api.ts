import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { User, checkPermission } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

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
      const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      
      if (!config) {
        return createResponse(404, { error: 'Table not found' });
      }

      const isBulkEndpoint = pathParts[2] === 'bulk';
      const itemId = pathParts[2] && !isBulkEndpoint ? pathParts[2] : null;

      if (isBulkEndpoint && method === 'POST') {
        checkPermission(user, config.name, 'bulk');
        
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

        await writeAuditLog('bulk_import', config.name, user.id, { imported, failed });
        
        return createResponse(200, { imported, failed, errors });
      }

      switch (method) {
        case 'GET':
          checkPermission(user, config.name, 'read');
          
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
            const result = await docClient.send(new QueryCommand({
              TableName: TABLE_NAME,
              KeyConditionExpression: 'pk = :pk',
              ExpressionAttributeValues: {
                ':pk': config.pk
              }
            }));
            
            return createResponse(200, { items: result.Items || [] });
          }

        case 'POST':
          checkPermission(user, config.name, 'create');
          
          const createBody = JSON.parse(event.body || '{}');
          const newItem = {
            ...createBody,
            pk: config.pk,
            sk: createBody.id || randomUUID(),
            ...addTimestamps(createBody)
          };
          
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: newItem
          }));
          
          await writeAuditLog('create', config.name, user.id, { itemId: newItem.sk });
          
          return createResponse(201, newItem);

        case 'PUT':
          checkPermission(user, config.name, 'update');
          
          if (!itemId) {
            return createResponse(400, { error: 'Item ID required for update' });
          }
          
          const updateBody = JSON.parse(event.body || '{}');
          const updatedItem = {
            ...updateBody,
            pk: config.pk,
            sk: itemId,
            ...addTimestamps(updateBody, true)
          };
          
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: updatedItem
          }));
          
          await writeAuditLog('update', config.name, user.id, { itemId });
          
          return createResponse(200, updatedItem);

        case 'DELETE':
          checkPermission(user, config.name, 'delete');
          
          if (!itemId) {
            return createResponse(400, { error: 'Item ID required for delete' });
          }
          
          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { pk: config.pk, sk: itemId }
          }));
          
          await writeAuditLog('delete', config.name, user.id, { itemId });
          
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
    
    return createResponse(500, { error: 'Internal server error', details: error.message });
  }
};