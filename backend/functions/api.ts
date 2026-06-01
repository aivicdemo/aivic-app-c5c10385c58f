import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
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
  const auditLog = {
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
    Item: auditLog
  }));
}

function validateTableIndex(tableIndex: string): boolean {
  return tableIndex in tableConfigs;
}

function addTimestamps(item: any, isUpdate: boolean = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
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
      
      const resources = Object.entries(tableConfigs).map(([index, config]) => ({
        index,
        name: config.name,
        pk: config.pk
      }));
      
      return createResponse(200, { resources });
    }

    if (pathParts[0] === 'api' && pathParts.length >= 2) {
      const tableIndex = pathParts[1];
      
      if (!validateTableIndex(tableIndex)) {
        return createResponse(404, { error: 'Table not found' });
      }

      const tableConfig = tableConfigs[tableIndex as keyof typeof tableConfigs];
      const method = event.httpMethod;

      if (pathParts.length === 3 && pathParts[2] === 'bulk' && method === 'POST') {
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

          const chunks = [];
          for (let i = 0; i < items.length; i += 25) {
            chunks.push(items.slice(i, i + 25));
          }

          for (const chunk of chunks) {
            const writeRequests = chunk.map(item => {
              const processedItem = {
                ...item,
                pk: tableConfig.pk,
                sk: item.id || generateId(),
                id: item.id || generateId()
              };
              addTimestamps(processedItem, false);
              
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

          await writeAuditLog(user, 'BULK_IMPORT', tableConfig.pk, { imported, failed });
          
          return createResponse(200, { imported, failed, errors });
        } catch (error) {
          return createResponse(400, { error: 'Invalid request body' });
        }
      }

      switch (method) {
        case 'GET':
          if (!hasPermission(user, tableConfig.pk, 'read')) {
            return createResponse(403, { error: 'Forbidden' });
          }

          if (pathParts.length === 3) {
            const id = pathParts[2];
            try {
              const result = await docClient.send(new GetCommand({
                TableName: TABLE_NAME,
                Key: { pk: tableConfig.pk, sk: id }
              }));
              
              if (!result.Item) {
                return createResponse(404, { error: 'Item not found' });
              }
              
              return createResponse(200, result.Item);
            } catch (error) {
              return createResponse(500, { error: 'Internal server error' });
            }
          } else {
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

        case 'POST':
          if (!hasPermission(user, tableConfig.pk, 'create')) {
            return createResponse(403, { error: 'Forbidden' });
          }

          try {
            const requestBody = JSON.parse(event.body || '{}');
            const id = generateId();
            const item = {
              ...requestBody,
              pk: tableConfig.pk,
              sk: id,
              id,
              createdBy: user.id,
              updatedBy: user.id
            };
            addTimestamps(item, false);

            await docClient.send(new PutCommand({
              TableName: TABLE_NAME,
              Item: item
            }));

            await writeAuditLog(user, 'CREATE', tableConfig.pk, { id });
            
            return createResponse(201, item);
          } catch (error) {
            return createResponse(400, { error: 'Invalid request body' });
          }

        case 'PUT':
          if (!hasPermission(user, tableConfig.pk, 'update')) {
            return createResponse(403, { error: 'Forbidden' });
          }

          if (pathParts.length !== 3) {
            return createResponse(400, { error: 'ID required for update' });
          }

          const updateId = pathParts[2];
          try {
            const requestBody = JSON.parse(event.body || '{}');
            
            const existingItem = await docClient.send(new GetCommand({
              TableName: TABLE_NAME,
              Key: { pk: tableConfig.pk, sk: updateId }
            }));

            if (!existingItem.Item) {
              return createResponse(404, { error: 'Item not found' });
            }

            const updatedItem = {
              ...existingItem.Item,
              ...requestBody,
              pk: tableConfig.pk,
              sk: updateId,
              id: updateId,
              updatedBy: user.id
            };
            addTimestamps(updatedItem, true);

            await docClient.send(new PutCommand({
              TableName: TABLE_NAME,
              Item: updatedItem
            }));

            await writeAuditLog(user, 'UPDATE', tableConfig.pk, { id: updateId });
            
            return createResponse(200, updatedItem);
          } catch (error) {
            return createResponse(400, { error: 'Invalid request body' });
          }

        case 'DELETE':
          if (!hasPermission(user, tableConfig.pk, 'delete')) {
            return createResponse(403, { error: 'Forbidden' });
          }

          if (pathParts.length !== 3) {
            return createResponse(400, { error: 'ID required for delete' });
          }

          const deleteId = pathParts[2];
          try {
            const existingItem = await docClient.send(new GetCommand({
              TableName: TABLE_NAME,
              Key: { pk: tableConfig.pk, sk: deleteId }
            }));

            if (!existingItem.Item) {
              return createResponse(404, { error: 'Item not found' });
            }

            await docClient.send(new DeleteCommand({
              TableName: TABLE_NAME,
              Key: { pk: tableConfig.pk, sk: deleteId }
            }));

            await writeAuditLog(user, 'DELETE', tableConfig.pk, { id: deleteId });
            
            return createResponse(200, { message: 'Item deleted successfully' });
          } catch (error) {
            return createResponse(500, { error: 'Internal server error' });
          }

        default:
          return createResponse(405, { error: 'Method not allowed' });
      }
    }

    return createResponse(404, { error: 'Not found' });
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};