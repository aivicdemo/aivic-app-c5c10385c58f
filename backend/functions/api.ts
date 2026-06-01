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

async function createAuditLog(user: User, action: string, resource: string, details: any = {}) {
  const auditItem = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${crypto.randomUUID()}`,
    userId: user.id,
    action,
    resource,
    details,
    timestamp: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditItem
  }));
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
  return crypto.randomUUID();
}

async function handleGetResources(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  try {
    const user = extractUserFromEvent(event);
    
    if (!hasPermission(user, 'resources', 'read')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    const tableIndex = event.pathParameters?.tableIndex;
    if (!tableIndex || !TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS]) {
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
      const result = await docClient.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'pk = :pk',
        ExpressionAttributeValues: {
          ':pk': config.pk
        }
      }));

      return createResponse(200, {
        items: result.Items || [],
        count: result.Count || 0
      });
    }
  } catch (error: any) {
    if (error.message === 'Authorization header missing' || error.message === 'Invalid token') {
      return createResponse(401, { error: error.message });
    }
    return createResponse(500, { error: 'Internal server error', details: error.message });
  }
}

async function handlePostResource(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  try {
    const user = extractUserFromEvent(event);
    const tableIndex = event.pathParameters?.tableIndex;
    
    if (!tableIndex || !TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS]) {
      return createResponse(400, { error: 'Invalid table index' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    // 一括インポートの場合
    if (event.pathParameters?.action === 'bulk') {
      if (!hasPermission(user, config.name, 'bulk')) {
        return createResponse(403, { error: 'Insufficient permissions for bulk import' });
      }

      if (!event.body) {
        return createResponse(400, { error: 'Request body is required' });
      }

      const requestBody = JSON.parse(event.body);
      if (!requestBody.items || !Array.isArray(requestBody.items)) {
        return createResponse(400, { error: 'Invalid request format. Expected { items: [] }' });
      }

      const items = requestBody.items;
      let imported = 0;
      let failed = 0;
      const errors: string[] = [];

      // 25件ずつに分割してバッチ処理
      for (let i = 0; i < items.length; i += 25) {
        const batch = items.slice(i, i + 25);
        const writeRequests = batch.map(item => {
          const processedItem = {
            ...item,
            pk: config.pk,
            sk: item.id || generateId(),
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
              [TABLE_NAME]: writeRequests
            }
          }));
          imported += batch.length;
        } catch (error: any) {
          failed += batch.length;
          errors.push(`Batch ${Math.floor(i/25) + 1}: ${error.message}`);
        }
      }

      await createAuditLog(user, 'BULK_IMPORT', config.name, { imported, failed, total: items.length });

      return createResponse(200, { imported, failed, errors });
    }
    
    // 通常の作成
    if (!hasPermission(user, config.name, 'create')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    if (!event.body) {
      return createResponse(400, { error: 'Request body is required' });
    }

    const item = JSON.parse(event.body);
    const id = generateId();
    
    const newItem = {
      ...item,
      pk: config.pk,
      sk: id,
      id,
      ...addTimestamps(item, false)
    };

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: newItem
    }));

    await createAuditLog(user, 'CREATE', config.name, { id });

    return createResponse(201, newItem);
  } catch (error: any) {
    if (error.message === 'Authorization header missing' || error.message === 'Invalid token') {
      return createResponse(401, { error: error.message });
    }
    return createResponse(500, { error: 'Internal server error', details: error.message });
  }
}

async function handlePutResource(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  try {
    const user = extractUserFromEvent(event);
    const tableIndex = event.pathParameters?.tableIndex;
    const id = event.pathParameters?.id;
    
    if (!tableIndex || !TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS]) {
      return createResponse(400, { error: 'Invalid table index' });
    }

    if (!id) {
      return createResponse(400, { error: 'Resource ID is required' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    if (!hasPermission(user, config.name, 'update')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    if (!event.body) {
      return createResponse(400, { error: 'Request body is required' });
    }

    // 既存アイテムの確認
    const existingResult = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: config.pk, sk: id }
    }));

    if (!existingResult.Item) {
      return createResponse(404, { error: 'Resource not found' });
    }

    const updateData = JSON.parse(event.body);
    const updatedItem = {
      ...existingResult.Item,
      ...updateData,
      pk: config.pk,
      sk: id,
      id,
      ...addTimestamps(updateData, true)
    };

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedItem
    }));

    await createAuditLog(user, 'UPDATE', config.name, { id });

    return createResponse(200, updatedItem);
  } catch (error: any) {
    if (error.message === 'Authorization header missing' || error.message === 'Invalid token') {
      return createResponse(401, { error: error.message });
    }
    return createResponse(500, { error: 'Internal server error', details: error.message });
  }
}

async function handleDeleteResource(event: APIGatewayEvent): Promise<APIGatewayResponse> {
  try {
    const user = extractUserFromEvent(event);
    const tableIndex = event.pathParameters?.tableIndex;
    const id = event.pathParameters?.id;
    
    if (!tableIndex || !TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS]) {
      return createResponse(400, { error: 'Invalid table index' });
    }

    if (!id) {
      return createResponse(400, { error: 'Resource ID is required' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    if (!hasPermission(user, config.name, 'delete')) {
      return createResponse(403, { error: 'Insufficient permissions' });
    }

    // 既存アイテムの確認
    const existingResult = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: config.pk, sk: id }
    }));

    if (!existingResult.Item) {
      return createResponse(404, { error: 'Resource not found' });
    }

    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { pk: config.pk, sk: id }
    }));

    await createAuditLog(user, 'DELETE', config.name, { id });

    return createResponse(200, { message: 'Resource deleted successfully', id });
  } catch (error: any) {
    if (error.message === 'Authorization header missing' || error.message === 'Invalid token') {
      return createResponse(401, { error: error.message });
    }
    return createResponse(500, { error: 'Internal server error', details: error.message });
  }
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  if (event.httpMethod === 'OPTIONS') {
    return createResponse(200, {});
  }

  try {
    const path = event.pathParameters?.proxy || '';
    const pathParts = path.split('/');
    
    // GET /resources
    if (event.httpMethod === 'GET' && pathParts[0] === 'resources') {
      return await handleGetResources(event);
    }
    
    // API routes: /api/{tableIndex}/* 
    if (pathParts[0] === 'api' && pathParts[1]) {
      const tableIndex = pathParts[1];
      const resourceId = pathParts[2];
      const action = pathParts[2]; // for bulk operations
      
      // Set path parameters for handlers
      event.pathParameters = {
        ...event.pathParameters,
        tableIndex,
        id: resourceId !== 'bulk' ? resourceId : undefined,
        action: action === 'bulk' ? 'bulk' : undefined
      };
      
      switch (event.httpMethod) {
        case 'GET':
          return await handleGetResources(event);
        case 'POST':
          return await handlePostResource(event);
        case 'PUT':
          return await handlePutResource(event);
        case 'DELETE':
          return await handleDeleteResource(event);
        default:
          return createResponse(405, { error: 'Method not allowed' });
      }
    }
    
    return createResponse(404, { error: 'Endpoint not found' });
  } catch (error: any) {
    return createResponse(500, { error: 'Internal server error', details: error.message });
  }
};