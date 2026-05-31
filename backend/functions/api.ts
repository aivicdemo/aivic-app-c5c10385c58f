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

function validateRequired(item: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (!item[field]) {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

function addTimestamps(item: any, isUpdate: boolean = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

async function handleBulkImport(event: APIGatewayEvent, tableIndex: string, user: User): Promise<APIGatewayResponse> {
  if (!hasPermission(user, 'bulk', 'bulk')) {
    return createResponse(403, { error: 'Insufficient permissions for bulk import' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  let requestBody;
  try {
    requestBody = JSON.parse(event.body || '{}');
  } catch (error) {
    return createResponse(400, { error: 'Invalid JSON in request body' });
  }

  const { items } = requestBody;
  if (!Array.isArray(items)) {
    return createResponse(400, { error: 'items must be an array' });
  }

  let imported = 0;
  let failed = 0;
  const errors: string[] = [];

  // Process in batches of 25 (DynamoDB BatchWrite limit)
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25);
    const putRequests = batch.map(item => {
      const processedItem = {
        ...item,
        pk: config.pk,
        sk: item.id || crypto.randomUUID(),
        id: item.id || crypto.randomUUID(),
        ...addTimestamps(item, false)
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

  await writeAuditLog(user, 'BULK_IMPORT', config.name, { imported, failed, total: items.length });

  return createResponse(200, { imported, failed, errors });
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

    // Handle /resources endpoint
    if (path === 'resources' && event.httpMethod === 'GET') {
      if (!hasPermission(user, 'resources', 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        id: index,
        name: config.name,
        pk: config.pk
      }));

      return createResponse(200, { resources });
    }

    // Handle table-specific operations
    if (pathParts.length >= 2) {
      const tableIndex = pathParts[0];
      const operation = pathParts[1];
      const itemId = pathParts[2];

      const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      if (!config) {
        return createResponse(404, { error: 'Table not found' });
      }

      // Handle bulk import
      if (operation === 'bulk' && event.httpMethod === 'POST') {
        return await handleBulkImport(event, tableIndex, user);
      }

      // Handle CRUD operations
      switch (event.httpMethod) {
        case 'GET':
          if (!hasPermission(user, config.pk, 'read')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          if (itemId) {
            // Get single item
            const result = await docClient.send(new GetCommand({
              TableName: TABLE_NAME,
              Key: { pk: config.pk, sk: itemId }
            }));

            if (!result.Item) {
              return createResponse(404, { error: 'Item not found' });
            }

            return createResponse(200, result.Item);
          } else {
            // List items
            const result = await docClient.send(new ScanCommand({
              TableName: TABLE_NAME,
              FilterExpression: 'pk = :pk',
              ExpressionAttributeValues: { ':pk': config.pk }
            }));

            return createResponse(200, { items: result.Items || [] });
          }

        case 'POST':
          if (!hasPermission(user, config.pk, 'create')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          let createBody;
          try {
            createBody = JSON.parse(event.body || '{}');
          } catch (error) {
            return createResponse(400, { error: 'Invalid JSON' });
          }

          const newItem = {
            ...createBody,
            pk: config.pk,
            sk: createBody.id || crypto.randomUUID(),
            id: createBody.id || crypto.randomUUID(),
            ...addTimestamps(createBody, false)
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: newItem
          }));

          await writeAuditLog(user, 'CREATE', config.name, { id: newItem.id });

          return createResponse(201, newItem);

        case 'PUT':
          if (!itemId) {
            return createResponse(400, { error: 'Item ID required for update' });
          }

          if (!hasPermission(user, config.pk, 'update')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          let updateBody;
          try {
            updateBody = JSON.parse(event.body || '{}');
          } catch (error) {
            return createResponse(400, { error: 'Invalid JSON' });
          }

          // Check if item exists
          const existingItem = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: config.pk, sk: itemId }
          }));

          if (!existingItem.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          const updatedItem = {
            ...existingItem.Item,
            ...updateBody,
            pk: config.pk,
            sk: itemId,
            id: itemId,
            ...addTimestamps(updateBody, true)
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: updatedItem
          }));

          await writeAuditLog(user, 'UPDATE', config.name, { id: itemId });

          return createResponse(200, updatedItem);

        case 'DELETE':
          if (!itemId) {
            return createResponse(400, { error: 'Item ID required for delete' });
          }

          if (!hasPermission(user, config.pk, 'delete')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }

          // Check if item exists
          const itemToDelete = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: config.pk, sk: itemId }
          }));

          if (!itemToDelete.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { pk: config.pk, sk: itemId }
          }));

          await writeAuditLog(user, 'DELETE', config.name, { id: itemId });

          return createResponse(200, { message: 'Item deleted successfully' });

        default:
          return createResponse(405, { error: 'Method not allowed' });
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });

  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};