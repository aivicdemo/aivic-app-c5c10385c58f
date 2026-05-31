import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { checkPermission, Role } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE || 'inventory-management';

interface AuthContext {
  userId: string;
  role: Role;
}

const RESOURCE_MAP: Record<string, string> = {
  '0': 'users',
  '1': 'products',
  '2': 'suppliers',
  '3': 'inventory',
  '4': 'purchase-records',
  '5': 'sales-records',
  '6': 'monthly-summary',
  '7': 'order-recommendations',
  '8': 'product-proposals',
  '9': 'customers',
  '10': 'pets',
  '11': 'customer-history',
  '12': 'demand-forecast',
  '13': 'order-history',
  '14': 'inventory-adjustments'
};

const TABLE_CONFIGS = {
  'users': { pk: 'USER', sk: 'userId' },
  'products': { pk: 'PRODUCT', sk: 'productId' },
  'suppliers': { pk: 'SUPPLIER', sk: 'supplierId' },
  'inventory': { pk: 'INVENTORY', sk: 'inventoryId' },
  'purchase-records': { pk: 'PURCHASE', sk: 'purchaseRecordId' },
  'sales-records': { pk: 'SALES', sk: 'salesRecordId' },
  'monthly-summary': { pk: 'MONTHLY', sk: 'summaryId' },
  'order-recommendations': { pk: 'ORDER_REC', sk: 'orderRecommendationId' },
  'product-proposals': { pk: 'PROPOSAL', sk: 'proposalId' },
  'customers': { pk: 'CUSTOMER', sk: 'customerId' },
  'pets': { pk: 'PET', sk: 'petId' },
  'customer-history': { pk: 'HISTORY', sk: 'historyId' },
  'demand-forecast': { pk: 'FORECAST', sk: 'forecastId' },
  'order-history': { pk: 'ORDER_HIST', sk: 'orderHistoryId' },
  'inventory-adjustments': { pk: 'ADJUSTMENT', sk: 'adjustmentHistoryId' }
};

function getAuthContext(event: APIGatewayProxyEvent): AuthContext {
  const userId = event.headers['x-user-id'] || 'anonymous';
  const role = (event.headers['x-user-role'] as Role) || 'viewer';
  return { userId, role };
}

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-user-id, x-user-role'
    },
    body: JSON.stringify(body)
  };
}

async function createAuditLog(action: string, resource: string, userId: string, details: any = {}) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    action,
    resource,
    userId,
    timestamp: new Date().toISOString(),
    details
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
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

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const { userId, role } = getAuthContext(event);
    const method = event.httpMethod;
    const path = event.path;
    const pathSegments = path.split('/').filter(Boolean);
    
    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    // GET /resources
    if (method === 'GET' && path === '/resources') {
      checkPermission(role, 'resources', 'read');
      
      const resources = Object.entries(RESOURCE_MAP).map(([index, name]) => ({
        index,
        name,
        displayName: name.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
      }));
      
      return createResponse(200, { resources });
    }

    // API routes: /api/{tableIndex}/*
    if (pathSegments[0] === 'api' && pathSegments[1]) {
      const tableIndex = pathSegments[1];
      const resourceName = RESOURCE_MAP[tableIndex];
      
      if (!resourceName) {
        return createResponse(404, { error: 'Resource not found' });
      }
      
      const config = TABLE_CONFIGS[resourceName];
      const isBulkEndpoint = pathSegments[2] === 'bulk';
      const itemId = pathSegments[2] && !isBulkEndpoint ? pathSegments[2] : null;

      // Bulk import endpoint
      if (method === 'POST' && isBulkEndpoint) {
        checkPermission(role, resourceName, 'bulk');
        
        const body = JSON.parse(event.body || '{}');
        const items = body.items || [];
        
        if (!Array.isArray(items)) {
          return createResponse(400, { error: 'items must be an array' });
        }
        
        let imported = 0;
        let failed = 0;
        const errors: string[] = [];
        
        // Process in batches of 25 (DynamoDB limit)
        for (let i = 0; i < items.length; i += 25) {
          const batch = items.slice(i, i + 25);
          const writeRequests = batch.map(item => {
            const id = item.id || randomUUID();
            const processedItem = {
              ...item,
              pk: config.pk,
              sk: id,
              [config.sk]: id,
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
          } catch (error) {
            failed += batch.length;
            errors.push(`Batch ${Math.floor(i/25) + 1}: ${error}`);
          }
        }
        
        await createAuditLog('bulk_import', resourceName, userId, { imported, failed });
        
        return createResponse(200, { imported, failed, errors });
      }
      
      // List items
      if (method === 'GET' && !itemId) {
        checkPermission(role, resourceName, 'read');
        
        const result = await docClient.send(new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: 'pk = :pk',
          ExpressionAttributeValues: {
            ':pk': config.pk
          }
        }));
        
        return createResponse(200, { items: result.Items || [] });
      }
      
      // Get single item
      if (method === 'GET' && itemId) {
        checkPermission(role, resourceName, 'read');
        
        const result = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: config.pk,
            sk: itemId
          }
        }));
        
        if (!result.Item) {
          return createResponse(404, { error: 'Item not found' });
        }
        
        return createResponse(200, result.Item);
      }
      
      // Create item
      if (method === 'POST' && !itemId && !isBulkEndpoint) {
        checkPermission(role, resourceName, 'create');
        
        const body = JSON.parse(event.body || '{}');
        const id = body.id || randomUUID();
        
        const item = {
          ...body,
          pk: config.pk,
          sk: id,
          [config.sk]: id,
          ...addTimestamps(body, false)
        };
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        }));
        
        await createAuditLog('create', resourceName, userId, { id });
        
        return createResponse(201, item);
      }
      
      // Update item
      if (method === 'PUT' && itemId) {
        checkPermission(role, resourceName, 'update');
        
        const body = JSON.parse(event.body || '{}');
        
        const item = {
          ...body,
          pk: config.pk,
          sk: itemId,
          [config.sk]: itemId,
          ...addTimestamps(body, true)
        };
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        }));
        
        await createAuditLog('update', resourceName, userId, { id: itemId });
        
        return createResponse(200, item);
      }
      
      // Delete item
      if (method === 'DELETE' && itemId) {
        checkPermission(role, resourceName, 'delete');
        
        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: config.pk,
            sk: itemId
          }
        }));
        
        await createAuditLog('delete', resourceName, userId, { id: itemId });
        
        return createResponse(200, { message: 'Item deleted successfully' });
      }
    }
    
    return createResponse(404, { error: 'Endpoint not found' });
    
  } catch (error: any) {
    console.error('Error:', error);
    
    if (error.message?.includes('Access denied')) {
      return createResponse(403, { error: error.message });
    }
    
    if (error.name === 'ValidationException') {
      return createResponse(400, { error: error.message });
    }
    
    return createResponse(500, { error: 'Internal server error' });
  }
};