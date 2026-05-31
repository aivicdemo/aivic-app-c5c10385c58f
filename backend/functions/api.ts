import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
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

async function createAuditLog(user: User, action: string, resource: string, details: any) {
  const auditLog = {
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
    Item: auditLog
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

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
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
    
    if (pathParts[0] === 'resources') {
      if (event.httpMethod === 'GET') {
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
    }

    if (pathParts.length >= 2 && pathParts[0] === 'api') {
      const tableIndex = pathParts[1];
      
      if (!validateTableIndex(tableIndex)) {
        return createResponse(404, { error: 'Table not found' });
      }
      
      const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      const resource = tableConfig.name;
      
      // Bulk import endpoint
      if (pathParts.length === 3 && pathParts[2] === 'bulk' && event.httpMethod === 'POST') {
        if (!hasPermission(user, resource, 'bulk')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        let requestBody;
        try {
          requestBody = JSON.parse(event.body || '{}');
        } catch (error) {
          return createResponse(400, { error: 'Invalid JSON' });
        }
        
        if (!requestBody.items || !Array.isArray(requestBody.items)) {
          return createResponse(400, { error: 'items array is required' });
        }
        
        const items = requestBody.items.map((item: any) => {
          const processedItem = {
            ...item,
            pk: tableConfig.pk,
            sk: item.id || randomUUID(),
            id: item.id || randomUUID()
          };
          return addTimestamps(processedItem);
        });
        
        let imported = 0;
        let failed = 0;
        const errors: string[] = [];
        
        const chunks = chunkArray(items, 25);
        
        for (const chunk of chunks) {
          try {
            const putRequests = chunk.map(item => ({
              PutRequest: { Item: item }
            }));
            
            await docClient.send(new BatchWriteCommand({
              RequestItems: {
                [TABLE_NAME]: putRequests
              }
            }));
            
            imported += chunk.length;
          } catch (error) {
            failed += chunk.length;
            errors.push(`Batch write failed: ${error}`);
          }
        }
        
        await createAuditLog(user, 'BULK_IMPORT', resource, {
          imported,
          failed,
          totalItems: items.length
        });
        
        return createResponse(200, { imported, failed, errors });
      }
      
      // CRUD operations
      switch (event.httpMethod) {
        case 'GET':
          if (!hasPermission(user, resource, 'read')) {
            return createResponse(403, { error: 'Forbidden' });
          }
          
          if (pathParts.length === 3) {
            // Get specific item
            const id = pathParts[2];
            const result = await docClient.send(new GetCommand({
              TableName: TABLE_NAME,
              Key: { pk: tableConfig.pk, sk: id }
            }));
            
            if (!result.Item) {
              return createResponse(404, { error: 'Item not found' });
            }
            
            return createResponse(200, result.Item);
          } else {
            // List items
            const result = await docClient.send(new QueryCommand({
              TableName: TABLE_NAME,
              KeyConditionExpression: 'pk = :pk',
              ExpressionAttributeValues: {
                ':pk': tableConfig.pk
              }
            }));
            
            return createResponse(200, { items: result.Items || [] });
          }
          
        case 'POST':
          if (!hasPermission(user, resource, 'create')) {
            return createResponse(403, { error: 'Forbidden' });
          }
          
          let createBody;
          try {
            createBody = JSON.parse(event.body || '{}');
          } catch (error) {
            return createResponse(400, { error: 'Invalid JSON' });
          }
          
          const newItem = {
            ...createBody,
            pk: tableConfig.pk,
            sk: createBody.id || randomUUID(),
            id: createBody.id || randomUUID()
          };
          
          addTimestamps(newItem);
          
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: newItem
          }));
          
          await createAuditLog(user, 'CREATE', resource, { id: newItem.id });
          
          return createResponse(201, newItem);
          
        case 'PUT':
          if (!hasPermission(user, resource, 'update')) {
            return createResponse(403, { error: 'Forbidden' });
          }
          
          if (pathParts.length !== 3) {
            return createResponse(400, { error: 'ID required for update' });
          }
          
          const updateId = pathParts[2];
          let updateBody;
          try {
            updateBody = JSON.parse(event.body || '{}');
          } catch (error) {
            return createResponse(400, { error: 'Invalid JSON' });
          }
          
          const updatedItem = {
            ...updateBody,
            pk: tableConfig.pk,
            sk: updateId,
            id: updateId
          };
          
          addTimestamps(updatedItem, true);
          
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: updatedItem
          }));
          
          await createAuditLog(user, 'UPDATE', resource, { id: updateId });
          
          return createResponse(200, updatedItem);
          
        case 'DELETE':
          if (!hasPermission(user, resource, 'delete')) {
            return createResponse(403, { error: 'Forbidden' });
          }
          
          if (pathParts.length !== 3) {
            return createResponse(400, { error: 'ID required for delete' });
          }
          
          const deleteId = pathParts[2];
          
          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { pk: tableConfig.pk, sk: deleteId }
          }));
          
          await createAuditLog(user, 'DELETE', resource, { id: deleteId });
          
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