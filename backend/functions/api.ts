import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { User, checkPermission } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface TableConfig {
  pk: string;
  sk?: string;
  name: string;
}

const TABLE_CONFIGS: Record<string, TableConfig> = {
  '0': { pk: 'LOGIN_USER', name: 'ログインユーザー' },
  '1': { pk: 'PRODUCT', name: '商品マスタ' },
  '2': { pk: 'SUPPLIER', name: '仕入先マスタ' },
  '3': { pk: 'INVENTORY', name: '在庫管理' },
  '4': { pk: 'PURCHASE_RECORD', name: '仕入実績' },
  '5': { pk: 'SALES_RECORD', name: '売上実績' },
  '6': { pk: 'MONTHLY_SUMMARY', name: '月次集計' },
  '7': { pk: 'ORDER_RECOMMENDATION', name: '発注推奨' },
  '8': { pk: 'PRODUCT_PROPOSAL', name: '商品提案情報' },
  '9': { pk: 'CUSTOMER', name: '顧客マスタ' },
  '10': { pk: 'PET_INFO', name: 'ペット情報' },
  '11': { pk: 'CUSTOMER_HISTORY', name: '顧客利用履歴' },
  '12': { pk: 'DEMAND_FORECAST', name: '需要予測' },
  '13': { pk: 'ORDER_HISTORY', name: '発注履歴' },
  '14': { pk: 'INVENTORY_ADJUSTMENT', name: '在庫調整履歴' }
};

function getCurrentUser(event: APIGatewayProxyEvent): User {
  const role = event.headers['x-user-role'] || 'viewer';
  const userId = event.headers['x-user-id'] || 'anonymous';
  return {
    id: userId,
    role: role as 'admin' | 'operator' | 'viewer'
  };
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
    details,
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditItem
  }));
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
      const config = TABLE_CONFIGS[tableIndex];
      
      if (!config) {
        return createResponse(404, { error: 'Table not found' });
      }

      if (pathParts.length === 3 && pathParts[2] === 'bulk' && method === 'POST') {
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
            const now = new Date().toISOString();
            const processedItem = {
              ...item,
              pk: config.pk,
              sk: item.sk || randomUUID(),
              id: item.id || randomUUID(),
              createdAt: now,
              updatedAt: now,
              createdBy: user.id,
              updatedBy: user.id
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
        
        await createAuditLog('BULK_IMPORT', config.name, user.id, { imported, failed });
        
        return createResponse(200, { imported, failed, errors });
      }

      if (pathParts.length === 2) {
        if (method === 'GET') {
          checkPermission(user, config.name, 'read');
          
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: {
              ':pk': config.pk
            }
          }));
          
          return createResponse(200, { items: result.Items || [] });
        }
        
        if (method === 'POST') {
          checkPermission(user, config.name, 'create');
          
          const body = JSON.parse(event.body || '{}');
          const now = new Date().toISOString();
          const id = randomUUID();
          
          const item = {
            ...body,
            pk: config.pk,
            sk: id,
            id,
            createdAt: now,
            updatedAt: now,
            createdBy: user.id,
            updatedBy: user.id
          };
          
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: item
          }));
          
          await createAuditLog('CREATE', config.name, user.id, { id });
          
          return createResponse(201, item);
        }
      }
      
      if (pathParts.length === 3) {
        const itemId = pathParts[2];
        
        if (method === 'GET') {
          checkPermission(user, config.name, 'read');
          
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: config.pk,
              sk: itemId
            }
          }));
          
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, result.Item);
        }
        
        if (method === 'PUT') {
          checkPermission(user, config.name, 'update');
          
          const body = JSON.parse(event.body || '{}');
          const now = new Date().toISOString();
          
          const item = {
            ...body,
            pk: config.pk,
            sk: itemId,
            id: itemId,
            updatedAt: now,
            updatedBy: user.id
          };
          
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: item
          }));
          
          await createAuditLog('UPDATE', config.name, user.id, { id: itemId });
          
          return createResponse(200, item);
        }
        
        if (method === 'DELETE') {
          checkPermission(user, config.name, 'delete');
          
          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: config.pk,
              sk: itemId
            }
          }));
          
          await createAuditLog('DELETE', config.name, user.id, { id: itemId });
          
          return createResponse(204, {});
        }
      }
    }
    
    return createResponse(404, { error: 'Endpoint not found' });
    
  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof Error && error.message.includes('Access denied')) {
      return createResponse(403, { error: error.message });
    }
    
    return createResponse(500, { error: 'Internal server error' });
  }
};