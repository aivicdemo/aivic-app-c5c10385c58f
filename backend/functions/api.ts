import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
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

function validateTableIndex(tableIndex: string): boolean {
  return tableIndex in TABLE_CONFIGS;
}

function addTimestamps(item: any, isUpdate: boolean = false): any {
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

    if (pathParts.length < 1) {
      return createResponse(400, { error: 'Invalid path' });
    }

    const tableIndex = pathParts[0];
    if (!validateTableIndex(tableIndex)) {
      return createResponse(404, { error: 'Table not found' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const isBulkOperation = pathParts[1] === 'bulk';
    const itemId = pathParts[1] && !isBulkOperation ? pathParts[1] : null;

    switch (event.httpMethod) {
      case 'GET':
        if (!hasPermission(user, config.pk, 'read')) {
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
          const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit) : 100;
          const lastKey = event.queryStringParameters?.lastKey;
          
          const scanParams: any = {
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: { ':pk': config.pk },
            Limit: Math.min(limit, 1000)
          };
          
          if (lastKey) {
            try {
              scanParams.ExclusiveStartKey = JSON.parse(Buffer.from(lastKey, 'base64').toString());
            } catch (e) {
              return createResponse(400, { error: 'Invalid lastKey' });
            }
          }
          
          const result = await docClient.send(new ScanCommand(scanParams));
          
          const response: any = {
            items: result.Items || [],
            count: result.Count || 0
          };
          
          if (result.LastEvaluatedKey) {
            response.lastKey = Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64');
          }
          
          return createResponse(200, response);
        }

      case 'POST':
        if (isBulkOperation) {
          if (!hasPermission(user, config.pk, 'bulk')) {
            return createResponse(403, { error: 'Forbidden' });
          }
          
          const body = JSON.parse(event.body || '{}');
          if (!body.items || !Array.isArray(body.items)) {
            return createResponse(400, { error: 'Invalid request body. Expected { items: [] }' });
          }
          
          let imported = 0;
          let failed = 0;
          const errors: string[] = [];
          
          const chunks = [];
          for (let i = 0; i < body.items.length; i += 25) {
            chunks.push(body.items.slice(i, i + 25));
          }
          
          for (const chunk of chunks) {
            const writeRequests = chunk.map((item: any) => {
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
          
          await writeAuditLog(user, 'BULK_IMPORT', config.pk, { imported, failed });
          
          return createResponse(200, { imported, failed, errors });
        } else {
          if (!hasPermission(user, config.pk, 'create')) {
            return createResponse(403, { error: 'Forbidden' });
          }
          
          const body = JSON.parse(event.body || '{}');
          const id = body.id || randomUUID();
          
          const item = {
            ...body,
            pk: config.pk,
            sk: id,
            ...addTimestamps(body)
          };
          
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: item
          }));
          
          await writeAuditLog(user, 'CREATE', config.pk, { id });
          
          return createResponse(201, item);
        }

      case 'PUT':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID required for update' });
        }
        
        if (!hasPermission(user, config.pk, 'update')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        const updateBody = JSON.parse(event.body || '{}');
        const updateItem = {
          ...updateBody,
          pk: config.pk,
          sk: itemId,
          ...addTimestamps(updateBody, true)
        };
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updateItem
        }));
        
        await writeAuditLog(user, 'UPDATE', config.pk, { id: itemId });
        
        return createResponse(200, updateItem);

      case 'DELETE':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID required for delete' });
        }
        
        if (!hasPermission(user, config.pk, 'delete')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { pk: config.pk, sk: itemId }
        }));
        
        await writeAuditLog(user, 'DELETE', config.pk, { id: itemId });
        
        return createResponse(200, { message: 'Item deleted successfully' });

      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};