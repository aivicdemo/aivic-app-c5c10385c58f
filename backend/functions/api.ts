import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
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

async function createAuditLog(user: User, action: string, resource: string, details: any) {
  const auditItem = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.id,
    action,
    resource,
    details: JSON.stringify(details),
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
    
    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    let user: User;
    try {
      user = extractUserFromEvent(event);
    } catch (error) {
      return createResponse(401, { error: 'Unauthorized' });
    }

    // GET /resources
    if (method === 'GET' && path === '/resources') {
      if (!hasPermission(user, 'resources', 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      try {
        const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
          index,
          name: config.name,
          pk: config.pk
        }));
        
        return createResponse(200, { resources });
      } catch (error) {
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // Parse path for table operations
    const pathMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(\w+))?$/);
    if (!pathMatch) {
      return createResponse(404, { error: 'Not found' });
    }

    const [, tableIndex, operation, itemId] = pathMatch;
    
    if (!validateTableIndex(tableIndex)) {
      return createResponse(400, { error: 'Invalid table index' });
    }

    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const resourceName = tableConfig.name;

    // Bulk import endpoint
    if (method === 'POST' && operation === 'bulk') {
      if (!hasPermission(user, resourceName, 'bulk')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      try {
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
          const writeRequests = batch.map(item => {
            const processedItem = addTimestamps({
              ...item,
              pk: tableConfig.pk,
              sk: item.id || randomUUID(),
              id: item.id || randomUUID()
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
            imported += batch.length;
          } catch (error) {
            failed += batch.length;
            errors.push(`Batch ${Math.floor(i/25) + 1}: ${error}`);
          }
        }

        await createAuditLog(user, 'BULK_IMPORT', resourceName, {
          imported,
          failed,
          totalItems: items.length
        });

        return createResponse(200, { imported, failed, errors });
      } catch (error) {
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // List items
    if (method === 'GET' && !operation) {
      if (!hasPermission(user, resourceName, 'read')) {
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

    // Get single item
    if (method === 'GET' && operation && !itemId) {
      if (!hasPermission(user, resourceName, 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      try {
        const result = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.pk,
            sk: operation
          }
        }));

        if (!result.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        return createResponse(200, { item: result.Item });
      } catch (error) {
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // Create item
    if (method === 'POST' && !operation) {
      if (!hasPermission(user, resourceName, 'create')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      try {
        const body = JSON.parse(event.body || '{}');
        const id = body.id || randomUUID();
        
        const item = addTimestamps({
          ...body,
          pk: tableConfig.pk,
          sk: id,
          id,
          createdBy: user.id,
          updatedBy: user.id
        });

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        }));

        await createAuditLog(user, 'CREATE', resourceName, { id });

        return createResponse(201, { item });
      } catch (error) {
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // Update item
    if (method === 'PUT' && operation) {
      if (!hasPermission(user, resourceName, 'update')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      try {
        const body = JSON.parse(event.body || '{}');
        const updateData = addTimestamps({
          ...body,
          updatedBy: user.id
        }, true);

        // Remove pk, sk from update data
        delete updateData.pk;
        delete updateData.sk;
        delete updateData.id;

        const updateExpression = 'SET ' + Object.keys(updateData)
          .map(key => `#${key} = :${key}`)
          .join(', ');
        
        const expressionAttributeNames = Object.keys(updateData)
          .reduce((acc, key) => ({ ...acc, [`#${key}`]: key }), {});
        
        const expressionAttributeValues = Object.entries(updateData)
          .reduce((acc, [key, value]) => ({ ...acc, [`:${key}`]: value }), {});

        await docClient.send(new UpdateCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.pk,
            sk: operation
          },
          UpdateExpression: updateExpression,
          ExpressionAttributeNames: expressionAttributeNames,
          ExpressionAttributeValues: expressionAttributeValues,
          ReturnValues: 'ALL_NEW'
        }));

        await createAuditLog(user, 'UPDATE', resourceName, { id: operation });

        return createResponse(200, { message: 'Item updated successfully' });
      } catch (error) {
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // Delete item
    if (method === 'DELETE' && operation) {
      if (!hasPermission(user, resourceName, 'delete')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      try {
        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.pk,
            sk: operation
          }
        }));

        await createAuditLog(user, 'DELETE', resourceName, { id: operation });

        return createResponse(200, { message: 'Item deleted successfully' });
      } catch (error) {
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    return createResponse(404, { error: 'Not found' });
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};