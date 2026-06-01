import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

const tableConfigs = {
  0: { name: 'ログインユーザー', pk: 'USER' },
  1: { name: '商品マスタ', pk: 'PRODUCT' },
  2: { name: '仕入先マスタ', pk: 'SUPPLIER' },
  3: { name: '在庫管理', pk: 'INVENTORY' },
  4: { name: '仕入実績', pk: 'PURCHASE' },
  5: { name: '売上実績', pk: 'SALES' },
  6: { name: '月次集計', pk: 'MONTHLY' },
  7: { name: '発注推奨', pk: 'ORDER_RECOMMEND' },
  8: { name: '商品提案情報', pk: 'PRODUCT_PROPOSAL' },
  9: { name: '顧客マスタ', pk: 'CUSTOMER' },
  10: { name: 'ペット情報', pk: 'PET' },
  11: { name: '顧客利用履歴', pk: 'CUSTOMER_HISTORY' },
  12: { name: '需要予測', pk: 'DEMAND_FORECAST' },
  13: { name: '発注履歴', pk: 'ORDER_HISTORY' },
  14: { name: '在庫調整履歴', pk: 'INVENTORY_ADJUSTMENT' }
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

async function writeAuditLog(user: User, action: string, resource: string, details: any = {}) {
  const auditItem = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.id,
    action,
    resource,
    details,
    timestamp: new Date().toISOString()
  };
  
  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: auditItem
    }));
  } catch (error) {
    console.error('Failed to write audit log:', error);
  }
}

function addTimestamps(item: any, isUpdate = false) {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

function validateRequired(item: any, requiredFields: string[]) {
  const missing = requiredFields.filter(field => !item[field]);
  if (missing.length > 0) {
    throw new Error(`Required fields missing: ${missing.join(', ')}`);
  }
}

export const handler = async (event: any) => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const user = extractUserFromEvent(event);
    const path = event.path || event.rawPath || '';
    const method = event.httpMethod || event.requestContext?.http?.method || 'GET';
    const pathParams = event.pathParameters || {};
    
    // GET /resources
    if (method === 'GET' && path === '/resources') {
      if (!hasPermission(user, 'resources', 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      try {
        const resources = Object.entries(tableConfigs).map(([index, config]) => ({
          index: parseInt(index),
          name: config.name,
          pk: config.pk
        }));
        
        return createResponse(200, { resources });
      } catch (error) {
        console.error('Error fetching resources:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // Parse table index from path
    const tableMatch = path.match(/\/api\/(\d+)/);
    if (!tableMatch) {
      return createResponse(404, { error: 'Invalid path' });
    }

    const tableIndex = parseInt(tableMatch[1]);
    const config = tableConfigs[tableIndex as keyof typeof tableConfigs];
    if (!config) {
      return createResponse(404, { error: 'Table not found' });
    }

    const resourceName = config.name;
    const pk = config.pk;

    // Bulk import endpoint
    if (method === 'POST' && path.includes('/bulk')) {
      if (!hasPermission(user, resourceName, 'bulk')) {
        return createResponse(403, { error: 'Insufficient permissions for bulk operations' });
      }

      const body = JSON.parse(event.body || '{}');
      const items = body.items || [];
      
      if (!Array.isArray(items)) {
        return createResponse(400, { error: 'Items must be an array' });
      }

      let imported = 0;
      let failed = 0;
      const errors: string[] = [];

      // Process in batches of 25 (DynamoDB limit)
      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        const writeRequests = batch.map(item => {
          try {
            const processedItem = {
              ...item,
              pk,
              sk: item.id || randomUUID(),
              id: item.id || randomUUID()
            };
            addTimestamps(processedItem);
            
            return {
              PutRequest: {
                Item: processedItem
              }
            };
          } catch (error) {
            failed++;
            errors.push(`Item ${i}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return null;
          }
        }).filter(Boolean);

        if (writeRequests.length > 0) {
          try {
            await docClient.send(new BatchWriteCommand({
              RequestItems: {
                [TABLE_NAME]: writeRequests
              }
            }));
            imported += writeRequests.length;
          } catch (error) {
            failed += writeRequests.length;
            errors.push(`Batch ${Math.floor(i/25)}: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }
      }

      await writeAuditLog(user, 'BULK_IMPORT', resourceName, { imported, failed, totalItems: items.length });
      
      return createResponse(200, { imported, failed, errors });
    }

    // List items
    if (method === 'GET' && !pathParams.id) {
      if (!hasPermission(user, resourceName, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      try {
        const result = await docClient.send(new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: 'pk = :pk',
          ExpressionAttributeValues: {
            ':pk': pk
          }
        }));
        
        return createResponse(200, { items: result.Items || [] });
      } catch (error) {
        console.error('Error scanning items:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // Get single item
    if (method === 'GET' && pathParams.id) {
      if (!hasPermission(user, resourceName, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      try {
        const result = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk,
            sk: pathParams.id
          }
        }));
        
        if (!result.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        return createResponse(200, result.Item);
      } catch (error) {
        console.error('Error getting item:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // Create item
    if (method === 'POST' && !path.includes('/bulk')) {
      if (!hasPermission(user, resourceName, 'create')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      try {
        const body = JSON.parse(event.body || '{}');
        const id = body.id || randomUUID();
        
        const item = {
          ...body,
          pk,
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
        
        await writeAuditLog(user, 'CREATE', resourceName, { id });
        
        return createResponse(201, item);
      } catch (error) {
        console.error('Error creating item:', error);
        if (error instanceof SyntaxError) {
          return createResponse(400, { error: 'Invalid JSON' });
        }
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // Update item
    if (method === 'PUT' && pathParams.id) {
      if (!hasPermission(user, resourceName, 'update')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      try {
        const body = JSON.parse(event.body || '{}');
        
        // Check if item exists
        const existing = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk,
            sk: pathParams.id
          }
        }));
        
        if (!existing.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        const item = {
          ...existing.Item,
          ...body,
          pk,
          sk: pathParams.id,
          id: pathParams.id,
          updatedBy: user.id
        };
        
        addTimestamps(item, true);
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        }));
        
        await writeAuditLog(user, 'UPDATE', resourceName, { id: pathParams.id });
        
        return createResponse(200, item);
      } catch (error) {
        console.error('Error updating item:', error);
        if (error instanceof SyntaxError) {
          return createResponse(400, { error: 'Invalid JSON' });
        }
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // Delete item
    if (method === 'DELETE' && pathParams.id) {
      if (!hasPermission(user, resourceName, 'delete')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      try {
        // Check if item exists
        const existing = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk,
            sk: pathParams.id
          }
        }));
        
        if (!existing.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            pk,
            sk: pathParams.id
          }
        }));
        
        await writeAuditLog(user, 'DELETE', resourceName, { id: pathParams.id });
        
        return createResponse(200, { message: 'Item deleted successfully' });
      } catch (error) {
        console.error('Error deleting item:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });
    
  } catch (error) {
    console.error('Handler error:', error);
    if (error instanceof Error && error.message === 'Authorization header required') {
      return createResponse(401, { error: 'Unauthorized' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
};