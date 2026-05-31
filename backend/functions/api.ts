import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { User, hasPermission, requirePermission } from './rbac';
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

function getCurrentUser(event: APIGatewayProxyEvent): User {
  const role = event.headers['x-user-role'] || 'viewer';
  const userId = event.headers['x-user-id'] || 'anonymous';
  return {
    id: userId,
    role: role as 'admin' | 'operator' | 'viewer'
  };
}

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-user-role, x-user-id'
    },
    body: JSON.stringify(body)
  };
}

async function createAuditLog(action: string, resource: string, userId: string, details?: any): Promise<void> {
  const auditItem = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    action,
    resource,
    userId,
    timestamp: new Date().toISOString(),
    details: details || {}
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditItem
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

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = getCurrentUser(event);
    const method = event.httpMethod;
    const path = event.path;
    const pathParts = path.split('/').filter(p => p);
    
    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    // GET /resources
    if (method === 'GET' && path === '/resources') {
      if (!hasPermission(user, 'resources', 'read')) {
        return createResponse(403, { error: 'Access denied' });
      }
      
      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        index,
        name: config.name,
        pk: config.pk
      }));
      
      return createResponse(200, { resources });
    }

    // API routes: /api/{tableIndex}/*
    if (pathParts[0] === 'api' && pathParts[1]) {
      const tableIndex = pathParts[1];
      
      if (!validateTableIndex(tableIndex)) {
        return createResponse(404, { error: 'Table not found' });
      }
      
      const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      const resource = tableConfig.name;
      
      // POST /api/{tableIndex}/bulk - 一括インポート
      if (method === 'POST' && pathParts[2] === 'bulk') {
        if (!hasPermission(user, resource, 'bulk')) {
          return createResponse(403, { error: 'Access denied' });
        }
        
        const body = JSON.parse(event.body || '{}');
        const items = body.items || [];
        
        if (!Array.isArray(items)) {
          return createResponse(400, { error: 'Items must be an array' });
        }
        
        let imported = 0;
        let failed = 0;
        const errors: string[] = [];
        
        // 25件ずつに分割してバッチ処理
        for (let i = 0; i < items.length; i += 25) {
          const batch = items.slice(i, i + 25);
          const putRequests = batch.map(item => {
            const processedItem = {
              ...item,
              pk: tableConfig.pk,
              sk: item.id || randomUUID(),
              id: item.id || randomUUID(),
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
        
        await createAuditLog('BULK_IMPORT', resource, user.id, { imported, failed });
        
        return createResponse(200, { imported, failed, errors });
      }
      
      // GET /api/{tableIndex} - 一覧取得
      if (method === 'GET' && pathParts.length === 2) {
        if (!hasPermission(user, resource, 'read')) {
          return createResponse(403, { error: 'Access denied' });
        }
        
        const result = await docClient.send(new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: 'pk = :pk',
          ExpressionAttributeValues: {
            ':pk': tableConfig.pk
          }
        }));
        
        return createResponse(200, { items: result.Items || [] });
      }
      
      // GET /api/{tableIndex}/{id} - 詳細取得
      if (method === 'GET' && pathParts.length === 3) {
        if (!hasPermission(user, resource, 'read')) {
          return createResponse(403, { error: 'Access denied' });
        }
        
        const id = pathParts[2];
        const result = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.pk,
            sk: id
          }
        }));
        
        if (!result.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        return createResponse(200, result.Item);
      }
      
      // POST /api/{tableIndex} - 新規作成
      if (method === 'POST' && pathParts.length === 2) {
        if (!hasPermission(user, resource, 'create')) {
          return createResponse(403, { error: 'Access denied' });
        }
        
        const body = JSON.parse(event.body || '{}');
        const id = body.id || randomUUID();
        
        const item = {
          ...body,
          pk: tableConfig.pk,
          sk: id,
          id,
          ...addTimestamps(body, false),
          createdBy: user.id,
          updatedBy: user.id
        };
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        }));
        
        await createAuditLog('CREATE', resource, user.id, { id });
        
        return createResponse(201, item);
      }
      
      // PUT /api/{tableIndex}/{id} - 更新
      if (method === 'PUT' && pathParts.length === 3) {
        if (!hasPermission(user, resource, 'update')) {
          return createResponse(403, { error: 'Access denied' });
        }
        
        const id = pathParts[2];
        const body = JSON.parse(event.body || '{}');
        
        // 既存アイテムの確認
        const existing = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.pk,
            sk: id
          }
        }));
        
        if (!existing.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        const updatedItem = {
          ...existing.Item,
          ...body,
          pk: tableConfig.pk,
          sk: id,
          id,
          ...addTimestamps(body, true),
          updatedBy: user.id
        };
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));
        
        await createAuditLog('UPDATE', resource, user.id, { id });
        
        return createResponse(200, updatedItem);
      }
      
      // DELETE /api/{tableIndex}/{id} - 削除
      if (method === 'DELETE' && pathParts.length === 3) {
        if (!hasPermission(user, resource, 'delete')) {
          return createResponse(403, { error: 'Access denied' });
        }
        
        const id = pathParts[2];
        
        // 既存アイテムの確認
        const existing = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.pk,
            sk: id
          }
        }));
        
        if (!existing.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.pk,
            sk: id
          }
        }));
        
        await createAuditLog('DELETE', resource, user.id, { id });
        
        return createResponse(200, { message: 'Item deleted successfully' });
      }
    }
    
    return createResponse(404, { error: 'Endpoint not found' });
    
  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof Error && error.message.includes('Access denied')) {
      return createResponse(403, { error: error.message });
    }
    
    if (error instanceof SyntaxError) {
      return createResponse(400, { error: 'Invalid JSON in request body' });
    }
    
    return createResponse(500, { error: 'Internal server error' });
  }
};