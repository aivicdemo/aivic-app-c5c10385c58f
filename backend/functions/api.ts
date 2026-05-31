import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

const TABLE_MAPPINGS = {
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

async function createAuditLog(user: User, action: string, resource: string, details?: any): Promise<void> {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.id,
    action,
    resource,
    details: details || {},
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
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

function validateRequired(data: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (!data[field]) {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

function addTimestamps(item: any, isUpdate = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

async function handleGetResources(event: APIGatewayEvent, user: User): Promise<APIGatewayResponse> {
  if (!hasPermission(user, 'resources', 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'pk <> :auditPk',
      ExpressionAttributeValues: {
        ':auditPk': 'AUDIT'
      }
    }));

    return createResponse(200, {
      items: result.Items || [],
      count: result.Count || 0
    });
  } catch (error) {
    console.error('Error getting resources:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleTableOperations(event: APIGatewayEvent, user: User, tableIndex: string): Promise<APIGatewayResponse> {
  const tableName = TABLE_MAPPINGS[tableIndex as keyof typeof TABLE_MAPPINGS];
  if (!tableName) {
    return createResponse(404, { error: 'Table not found' });
  }

  const method = event.httpMethod;
  const pathParts = event.pathParameters?.proxy?.split('/') || [];
  const isBulkOperation = pathParts[pathParts.length - 1] === 'bulk';
  const itemId = pathParts[0] && pathParts[0] !== 'bulk' ? pathParts[0] : null;

  try {
    switch (method) {
      case 'GET':
        if (!hasPermission(user, tableName, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }
        
        if (itemId) {
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: tableName, sk: itemId }
          }));
          
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, result.Item);
        } else {
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: {
              ':pk': tableName
            }
          }));
          
          return createResponse(200, {
            items: result.Items || [],
            count: result.Count || 0
          });
        }

      case 'POST':
        if (isBulkOperation) {
          if (!hasPermission(user, tableName, 'bulk')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }
          
          const bulkData = JSON.parse(event.body || '{}');
          if (!bulkData.items || !Array.isArray(bulkData.items)) {
            return createResponse(400, { error: 'Invalid bulk data format' });
          }
          
          let imported = 0;
          let failed = 0;
          const errors: string[] = [];
          
          const chunks = [];
          for (let i = 0; i < bulkData.items.length; i += 25) {
            chunks.push(bulkData.items.slice(i, i + 25));
          }
          
          for (const chunk of chunks) {
            const writeRequests = chunk.map((item: any) => {
              const processedItem = {
                ...item,
                pk: tableName,
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
              imported += chunk.length;
            } catch (error) {
              failed += chunk.length;
              errors.push(`Batch write failed: ${error}`);
            }
          }
          
          await createAuditLog(user, 'BULK_IMPORT', tableName, { imported, failed });
          
          return createResponse(200, { imported, failed, errors });
        } else {
          if (!hasPermission(user, tableName, 'create')) {
            return createResponse(403, { error: 'Insufficient permissions' });
          }
          
          const data = JSON.parse(event.body || '{}');
          const item = {
            ...data,
            pk: tableName,
            sk: data.id || randomUUID(),
            ...addTimestamps(data)
          };
          
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: item
          }));
          
          await createAuditLog(user, 'CREATE', tableName, { id: item.sk });
          
          return createResponse(201, item);
        }

      case 'PUT':
        if (!hasPermission(user, tableName, 'update')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }
        
        if (!itemId) {
          return createResponse(400, { error: 'Item ID required for update' });
        }
        
        const updateData = JSON.parse(event.body || '{}');
        const updatedItem = {
          ...updateData,
          pk: tableName,
          sk: itemId,
          ...addTimestamps(updateData, true)
        };
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));
        
        await createAuditLog(user, 'UPDATE', tableName, { id: itemId });
        
        return createResponse(200, updatedItem);

      case 'DELETE':
        if (!hasPermission(user, tableName, 'delete')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }
        
        if (!itemId) {
          return createResponse(400, { error: 'Item ID required for delete' });
        }
        
        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { pk: tableName, sk: itemId }
        }));
        
        await createAuditLog(user, 'DELETE', tableName, { id: itemId });
        
        return createResponse(200, { message: 'Item deleted successfully' });

      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    console.error(`Error in ${method} ${tableName}:`, error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  if (event.httpMethod === 'OPTIONS') {
    return createResponse(200, {});
  }

  try {
    const user = extractUserFromEvent(event);
    const path = event.pathParameters?.proxy || '';
    const pathParts = path.split('/');

    if (path === 'resources') {
      return await handleGetResources(event, user);
    }

    if (pathParts[0] === 'api' && pathParts[1] && TABLE_MAPPINGS[pathParts[1] as keyof typeof TABLE_MAPPINGS]) {
      const tableIndex = pathParts[1];
      const remainingPath = pathParts.slice(2).join('/');
      
      const modifiedEvent = {
        ...event,
        pathParameters: {
          ...event.pathParameters,
          proxy: remainingPath
        }
      };
      
      return await handleTableOperations(modifiedEvent, user, tableIndex);
    }

    return createResponse(404, { error: 'Endpoint not found' });
  } catch (error) {
    console.error('Handler error:', error);
    if (error instanceof Error && error.message.includes('Authorization')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
};