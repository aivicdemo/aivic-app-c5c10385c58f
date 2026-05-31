import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import * as crypto from 'crypto';

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

interface APIGatewayEvent {
  httpMethod: string;
  pathParameters: { [key: string]: string } | null;
  queryStringParameters: { [key: string]: string } | null;
  body: string | null;
  headers: { [key: string]: string };
}

interface APIGatewayResponse {
  statusCode: number;
  headers: { [key: string]: string };
  body: string;
}

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

async function createAuditLog(user: User, action: string, resource: string, details: any = {}) {
  const auditItem = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${crypto.randomUUID()}`,
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

function validateTableIndex(tableIndex: string): boolean {
  return tableIndex in TABLE_CONFIGS;
}

function addTimestamps(item: any, isUpdate = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
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

    const path = event.pathParameters?.proxy || '';
    const pathParts = path.split('/');
    
    if (pathParts[0] === 'resources') {
      if (event.httpMethod === 'GET') {
        if (!hasPermission(user, 'resources', 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
          index,
          name: config.name,
          pk: config.pk
        }));
        
        return createResponse(200, { resources });
      }
    }

    if (pathParts[0] === 'api' && pathParts.length >= 2) {
      const tableIndex = pathParts[1];
      
      if (!validateTableIndex(tableIndex)) {
        return createResponse(404, { error: 'Table not found' });
      }
      
      const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      
      if (pathParts.length === 3 && pathParts[2] === 'bulk' && event.httpMethod === 'POST') {
        if (!hasPermission(user, tableConfig.pk, 'bulk')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        try {
          const requestBody = JSON.parse(event.body || '{}');
          const items = requestBody.items || [];
          
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
                pk: tableConfig.pk,
                sk: item.id || crypto.randomUUID(),
                id: item.id || crypto.randomUUID(),
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
                  [TABLE_NAME]: putRequests
                }
              }));
              imported += batch.length;
            } catch (error) {
              failed += batch.length;
              errors.push(`Batch ${Math.floor(i/25) + 1}: ${error}`);
            }
          }
          
          await createAuditLog(user, 'BULK_IMPORT', tableConfig.pk, {
            imported,
            failed,
            totalItems: items.length
          });
          
          return createResponse(200, { imported, failed, errors });
        } catch (error) {
          return createResponse(400, { error: 'Invalid request body' });
        }
      }
      
      if (event.httpMethod === 'GET' && pathParts.length === 2) {
        if (!hasPermission(user, tableConfig.pk, 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        try {
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: {
              ':pk': tableConfig.pk
            }
          }));
          
          return createResponse(200, { items: result.Items || [] });
        } catch (error) {
          return createResponse(500, { error: 'Internal server error' });
        }
      }
      
      if (event.httpMethod === 'GET' && pathParts.length === 3) {
        if (!hasPermission(user, tableConfig.pk, 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        const itemId = pathParts[2];
        
        try {
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: tableConfig.pk,
              sk: itemId
            }
          }));
          
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, result.Item);
        } catch (error) {
          return createResponse(500, { error: 'Internal server error' });
        }
      }
      
      if (event.httpMethod === 'POST' && pathParts.length === 2) {
        if (!hasPermission(user, tableConfig.pk, 'create')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        try {
          const requestBody = JSON.parse(event.body || '{}');
          const itemId = requestBody.id || crypto.randomUUID();
          
          const item = {
            ...requestBody,
            pk: tableConfig.pk,
            sk: itemId,
            id: itemId,
            createdBy: user.id,
            updatedBy: user.id,
            ...addTimestamps(requestBody)
          };
          
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: item
          }));
          
          await createAuditLog(user, 'CREATE', tableConfig.pk, { itemId });
          
          return createResponse(201, item);
        } catch (error) {
          return createResponse(400, { error: 'Invalid request body' });
        }
      }
      
      if (event.httpMethod === 'PUT' && pathParts.length === 3) {
        if (!hasPermission(user, tableConfig.pk, 'update')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        const itemId = pathParts[2];
        
        try {
          const requestBody = JSON.parse(event.body || '{}');
          
          const existingItem = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: tableConfig.pk,
              sk: itemId
            }
          }));
          
          if (!existingItem.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          const updatedItem = {
            ...existingItem.Item,
            ...requestBody,
            pk: tableConfig.pk,
            sk: itemId,
            id: itemId,
            updatedBy: user.id,
            ...addTimestamps(requestBody, true)
          };
          
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: updatedItem
          }));
          
          await createAuditLog(user, 'UPDATE', tableConfig.pk, { itemId });
          
          return createResponse(200, updatedItem);
        } catch (error) {
          return createResponse(400, { error: 'Invalid request body' });
        }
      }
      
      if (event.httpMethod === 'DELETE' && pathParts.length === 3) {
        if (!hasPermission(user, tableConfig.pk, 'delete')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        const itemId = pathParts[2];
        
        try {
          const existingItem = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: tableConfig.pk,
              sk: itemId
            }
          }));
          
          if (!existingItem.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: tableConfig.pk,
              sk: itemId
            }
          }));
          
          await createAuditLog(user, 'DELETE', tableConfig.pk, { itemId });
          
          return createResponse(200, { message: 'Item deleted successfully' });
        } catch (error) {
          return createResponse(500, { error: 'Internal server error' });
        }
      }
    }
    
    return createResponse(404, { error: 'Endpoint not found' });
    
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};