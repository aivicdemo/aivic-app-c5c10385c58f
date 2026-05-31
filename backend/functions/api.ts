import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { hasPermission, validateRole, Role } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface AuthContext {
  userId: string;
  role: Role;
}

function extractAuth(event: APIGatewayProxyEvent): AuthContext {
  const userId = event.headers['x-user-id'] || 'system';
  const role = event.headers['x-user-role'] || 'viewer';
  
  if (!validateRole(role)) {
    throw new Error('Invalid role');
  }
  
  return { userId, role };
}

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(body)
  };
}

async function createAuditLog(action: string, resourceType: string, resourceId: string, userId: string, details?: any) {
  const auditItem = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    action,
    resourceType,
    resourceId,
    userId,
    timestamp: new Date().toISOString(),
    details: details || {}
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditItem
  }));
}

const TABLE_CONFIGS = {
  '0': { name: 'LoginUser', pk: 'USER' },
  '1': { name: 'Product', pk: 'PRODUCT' },
  '2': { name: 'Supplier', pk: 'SUPPLIER' },
  '3': { name: 'Inventory', pk: 'INVENTORY' },
  '4': { name: 'PurchaseRecord', pk: 'PURCHASE' },
  '5': { name: 'SalesRecord', pk: 'SALES' },
  '6': { name: 'MonthlySummary', pk: 'MONTHLY' },
  '7': { name: 'OrderRecommendation', pk: 'ORDER_REC' },
  '8': { name: 'ProductProposal', pk: 'PROPOSAL' },
  '9': { name: 'Customer', pk: 'CUSTOMER' },
  '10': { name: 'Pet', pk: 'PET' },
  '11': { name: 'CustomerHistory', pk: 'CUST_HIST' },
  '12': { name: 'DemandForecast', pk: 'FORECAST' },
  '13': { name: 'OrderHistory', pk: 'ORDER_HIST' },
  '14': { name: 'InventoryAdjustment', pk: 'INV_ADJ' }
};

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = extractAuth(event);
    const path = event.path;
    const method = event.httpMethod;
    
    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(auth.role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }
      
      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        index,
        name: config.name,
        pk: config.pk
      }));
      
      return createResponse(200, { resources });
    }
    
    const pathMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(\w+))?$/);
    if (!pathMatch) {
      return createResponse(404, { error: 'Not found' });
    }
    
    const [, tableIndex, action, itemId] = pathMatch;
    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }
    
    if (action === 'bulk' && method === 'POST') {
      if (!hasPermission(auth.role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }
      
      const body = JSON.parse(event.body || '{}');
      const items = body.items || [];
      
      if (!Array.isArray(items)) {
        return createResponse(400, { error: 'Items must be an array' });
      }
      
      let imported = 0;
      let failed = 0;
      const errors: string[] = [];
      
      const chunks = [];
      for (let i = 0; i < items.length; i += 25) {
        chunks.push(items.slice(i, i + 25));
      }
      
      for (const chunk of chunks) {
        const writeRequests = chunk.map(item => {
          const now = new Date().toISOString();
          const processedItem = {
            ...item,
            pk: tableConfig.pk,
            sk: item.id || randomUUID(),
            id: item.id || randomUUID(),
            createdAt: now,
            updatedAt: now,
            createdBy: auth.userId,
            updatedBy: auth.userId
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
          imported += chunk.length;
        } catch (error) {
          failed += chunk.length;
          errors.push(`Batch write failed: ${error}`);
        }
      }
      
      await createAuditLog('BULK_IMPORT', tableConfig.name, tableConfig.pk, auth.userId, {
        imported,
        failed,
        totalItems: items.length
      });
      
      return createResponse(200, { imported, failed, errors });
    }
    
    if (!action) {
      if (method === 'GET') {
        if (!hasPermission(auth.role, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
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
      
      if (method === 'POST') {
        if (!hasPermission(auth.role, 'write')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }
        
        const body = JSON.parse(event.body || '{}');
        const now = new Date().toISOString();
        const id = randomUUID();
        
        const item = {
          ...body,
          pk: tableConfig.pk,
          sk: id,
          id,
          createdAt: now,
          updatedAt: now,
          createdBy: auth.userId,
          updatedBy: auth.userId
        };
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        }));
        
        await createAuditLog('CREATE', tableConfig.name, id, auth.userId, body);
        
        return createResponse(201, item);
      }
    }
    
    if (action && itemId) {
      if (method === 'GET') {
        if (!hasPermission(auth.role, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }
        
        const result = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.pk,
            sk: itemId
          }
        }));
        
        if (!result.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        return createResponse(200, result.Item);
      }
      
      if (method === 'PUT') {
        if (!hasPermission(auth.role, 'write')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }
        
        const body = JSON.parse(event.body || '{}');
        const now = new Date().toISOString();
        
        const item = {
          ...body,
          pk: tableConfig.pk,
          sk: itemId,
          id: itemId,
          updatedAt: now,
          updatedBy: auth.userId
        };
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        }));
        
        await createAuditLog('UPDATE', tableConfig.name, itemId, auth.userId, body);
        
        return createResponse(200, item);
      }
      
      if (method === 'DELETE') {
        if (!hasPermission(auth.role, 'delete')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }
        
        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.pk,
            sk: itemId
          }
        }));
        
        await createAuditLog('DELETE', tableConfig.name, itemId, auth.userId);
        
        return createResponse(204, {});
      }
    }
    
    if (action && !itemId) {
      if (method === 'GET') {
        if (!hasPermission(auth.role, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }
        
        const result = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.pk,
            sk: action
          }
        }));
        
        if (!result.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        return createResponse(200, result.Item);
      }
    }
    
    return createResponse(405, { error: 'Method not allowed' });
    
  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};