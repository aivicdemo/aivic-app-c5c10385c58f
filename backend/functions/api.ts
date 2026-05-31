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
  '7': { name: '発注推奨', pk: 'ORDER_RECOMMEND' },
  '8': { name: '商品提案情報', pk: 'PRODUCT_PROPOSAL' },
  '9': { name: '顧客マスタ', pk: 'CUSTOMER' },
  '10': { name: 'ペット情報', pk: 'PET' },
  '11': { name: '顧客利用履歴', pk: 'CUSTOMER_HISTORY' },
  '12': { name: '需要予測', pk: 'DEMAND_FORECAST' },
  '13': { name: '発注履歴', pk: 'ORDER_HISTORY' },
  '14': { name: '在庫調整履歴', pk: 'INVENTORY_ADJUSTMENT' }
};

interface ApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function createResponse(statusCode: number, body: any): ApiResponse {
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

async function createAuditLog(user: User, action: string, resource: string, details: any) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.userId,
    action,
    resource,
    details,
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
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

export const handler = async (event: any): Promise<ApiResponse> => {
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

    const path = event.path || event.rawPath || '';
    const method = event.httpMethod || event.requestContext?.http?.method || '';
    const pathParts = path.split('/').filter(Boolean);

    if (path === '/resources' && method === 'GET') {
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

    if (pathParts.length >= 2 && pathParts[0] === 'api') {
      const tableIndex = pathParts[1];
      const itemId = pathParts[2];
      const action = pathParts[3];

      if (!validateTableIndex(tableIndex)) {
        return createResponse(404, { error: 'Table not found' });
      }

      const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      const pk = tableConfig.pk;

      if (method === 'GET' && !itemId) {
        if (!hasPermission(user, tableConfig.name, 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const command = new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: {
            ':pk': pk
          }
        });

        const result = await docClient.send(command);
        return createResponse(200, { items: result.Items || [] });
      }

      if (method === 'GET' && itemId) {
        if (!hasPermission(user, tableConfig.name, 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const command = new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: pk,
            sk: itemId
          }
        });

        const result = await docClient.send(command);
        if (!result.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        return createResponse(200, result.Item);
      }

      if (method === 'POST' && !itemId) {
        if (!hasPermission(user, tableConfig.name, 'create')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const body = JSON.parse(event.body || '{}');
        const id = randomUUID();
        const item = {
          pk: pk,
          sk: id,
          id: id,
          ...body,
          createdBy: user.userId,
          updatedBy: user.userId
        };

        addTimestamps(item);

        const command = new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        });

        await docClient.send(command);
        await createAuditLog(user, 'CREATE', tableConfig.name, { id });

        return createResponse(201, item);
      }

      if (method === 'POST' && action === 'bulk') {
        if (!hasPermission(user, tableConfig.name, 'bulk')) {
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
            const id = randomUUID();
            const processedItem = {
              pk: pk,
              sk: id,
              id: id,
              ...item,
              createdBy: user.userId,
              updatedBy: user.userId
            };
            addTimestamps(processedItem);

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
            imported += chunk.length;
          } catch (error) {
            failed += chunk.length;
            errors.push(`Batch write failed: ${error}`);
          }
        }

        await createAuditLog(user, 'BULK_IMPORT', tableConfig.name, { imported, failed });

        return createResponse(200, { imported, failed, errors });
      }

      if (method === 'PUT' && itemId) {
        if (!hasPermission(user, tableConfig.name, 'update')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const body = JSON.parse(event.body || '{}');
        
        const getCommand = new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: pk,
            sk: itemId
          }
        });

        const existingItem = await docClient.send(getCommand);
        if (!existingItem.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        const updatedItem = {
          ...existingItem.Item,
          ...body,
          updatedBy: user.userId
        };

        addTimestamps(updatedItem, true);

        const putCommand = new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        });

        await docClient.send(putCommand);
        await createAuditLog(user, 'UPDATE', tableConfig.name, { id: itemId });

        return createResponse(200, updatedItem);
      }

      if (method === 'DELETE' && itemId) {
        if (!hasPermission(user, tableConfig.name, 'delete')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const command = new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: pk,
            sk: itemId
          }
        });

        await docClient.send(command);
        await createAuditLog(user, 'DELETE', tableConfig.name, { id: itemId });

        return createResponse(200, { message: 'Item deleted successfully' });
      }
    }

    return createResponse(404, { error: 'Not found' });

  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};