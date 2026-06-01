import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

const tableMapping: Record<string, string> = {
  '0': 'LOGIN_USER',
  '1': 'PRODUCT_MASTER',
  '2': 'SUPPLIER_MASTER',
  '3': 'INVENTORY_MANAGEMENT',
  '4': 'PURCHASE_RECORD',
  '5': 'SALES_RECORD',
  '6': 'MONTHLY_SUMMARY',
  '7': 'ORDER_RECOMMENDATION',
  '8': 'PRODUCT_PROPOSAL',
  '9': 'CUSTOMER_MASTER',
  '10': 'PET_INFO',
  '11': 'CUSTOMER_USAGE_HISTORY',
  '12': 'DEMAND_FORECAST',
  '13': 'ORDER_HISTORY',
  '14': 'INVENTORY_ADJUSTMENT_HISTORY'
};

interface APIGatewayEvent {
  httpMethod: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  body?: string;
  headers?: { [key: string]: string };
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
    timestamp: new Date().toISOString(),
    createdAt: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditRecord
  }));
}

function validateRequired(data: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (!data[field] && data[field] !== 0 && data[field] !== false) {
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
      if (!hasPermission(user, 'resources', 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }
      
      const resources = Object.entries(tableMapping).map(([index, tableName]) => ({
        index,
        tableName,
        displayName: tableName.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, l => l.toUpperCase())
      }));
      
      return createResponse(200, { resources });
    }

    if (pathParts[0] === 'api' && pathParts[1] && tableMapping[pathParts[1]]) {
      const tableIndex = pathParts[1];
      const tableName = tableMapping[tableIndex];
      const resourceId = pathParts[2];
      
      if (pathParts[2] === 'bulk' && event.httpMethod === 'POST') {
        if (!hasPermission(user, tableName, 'bulk')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        const body = JSON.parse(event.body || '{}');
        const items = body.items || [];
        
        if (!Array.isArray(items)) {
          return createResponse(400, { error: 'items must be an array' });
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
            const processedItem = {
              ...item,
              pk: tableName,
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
                [TABLE_NAME]: writeRequests
              }
            }));
            imported += chunk.length;
          } catch (error) {
            failed += chunk.length;
            errors.push(`Batch write failed: ${error}`);
          }
        }
        
        await writeAuditLog(user, 'BULK_IMPORT', tableName, { imported, failed });
        
        return createResponse(200, { imported, failed, errors });
      }
      
      switch (event.httpMethod) {
        case 'GET':
          if (!hasPermission(user, tableName, 'read')) {
            return createResponse(403, { error: 'Forbidden' });
          }
          
          if (resourceId) {
            const result = await docClient.send(new GetCommand({
              TableName: TABLE_NAME,
              Key: { pk: tableName, sk: resourceId }
            }));
            
            if (!result.Item) {
              return createResponse(404, { error: 'Resource not found' });
            }
            
            return createResponse(200, result.Item);
          } else {
            const limit = parseInt(event.queryStringParameters?.limit || '100');
            const result = await docClient.send(new ScanCommand({
              TableName: TABLE_NAME,
              FilterExpression: 'pk = :pk',
              ExpressionAttributeValues: { ':pk': tableName },
              Limit: limit
            }));
            
            return createResponse(200, {
              items: result.Items || [],
              count: result.Count || 0
            });
          }
          
        case 'POST':
          if (!hasPermission(user, tableName, 'create')) {
            return createResponse(403, { error: 'Forbidden' });
          }
          
          const createBody = JSON.parse(event.body || '{}');
          const createId = createBody.id || randomUUID();
          
          const createItem = {
            ...createBody,
            pk: tableName,
            sk: createId,
            id: createId,
            createdBy: user.id,
            updatedBy: user.id,
            ...addTimestamps(createBody, false)
          };
          
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: createItem
          }));
          
          await writeAuditLog(user, 'CREATE', tableName, { id: createId });
          
          return createResponse(201, createItem);
          
        case 'PUT':
          if (!resourceId) {
            return createResponse(400, { error: 'Resource ID required' });
          }
          
          if (!hasPermission(user, tableName, 'update')) {
            return createResponse(403, { error: 'Forbidden' });
          }
          
          const updateBody = JSON.parse(event.body || '{}');
          
          const existingItem = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: tableName, sk: resourceId }
          }));
          
          if (!existingItem.Item) {
            return createResponse(404, { error: 'Resource not found' });
          }
          
          const updateItem = {
            ...existingItem.Item,
            ...updateBody,
            pk: tableName,
            sk: resourceId,
            id: resourceId,
            updatedBy: user.id,
            ...addTimestamps(updateBody, true)
          };
          
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: updateItem
          }));
          
          await writeAuditLog(user, 'UPDATE', tableName, { id: resourceId });
          
          return createResponse(200, updateItem);
          
        case 'DELETE':
          if (!resourceId) {
            return createResponse(400, { error: 'Resource ID required' });
          }
          
          if (!hasPermission(user, tableName, 'delete')) {
            return createResponse(403, { error: 'Forbidden' });
          }
          
          const deleteItem = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: tableName, sk: resourceId }
          }));
          
          if (!deleteItem.Item) {
            return createResponse(404, { error: 'Resource not found' });
          }
          
          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { pk: tableName, sk: resourceId }
          }));
          
          await writeAuditLog(user, 'DELETE', tableName, { id: resourceId });
          
          return createResponse(200, { message: 'Resource deleted successfully' });
          
        default:
          return createResponse(405, { error: 'Method not allowed' });
      }
    }
    
    return createResponse(404, { error: 'Endpoint not found' });
    
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};