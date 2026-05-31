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

interface APIGatewayEvent {
  httpMethod: string;
  pathParameters: any;
  queryStringParameters: any;
  body: string | null;
  headers: any;
}

interface APIGatewayResponse {
  statusCode: number;
  headers: any;
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
    userId: user.userId,
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

function validateRequired(data: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (!data[field]) {
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

async function handleBulkImport(event: APIGatewayEvent, tableIndex: string): Promise<APIGatewayResponse> {
  try {
    const user = extractUserFromEvent(event);
    
    if (!hasPermission(user, 'bulk', 'bulk')) {
      return createResponse(403, { error: 'Insufficient permissions for bulk import' });
    }

    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }

    const body = JSON.parse(event.body || '{}');
    const items = body.items || [];
    
    if (!Array.isArray(items)) {
      return createResponse(400, { error: 'items must be an array' });
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
          pk: tableConfig.pk,
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
        imported += batch.length;
      } catch (error) {
        failed += batch.length;
        errors.push(`Batch ${Math.floor(i/25) + 1}: ${error}`);
      }
    }

    await writeAuditLog(user, 'BULK_IMPORT', tableConfig.name, { imported, failed, total: items.length });

    return createResponse(200, { imported, failed, errors });
  } catch (error) {
    return createResponse(500, { error: error instanceof Error ? error.message : 'Internal server error' });
  }
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    // Handle /resources endpoint
    if (event.pathParameters?.proxy === 'resources' && event.httpMethod === 'GET') {
      try {
        const user = extractUserFromEvent(event);
        
        if (!hasPermission(user, 'resources', 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
          index,
          name: config.name,
          pk: config.pk
        }));

        return createResponse(200, { resources });
      } catch (error) {
        return createResponse(401, { error: 'Authentication failed' });
      }
    }

    // Parse path for table operations
    const pathParts = (event.pathParameters?.proxy || '').split('/');
    const tableIndex = pathParts[0];
    const operation = pathParts[1];
    const itemId = pathParts[2];

    // Handle bulk import
    if (operation === 'bulk' && event.httpMethod === 'POST') {
      return await handleBulkImport(event, tableIndex);
    }

    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }

    const user = extractUserFromEvent(event);

    switch (event.httpMethod) {
      case 'GET':
        if (!hasPermission(user, tableConfig.pk, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (itemId) {
          // Get single item
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: tableConfig.pk, sk: itemId }
          }));
          
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, result.Item);
        } else {
          // List items
          const limit = parseInt(event.queryStringParameters?.limit || '50');
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: { ':pk': tableConfig.pk },
            Limit: limit
          }));
          
          return createResponse(200, { items: result.Items || [], count: result.Count });
        }

      case 'POST':
        if (!hasPermission(user, tableConfig.pk, 'create')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const createData = JSON.parse(event.body || '{}');
        const createErrors = validateRequired(createData, ['name']);
        if (createErrors.length > 0) {
          return createResponse(400, { errors: createErrors });
        }

        const newItem = {
          ...createData,
          pk: tableConfig.pk,
          sk: createData.id || randomUUID(),
          createdBy: user.userId,
          updatedBy: user.userId,
          ...addTimestamps(createData)
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: newItem
        }));

        await writeAuditLog(user, 'CREATE', tableConfig.name, { itemId: newItem.sk });
        return createResponse(201, newItem);

      case 'PUT':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID required for update' });
        }

        if (!hasPermission(user, tableConfig.pk, 'update')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        const updateData = JSON.parse(event.body || '{}');
        const updateErrors = validateRequired(updateData, ['name']);
        if (updateErrors.length > 0) {
          return createResponse(400, { errors: updateErrors });
        }

        // Check if item exists
        const existingItem = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk: tableConfig.pk, sk: itemId }
        }));

        if (!existingItem.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        const updatedItem = {
          ...existingItem.Item,
          ...updateData,
          updatedBy: user.userId,
          ...addTimestamps(updateData, true)
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));

        await writeAuditLog(user, 'UPDATE', tableConfig.name, { itemId });
        return createResponse(200, updatedItem);

      case 'DELETE':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID required for delete' });
        }

        if (!hasPermission(user, tableConfig.pk, 'delete')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        // Check if item exists
        const itemToDelete = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk: tableConfig.pk, sk: itemId }
        }));

        if (!itemToDelete.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { pk: tableConfig.pk, sk: itemId }
        }));

        await writeAuditLog(user, 'DELETE', tableConfig.name, { itemId });
        return createResponse(200, { message: 'Item deleted successfully' });

      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Authorization')) {
      return createResponse(401, { error: 'Authentication failed' });
    }
    return createResponse(500, { error: error instanceof Error ? error.message : 'Internal server error' });
  }
};