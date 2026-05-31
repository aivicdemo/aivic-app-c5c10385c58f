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
  '14': { name: '在庫調整履歴', pk: 'ADJUST_HIST' }
};

interface APIResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function createResponse(statusCode: number, body: any): APIResponse {
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
    console.error('Failed to create audit log:', error);
  }
}

function validateRequired(item: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (!item[field]) {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

function addTimestamps(item: any, isUpdate = false) {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

export const handler = async (event: any): Promise<APIResponse> => {
  try {
    const { httpMethod, pathParameters, body, resource } = event;
    const path = resource || event.requestContext?.resourcePath || '';
    
    if (httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    let user: User;
    try {
      user = extractUserFromEvent(event);
    } catch (error) {
      return createResponse(401, { error: 'Unauthorized' });
    }

    // GET /resources
    if (httpMethod === 'GET' && path === '/resources') {
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

    // Extract table index from path
    const tableMatch = path.match(/\/api\/(\d+)/);
    if (!tableMatch) {
      return createResponse(404, { error: 'Invalid endpoint' });
    }
    
    const tableIndex = tableMatch[1];
    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }

    const { pk } = tableConfig;

    // Bulk import endpoint
    if (httpMethod === 'POST' && path.includes('/bulk')) {
      if (!hasPermission(user, pk, 'bulk')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const requestBody = JSON.parse(body || '{}');
      const items = requestBody.items || [];
      
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
          const processedItem = {
            ...item,
            pk,
            sk: item.id || randomUUID(),
            id: item.id || randomUUID(),
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
          imported += batch.length;
        } catch (error) {
          failed += batch.length;
          errors.push(`Batch ${Math.floor(i/25) + 1}: ${error}`);
        }
      }

      await createAuditLog(user, 'BULK_IMPORT', pk, { imported, failed, total: items.length });
      
      return createResponse(200, { imported, failed, errors });
    }

    // List items
    if (httpMethod === 'GET' && !pathParameters?.id) {
      if (!hasPermission(user, pk, 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const command = new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'pk = :pk',
        ExpressionAttributeValues: {
          ':pk': pk
        }
      });

      const result = await docClient.send(command);
      return createResponse(200, { items: result.Items || [] });
    }

    // Get single item
    if (httpMethod === 'GET' && pathParameters?.id) {
      if (!hasPermission(user, pk, 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const command = new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk,
          sk: pathParameters.id
        }
      });

      const result = await docClient.send(command);
      if (!result.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      return createResponse(200, result.Item);
    }

    // Create item
    if (httpMethod === 'POST' && !path.includes('/bulk')) {
      if (!hasPermission(user, pk, 'create')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const requestBody = JSON.parse(body || '{}');
      const id = requestBody.id || randomUUID();
      
      // Basic validation
      const requiredFields = ['name'];
      const validationErrors = validateRequired(requestBody, requiredFields);
      if (validationErrors.length > 0) {
        return createResponse(400, { errors: validationErrors });
      }

      const item = {
        ...requestBody,
        pk,
        sk: id,
        id,
        createdBy: user.id,
        updatedBy: user.id,
        ...addTimestamps(requestBody)
      };

      const command = new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      });

      await docClient.send(command);
      await createAuditLog(user, 'CREATE', pk, { id });
      
      return createResponse(201, item);
    }

    // Update item
    if (httpMethod === 'PUT' && pathParameters?.id) {
      if (!hasPermission(user, pk, 'update')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const requestBody = JSON.parse(body || '{}');
      const id = pathParameters.id;

      // Check if item exists
      const getCommand = new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk, sk: id }
      });
      
      const existingItem = await docClient.send(getCommand);
      if (!existingItem.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      const updatedItem = {
        ...existingItem.Item,
        ...requestBody,
        pk,
        sk: id,
        id,
        updatedBy: user.id,
        ...addTimestamps(requestBody, true)
      };

      const putCommand = new PutCommand({
        TableName: TABLE_NAME,
        Item: updatedItem
      });

      await docClient.send(putCommand);
      await createAuditLog(user, 'UPDATE', pk, { id });
      
      return createResponse(200, updatedItem);
    }

    // Delete item
    if (httpMethod === 'DELETE' && pathParameters?.id) {
      if (!hasPermission(user, pk, 'delete')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const id = pathParameters.id;

      // Check if item exists
      const getCommand = new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk, sk: id }
      });
      
      const existingItem = await docClient.send(getCommand);
      if (!existingItem.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      const deleteCommand = new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { pk, sk: id }
      });

      await docClient.send(deleteCommand);
      await createAuditLog(user, 'DELETE', pk, { id });
      
      return createResponse(200, { message: 'Item deleted successfully' });
    }

    return createResponse(404, { error: 'Endpoint not found' });

  } catch (error) {
    console.error('API Error:', error);
    return createResponse(500, { 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};