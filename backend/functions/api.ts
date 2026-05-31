import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { User, requirePermission } from './rbac';
import * as crypto from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface TableConfig {
  name: string;
  pk: string;
  sk?: string;
}

const TABLES: Record<string, TableConfig> = {
  '0': { name: 'LoginUser', pk: 'userId' },
  '1': { name: 'ProductMaster', pk: 'productId' },
  '2': { name: 'SupplierMaster', pk: 'supplierId' },
  '3': { name: 'InventoryManagement', pk: 'inventoryId' },
  '4': { name: 'PurchaseRecord', pk: 'purchaseRecordId' },
  '5': { name: 'SalesRecord', pk: 'salesRecordId' },
  '6': { name: 'MonthlySummary', pk: 'summaryId' },
  '7': { name: 'OrderRecommendation', pk: 'orderRecommendationId' },
  '8': { name: 'ProductProposal', pk: 'proposalId' },
  '9': { name: 'CustomerMaster', pk: 'customerId' },
  '10': { name: 'PetInfo', pk: 'petId' },
  '11': { name: 'CustomerUsageHistory', pk: 'usageHistoryId' },
  '12': { name: 'DemandForecast', pk: 'demandForecastId' },
  '13': { name: 'OrderHistory', pk: 'orderHistoryId' },
  '14': { name: 'InventoryAdjustmentHistory', pk: 'adjustmentHistoryId' }
};

function getCurrentUser(event: APIGatewayProxyEvent): User {
  const role = event.headers['x-user-role'] || 'viewer';
  const userId = event.headers['x-user-id'] || 'anonymous';
  return { id: userId, role: role as 'admin' | 'operator' | 'viewer' };
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
    sk: `${Date.now()}_${crypto.randomUUID()}`,
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

function addTimestamps(item: any, isUpdate: boolean = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

function validateTableIndex(tableIndex: string): TableConfig {
  const table = TABLES[tableIndex];
  if (!table) {
    throw new Error(`Invalid table index: ${tableIndex}`);
  }
  return table;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = getCurrentUser(event);
    const method = event.httpMethod;
    const path = event.path;
    
    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    // GET /resources - リソース一覧取得
    if (method === 'GET' && path === '/resources') {
      requirePermission(user, 'resources', 'read');
      
      const resources = Object.entries(TABLES).map(([index, config]) => ({
        index,
        name: config.name,
        pk: config.pk,
        sk: config.sk
      }));
      
      return createResponse(200, { resources });
    }

    // パスパラメータの解析
    const pathParts = path.split('/').filter(p => p);
    
    if (pathParts.length < 2 || pathParts[0] !== 'api') {
      return createResponse(404, { error: 'Not found' });
    }

    const tableIndex = pathParts[1];
    const table = validateTableIndex(tableIndex);
    const resourceName = table.name;

    // 一括インポートエンドポイント
    if (method === 'POST' && pathParts[2] === 'bulk') {
      requirePermission(user, resourceName, 'bulk');
      
      const body = JSON.parse(event.body || '{}');
      const items = body.items || [];
      
      if (!Array.isArray(items)) {
        return createResponse(400, { error: 'items must be an array' });
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
            pk: table.name,
            sk: item[table.pk] || crypto.randomUUID(),
            [table.pk]: item[table.pk] || crypto.randomUUID()
          };
          addTimestamps(processedItem);
          processedItem.createdBy = user.id;
          processedItem.updatedBy = user.id;
          
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

      await createAuditLog('BULK_IMPORT', resourceName, user.id, { imported, failed });
      
      return createResponse(200, { imported, failed, errors });
    }

    const itemId = pathParts[2];

    switch (method) {
      case 'GET':
        requirePermission(user, resourceName, 'read');
        
        if (itemId) {
          // 詳細取得
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: table.name, sk: itemId }
          }));
          
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, result.Item);
        } else {
          // 一覧取得
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: {
              ':pk': table.name
            }
          }));
          
          return createResponse(200, { items: result.Items || [] });
        }

      case 'POST':
        requirePermission(user, resourceName, 'create');
        
        const createBody = JSON.parse(event.body || '{}');
        const newId = crypto.randomUUID();
        const newItem = {
          ...createBody,
          pk: table.name,
          sk: newId,
          [table.pk]: newId
        };
        addTimestamps(newItem);
        newItem.createdBy = user.id;
        newItem.updatedBy = user.id;
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: newItem
        }));
        
        await createAuditLog('CREATE', resourceName, user.id, { id: newId });
        
        return createResponse(201, newItem);

      case 'PUT':
        requirePermission(user, resourceName, 'update');
        
        if (!itemId) {
          return createResponse(400, { error: 'Item ID is required' });
        }
        
        const updateBody = JSON.parse(event.body || '{}');
        const updatedItem = {
          ...updateBody,
          pk: table.name,
          sk: itemId,
          [table.pk]: itemId
        };
        addTimestamps(updatedItem, true);
        updatedItem.updatedBy = user.id;
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));
        
        await createAuditLog('UPDATE', resourceName, user.id, { id: itemId });
        
        return createResponse(200, updatedItem);

      case 'DELETE':
        requirePermission(user, resourceName, 'delete');
        
        if (!itemId) {
          return createResponse(400, { error: 'Item ID is required' });
        }
        
        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { pk: table.name, sk: itemId }
        }));
        
        await createAuditLog('DELETE', resourceName, user.id, { id: itemId });
        
        return createResponse(200, { message: 'Item deleted successfully' });

      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
    
  } catch (error: any) {
    console.error('Error:', error);
    
    if (error.message?.includes('Access denied')) {
      return createResponse(403, { error: error.message });
    }
    
    if (error.message?.includes('Invalid table index')) {
      return createResponse(404, { error: error.message });
    }
    
    if (error.name === 'ValidationException') {
      return createResponse(400, { error: 'Invalid request data' });
    }
    
    return createResponse(500, { error: 'Internal server error' });
  }
};