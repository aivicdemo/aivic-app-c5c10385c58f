import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { User, checkPermission } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE || 'inventory-management';

interface TableConfig {
  name: string;
  pkField: string;
  gsiFields?: string[];
}

const TABLES: Record<string, TableConfig> = {
  '0': { name: 'login_users', pkField: 'user_id' },
  '1': { name: 'product_master', pkField: 'product_id' },
  '2': { name: 'supplier_master', pkField: 'supplier_id' },
  '3': { name: 'inventory_management', pkField: 'inventory_id' },
  '4': { name: 'purchase_results', pkField: 'purchase_result_id' },
  '5': { name: 'sales_results', pkField: 'sales_result_id' },
  '6': { name: 'monthly_summary', pkField: 'summary_id' },
  '7': { name: 'order_recommendations', pkField: 'order_recommendation_id' },
  '8': { name: 'product_proposals', pkField: 'proposal_id' },
  '9': { name: 'customer_master', pkField: 'customer_id' },
  '10': { name: 'pet_information', pkField: 'pet_id' },
  '11': { name: 'customer_usage_history', pkField: 'usage_history_id' },
  '12': { name: 'demand_forecast', pkField: 'demand_forecast_id' },
  '13': { name: 'order_history', pkField: 'order_history_id' },
  '14': { name: 'inventory_adjustment_history', pkField: 'adjustment_history_id' }
};

function getCurrentUser(event: APIGatewayProxyEvent): User {
  const authHeader = event.headers.Authorization || event.headers.authorization;
  if (!authHeader) {
    throw new Error('Authorization header required');
  }
  
  const role = event.headers['x-user-role'] as 'admin' | 'operator' | 'viewer';
  if (!role || !['admin', 'operator', 'viewer'].includes(role)) {
    throw new Error('Invalid user role');
  }
  
  return {
    id: event.headers['x-user-id'] || 'anonymous',
    role
  };
}

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-user-role, x-user-id'
    },
    body: JSON.stringify(body)
  };
}

async function writeAuditLog(action: string, resource: string, userId: string, details?: any): Promise<void> {
  const auditRecord = {
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
    Item: auditRecord
  }));
}

function validateTableIndex(tableIndex: string): TableConfig {
  const config = TABLES[tableIndex];
  if (!config) {
    throw new Error(`Invalid table index: ${tableIndex}`);
  }
  return config;
}

function addTimestamps(item: any, isUpdate: boolean = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.created_at = now;
  }
  item.updated_at = now;
  return item;
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const user = getCurrentUser(event);
    const path = event.path;
    const method = event.httpMethod;

    // GET /resources - リソース一覧取得
    if (method === 'GET' && path === '/resources') {
      checkPermission(user, 'resources', 'read');
      
      const resources = Object.entries(TABLES).map(([index, config]) => ({
        index,
        name: config.name,
        pkField: config.pkField
      }));
      
      return createResponse(200, { resources });
    }

    // パスパラメータの解析
    const pathParts = path.split('/').filter(p => p);
    if (pathParts.length < 2 || pathParts[0] !== 'api') {
      return createResponse(404, { error: 'Not found' });
    }

    const tableIndex = pathParts[1];
    const tableConfig = validateTableIndex(tableIndex);
    const resourceName = tableConfig.name;

    // 一括インポートエンドポイント
    if (method === 'POST' && pathParts[2] === 'bulk') {
      checkPermission(user, resourceName, 'bulk');
      
      const body = JSON.parse(event.body || '{}');
      if (!body.items || !Array.isArray(body.items)) {
        return createResponse(400, { error: 'Invalid request body. Expected { items: [] }' });
      }

      let imported = 0;
      let failed = 0;
      const errors: string[] = [];

      const chunks = chunkArray(body.items, 25);
      
      for (const chunk of chunks) {
        const writeRequests = chunk.map(item => {
          const processedItem = {
            ...item,
            pk: resourceName,
            sk: item[tableConfig.pkField] || randomUUID(),
            ...addTimestamps(item)
          };
          
          if (!processedItem[tableConfig.pkField]) {
            processedItem[tableConfig.pkField] = processedItem.sk;
          }
          
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

      await writeAuditLog('bulk_import', resourceName, user.id, { imported, failed });
      
      return createResponse(200, { imported, failed, errors });
    }

    const itemId = pathParts[2];

    // GET /api/{tableIndex} - 一覧取得
    if (method === 'GET' && !itemId) {
      checkPermission(user, resourceName, 'read');
      
      const command = new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: {
          ':pk': resourceName
        }
      });
      
      const result = await docClient.send(command);
      return createResponse(200, { items: result.Items || [] });
    }

    // GET /api/{tableIndex}/{id} - 詳細取得
    if (method === 'GET' && itemId) {
      checkPermission(user, resourceName, 'read');
      
      const command = new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: resourceName,
          sk: itemId
        }
      });
      
      const result = await docClient.send(command);
      if (!result.Item) {
        return createResponse(404, { error: 'Item not found' });
      }
      
      return createResponse(200, result.Item);
    }

    // POST /api/{tableIndex} - 新規作成
    if (method === 'POST' && !itemId) {
      checkPermission(user, resourceName, 'create');
      
      const body = JSON.parse(event.body || '{}');
      const id = body[tableConfig.pkField] || randomUUID();
      
      const item = {
        ...body,
        pk: resourceName,
        sk: id,
        [tableConfig.pkField]: id,
        created_by: user.id,
        updated_by: user.id,
        ...addTimestamps(body)
      };
      
      const command = new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
        ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)'
      });
      
      await docClient.send(command);
      await writeAuditLog('create', resourceName, user.id, { id });
      
      return createResponse(201, item);
    }

    // PUT /api/{tableIndex}/{id} - 更新
    if (method === 'PUT' && itemId) {
      checkPermission(user, resourceName, 'update');
      
      const body = JSON.parse(event.body || '{}');
      
      // 既存アイテムの確認
      const getCommand = new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: resourceName,
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
        pk: resourceName,
        sk: itemId,
        [tableConfig.pkField]: itemId,
        updated_by: user.id,
        ...addTimestamps(body, true)
      };
      
      const putCommand = new PutCommand({
        TableName: TABLE_NAME,
        Item: updatedItem
      });
      
      await docClient.send(putCommand);
      await writeAuditLog('update', resourceName, user.id, { id: itemId });
      
      return createResponse(200, updatedItem);
    }

    // DELETE /api/{tableIndex}/{id} - 削除
    if (method === 'DELETE' && itemId) {
      checkPermission(user, resourceName, 'delete');
      
      const command = new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: resourceName,
          sk: itemId
        },
        ConditionExpression: 'attribute_exists(pk) AND attribute_exists(sk)'
      });
      
      await docClient.send(command);
      await writeAuditLog('delete', resourceName, user.id, { id: itemId });
      
      return createResponse(200, { message: 'Item deleted successfully' });
    }

    return createResponse(404, { error: 'Not found' });
    
  } catch (error: any) {
    console.error('Error:', error);
    
    if (error.message.includes('Access denied')) {
      return createResponse(403, { error: error.message });
    }
    
    if (error.message.includes('not found') || error.name === 'ConditionalCheckFailedException') {
      return createResponse(404, { error: 'Item not found' });
    }
    
    if (error.message.includes('Invalid') || error.name === 'ValidationException') {
      return createResponse(400, { error: error.message });
    }
    
    return createResponse(500, { error: 'Internal server error' });
  }
};