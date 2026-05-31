import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
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
  '14': { name: '在庫調整履歴', pk: 'INV_ADJ' }
};

interface APIGatewayEvent {
  httpMethod: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  body?: string;
  headers?: { [key: string]: string };
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

async function writeAuditLog(user: User, action: string, resource: string, details: any = {}) {
  const auditRecord = {
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
    Item: auditRecord
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
  const result = { ...item };
  
  if (!isUpdate) {
    result.createdAt = now;
  }
  result.updatedAt = now;
  
  return result;
}

function generateId(): string {
  return randomUUID();
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

    if (pathParts[0] === 'api' && pathParts.length >= 2) {
      const tableIndex = validateTableIndex(pathParts[1]);
      const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      const resourceName = config.name;
      
      if (pathParts.length >= 3 && pathParts[2] === 'bulk') {
        if (event.httpMethod !== 'POST') {
          return createResponse(405, { error: 'Method not allowed' });
        }
        
        if (!hasPermission(user, resourceName, 'bulk')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        if (!event.body) {
          return createResponse(400, { error: 'Request body required' });
        }
        
        const { items } = JSON.parse(event.body);
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
              sk: item.id || generateId()
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
        
        await writeAuditLog(user, 'BULK_IMPORT', resourceName, { imported, failed });
        
        return createResponse(200, { imported, failed, errors });
      }
      
      const itemId = pathParts[2];
      
      switch (event.httpMethod) {
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
          
          if (!event.body) {
            return createResponse(400, { error: 'Request body required' });
          }
          
          const createData = JSON.parse(event.body);
          const newItem = addTimestamps({
            ...createData,
            pk: config.pk,
            sk: generateId(),
            createdBy: user.id,
            updatedBy: user.id
          });
          
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: newItem
          }));
          
          await writeAuditLog(user, 'CREATE', resourceName, { itemId: newItem.sk });
          
          return createResponse(201, newItem);
          
        case 'PUT':
          if (!itemId) {
            return createResponse(400, { error: 'Item ID required' });
          }
          
          if (!hasPermission(user, resourceName, 'update')) {
            return createResponse(403, { error: 'Forbidden' });
          }
          
          if (!event.body) {
            return createResponse(400, { error: 'Request body required' });
          }
          
          const updateData = JSON.parse(event.body);
          const updatedItem = addTimestamps({
            ...updateData,
            pk: config.pk,
            sk: itemId,
            updatedBy: user.id
          }, true);
          
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: updatedItem
          }));
          
          await writeAuditLog(user, 'UPDATE', resourceName, { itemId });
          
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
          
          await writeAuditLog(user, 'DELETE', resourceName, { itemId });
          
          return createResponse(204, {});
          
        default:
          return createResponse(405, { error: 'Method not allowed' });
      }
    }
    
    return createResponse(404, { error: 'Not found' });
    
  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};