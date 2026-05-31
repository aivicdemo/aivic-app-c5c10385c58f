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

function generateId(): string {
  return randomUUID();
}

async function handleGetResources(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  try {
    const user = extractUserFromEvent(event);
    
    if (!hasPermission(user, 'resources', 'read')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    const tableIndex = event.pathParameters?.tableIndex;
    if (!tableIndex || !validateTableIndex(tableIndex)) {
      return createResponse(400, { error: 'Invalid table index' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const id = event.pathParameters?.id;

    if (id) {
      // 詳細取得
      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: config.pk, sk: id }
      }));

      if (!result.Item) {
        return createResponse(404, { error: 'Resource not found' });
      }

      return createResponse(200, result.Item);
    } else {
      // 一覧取得
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
          scanParams.ExclusiveStartKey = JSON.parse(decodeURIComponent(lastKey));
        } catch (e) {
          return createResponse(400, { error: 'Invalid lastKey parameter' });
        }
      }

      const result = await docClient.send(new ScanCommand(scanParams));

      return createResponse(200, {
        items: result.Items || [],
        lastEvaluatedKey: result.LastEvaluatedKey ? encodeURIComponent(JSON.stringify(result.LastEvaluatedKey)) : null,
        count: result.Count || 0
      });
    }
  } catch (error: any) {
    console.error('Error in handleGetResources:', error);
    if (error.message === 'Authorization header required' || error.message === 'Invalid token') {
      return createResponse(401, { error: error.message });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handlePostResources(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  try {
    const user = extractUserFromEvent(event);
    const tableIndex = event.pathParameters?.tableIndex;
    
    if (!tableIndex || !validateTableIndex(tableIndex)) {
      return createResponse(400, { error: 'Invalid table index' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    // 一括インポートの場合
    if (event.pathParameters?.action === 'bulk') {
      if (!hasPermission(user, config.name, 'bulk')) {
        return createResponse(403, { error: 'Insufficient permissions for bulk import' });
      }

      if (!event.body) {
        return createResponse(400, { error: 'Request body required' });
      }

      let requestData;
      try {
        requestData = JSON.parse(event.body);
      } catch (e) {
        return createResponse(400, { error: 'Invalid JSON in request body' });
      }

      if (!requestData.items || !Array.isArray(requestData.items)) {
        return createResponse(400, { error: 'items array required in request body' });
      }

      let imported = 0;
      let failed = 0;
      const errors: string[] = [];

      // 25件ずつに分割してバッチ処理
      const batchSize = 25;
      for (let i = 0; i < requestData.items.length; i += batchSize) {
        const batch = requestData.items.slice(i, i + batchSize);
        const putRequests = batch.map((item: any) => {
          const processedItem = {
            ...item,
            pk: config.pk,
            sk: item.id || generateId(),
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
              [TABLE_NAME]: putRequests
            }
          }));
          imported += batch.length;
        } catch (error: any) {
          failed += batch.length;
          errors.push(`Batch ${Math.floor(i / batchSize) + 1}: ${error.message}`);
        }
      }

      await writeAuditLog(user, 'BULK_IMPORT', config.name, { imported, failed, total: requestData.items.length });

      return createResponse(200, { imported, failed, errors });
    }

    // 通常の作成処理
    if (!hasPermission(user, config.name, 'create')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    if (!event.body) {
      return createResponse(400, { error: 'Request body required' });
    }

    let item;
    try {
      item = JSON.parse(event.body);
    } catch (e) {
      return createResponse(400, { error: 'Invalid JSON in request body' });
    }

    const id = generateId();
    const processedItem = {
      ...item,
      pk: config.pk,
      sk: id,
      ...addTimestamps(item)
    };

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: processedItem
    }));

    await writeAuditLog(user, 'CREATE', config.name, { id });

    return createResponse(201, processedItem);
  } catch (error: any) {
    console.error('Error in handlePostResources:', error);
    if (error.message === 'Authorization header required' || error.message === 'Invalid token') {
      return createResponse(401, { error: error.message });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handlePutResources(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  try {
    const user = extractUserFromEvent(event);
    const tableIndex = event.pathParameters?.tableIndex;
    const id = event.pathParameters?.id;
    
    if (!tableIndex || !validateTableIndex(tableIndex)) {
      return createResponse(400, { error: 'Invalid table index' });
    }

    if (!id) {
      return createResponse(400, { error: 'Resource ID required' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    if (!hasPermission(user, config.name, 'update')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    if (!event.body) {
      return createResponse(400, { error: 'Request body required' });
    }

    let updateData;
    try {
      updateData = JSON.parse(event.body);
    } catch (e) {
      return createResponse(400, { error: 'Invalid JSON in request body' });
    }

    // 既存レコードの確認
    const existingItem = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: config.pk, sk: id }
    }));

    if (!existingItem.Item) {
      return createResponse(404, { error: 'Resource not found' });
    }

    const updatedItem = {
      ...existingItem.Item,
      ...updateData,
      pk: config.pk,
      sk: id,
      ...addTimestamps(updateData, true)
    };

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedItem
    }));

    await writeAuditLog(user, 'UPDATE', config.name, { id });

    return createResponse(200, updatedItem);
  } catch (error: any) {
    console.error('Error in handlePutResources:', error);
    if (error.message === 'Authorization header required' || error.message === 'Invalid token') {
      return createResponse(401, { error: error.message });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDeleteResources(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  try {
    const user = extractUserFromEvent(event);
    const tableIndex = event.pathParameters?.tableIndex;
    const id = event.pathParameters?.id;
    
    if (!tableIndex || !validateTableIndex(tableIndex)) {
      return createResponse(400, { error: 'Invalid table index' });
    }

    if (!id) {
      return createResponse(400, { error: 'Resource ID required' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    if (!hasPermission(user, config.name, 'delete')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    // 既存レコードの確認
    const existingItem = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: config.pk, sk: id }
    }));

    if (!existingItem.Item) {
      return createResponse(404, { error: 'Resource not found' });
    }

    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { pk: config.pk, sk: id }
    }));

    await writeAuditLog(user, 'DELETE', config.name, { id });

    return createResponse(200, { message: 'Resource deleted successfully' });
  } catch (error: any) {
    console.error('Error in handleDeleteResources:', error);
    if (error.message === 'Authorization header required' || error.message === 'Invalid token') {
      return createResponse(401, { error: error.message });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
}

export async function handler(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  console.log('Event:', JSON.stringify(event, null, 2));

  if (event.httpMethod === 'OPTIONS') {
    return createResponse(200, {});
  }

  try {
    switch (event.httpMethod) {
      case 'GET':
        return await handleGetResources(event);
      case 'POST':
        return await handlePostResources(event);
      case 'PUT':
        return await handlePutResources(event);
      case 'DELETE':
        return await handleDeleteResources(event);
      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error: any) {
    console.error('Unhandled error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}