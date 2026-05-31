import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { User, checkPermission } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface TableConfig {
  name: string;
  pk: string;
  sk?: string;
}

const TABLES: Record<string, TableConfig> = {
  '0': { name: 'login_users', pk: 'user_id' },
  '1': { name: 'products', pk: 'product_id' },
  '2': { name: 'suppliers', pk: 'supplier_id' },
  '3': { name: 'inventory', pk: 'inventory_id' },
  '4': { name: 'purchase_records', pk: 'purchase_record_id' },
  '5': { name: 'sales_records', pk: 'sales_record_id' },
  '6': { name: 'monthly_summaries', pk: 'summary_id' },
  '7': { name: 'order_recommendations', pk: 'recommendation_id' },
  '8': { name: 'product_proposals', pk: 'proposal_id' },
  '9': { name: 'customers', pk: 'customer_id' },
  '10': { name: 'pets', pk: 'pet_id' },
  '11': { name: 'customer_usage_history', pk: 'usage_history_id' },
  '12': { name: 'demand_forecasts', pk: 'forecast_id' },
  '13': { name: 'order_history', pk: 'order_history_id' },
  '14': { name: 'inventory_adjustments', pk: 'adjustment_id' }
};

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
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

function getCurrentUser(event: APIGatewayProxyEvent): User {
  const authHeader = event.headers.Authorization || event.headers.authorization;
  if (!authHeader) {
    throw new Error('Authorization header required');
  }
  
  try {
    const token = authHeader.replace('Bearer ', '');
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return {
      id: payload.sub || 'anonymous',
      role: payload.role || 'viewer'
    };
  } catch {
    return { id: 'anonymous', role: 'viewer' };
  }
}

async function createAuditLog(action: string, resource: string, userId: string, details?: any): Promise<void> {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    action,
    resource,
    userId,
    details,
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

function addTimestamps(item: any, isUpdate = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.created_at = now;
  }
  item.updated_at = now;
  return item;
}

function validateRequired(item: any, requiredFields: string[]): void {
  const missing = requiredFields.filter(field => !item[field]);
  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(', ')}`);
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const path = event.path;
    const method = event.httpMethod;
    const pathParts = path.split('/').filter(p => p);

    if (pathParts[0] !== 'resources') {
      return createResponse(404, { error: 'Not found' });
    }

    const user = getCurrentUser(event);
    const tableIndex = pathParts[1];
    const tableConfig = TABLES[tableIndex];
    
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }

    const isBulkOperation = pathParts[2] === 'bulk';
    const itemId = pathParts[2] && !isBulkOperation ? pathParts[2] : null;

    switch (method) {
      case 'GET':
        checkPermission(user, tableConfig.name, 'read');
        
        if (itemId) {
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: `${tableConfig.name}#${itemId}`,
              sk: tableConfig.sk ? `${tableConfig.name}#${itemId}` : undefined
            }
          }));
          
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, result.Item);
        } else {
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'begins_with(pk, :prefix)',
            ExpressionAttributeValues: {
              ':prefix': `${tableConfig.name}#`
            }
          }));
          
          return createResponse(200, { items: result.Items || [] });
        }

      case 'POST':
        if (isBulkOperation) {
          checkPermission(user, tableConfig.name, 'bulk');
          
          const body = JSON.parse(event.body || '{}');
          const items = body.items || [];
          
          if (!Array.isArray(items)) {
            return createResponse(400, { error: 'Items must be an array' });
          }

          let imported = 0;
          let failed = 0;
          const errors: string[] = [];

          // Process in batches of 25 (DynamoDB BatchWrite limit)
          for (let i = 0; i < items.length; i += 25) {
            const batch = items.slice(i, i + 25);
            const writeRequests = [];

            for (const item of batch) {
              try {
                const id = randomUUID();
                const processedItem = {
                  ...item,
                  pk: `${tableConfig.name}#${id}`,
                  sk: tableConfig.sk ? `${tableConfig.name}#${id}` : undefined,
                  [tableConfig.pk]: id
                };
                addTimestamps(processedItem);
                processedItem.created_by = user.id;
                processedItem.updated_by = user.id;

                writeRequests.push({
                  PutRequest: {
                    Item: processedItem
                  }
                });
              } catch (error) {
                failed++;
                errors.push(`Item ${i}: ${error instanceof Error ? error.message : 'Unknown error'}`);
              }
            }

            if (writeRequests.length > 0) {
              try {
                await docClient.send(new BatchWriteCommand({
                  RequestItems: {
                    [TABLE_NAME]: writeRequests
                  }
                }));
                imported += writeRequests.length;
              } catch (error) {
                failed += writeRequests.length;
                errors.push(`Batch write failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
              }
            }
          }

          await createAuditLog('bulk_import', tableConfig.name, user.id, { imported, failed });
          
          return createResponse(200, { imported, failed, errors });
        } else {
          checkPermission(user, tableConfig.name, 'create');
          
          const body = JSON.parse(event.body || '{}');
          const id = randomUUID();
          
          const item = {
            ...body,
            pk: `${tableConfig.name}#${id}`,
            sk: tableConfig.sk ? `${tableConfig.name}#${id}` : undefined,
            [tableConfig.pk]: id
          };
          
          addTimestamps(item);
          item.created_by = user.id;
          item.updated_by = user.id;
          
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: item
          }));
          
          await createAuditLog('create', tableConfig.name, user.id, { id });
          
          return createResponse(201, item);
        }

      case 'PUT':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID required for update' });
        }
        
        checkPermission(user, tableConfig.name, 'update');
        
        const updateBody = JSON.parse(event.body || '{}');
        const updateItem = {
          ...updateBody,
          pk: `${tableConfig.name}#${itemId}`,
          sk: tableConfig.sk ? `${tableConfig.name}#${itemId}` : undefined,
          [tableConfig.pk]: itemId
        };
        
        addTimestamps(updateItem, true);
        updateItem.updated_by = user.id;
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updateItem
        }));
        
        await createAuditLog('update', tableConfig.name, user.id, { id: itemId });
        
        return createResponse(200, updateItem);

      case 'DELETE':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID required for delete' });
        }
        
        checkPermission(user, tableConfig.name, 'delete');
        
        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: `${tableConfig.name}#${itemId}`,
            sk: tableConfig.sk ? `${tableConfig.name}#${itemId}` : undefined
          }
        }));
        
        await createAuditLog('delete', tableConfig.name, user.id, { id: itemId });
        
        return createResponse(204, {});

      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error:', error);
    
    if (error instanceof Error) {
      if (error.message.includes('Access denied')) {
        return createResponse(403, { error: error.message });
      }
      if (error.message.includes('not found')) {
        return createResponse(404, { error: error.message });
      }
      if (error.message.includes('required') || error.message.includes('validation')) {
        return createResponse(400, { error: error.message });
      }
    }
    
    return createResponse(500, { error: 'Internal server error' });
  }
};