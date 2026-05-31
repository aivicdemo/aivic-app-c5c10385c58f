import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, validateRole, Role } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface APIGatewayEvent {
  httpMethod: string;
  path: string;
  pathParameters?: { [key: string]: string } | null;
  queryStringParameters?: { [key: string]: string } | null;
  headers: { [key: string]: string };
  body?: string | null;
}

interface APIGatewayResponse {
  statusCode: number;
  headers: { [key: string]: string };
  body: string;
}

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

function getUserRole(event: APIGatewayEvent): Role {
  const authHeader = event.headers.Authorization || event.headers.authorization;
  if (!authHeader) return 'viewer';
  
  const role = authHeader.replace('Bearer ', '');
  return validateRole(role) ? role : 'viewer';
}

async function createAuditLog(action: string, details: any, userId?: string): Promise<void> {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    action,
    details,
    userId: userId || 'system',
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  try {
    const role = getUserRole(event);
    const method = event.httpMethod;
    const path = event.path;
    
    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    // GET /resources
    if (method === 'GET' && path === '/resources') {
      if (!hasPermission(role, 'read')) {
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

        const groupedData: { [key: string]: any[] } = {};
        
        result.Items?.forEach(item => {
          const pkType = item.pk;
          if (!groupedData[pkType]) {
            groupedData[pkType] = [];
          }
          groupedData[pkType].push(item);
        });

        return createResponse(200, {
          success: true,
          data: groupedData,
          total: result.Items?.length || 0
        });
      } catch (error) {
        console.error('Error fetching resources:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // Bulk import endpoints
    const bulkMatch = path.match(/^\/api\/(\d+)\/bulk$/);
    if (method === 'POST' && bulkMatch) {
      const tableIndex = bulkMatch[1];
      const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      
      if (!tableConfig) {
        return createResponse(404, { error: 'Table not found' });
      }

      if (!hasPermission(role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      if (!event.body) {
        return createResponse(400, { error: 'Request body is required' });
      }

      try {
        const { items } = JSON.parse(event.body);
        
        if (!Array.isArray(items)) {
          return createResponse(400, { error: 'Items must be an array' });
        }

        let imported = 0;
        let failed = 0;
        const errors: string[] = [];
        const now = new Date().toISOString();

        // Process in batches of 25 (DynamoDB BatchWrite limit)
        for (let i = 0; i < items.length; i += 25) {
          const batch = items.slice(i, i + 25);
          const writeRequests = batch.map((item, index) => {
            try {
              const processedItem = {
                ...item,
                pk: tableConfig.pk,
                sk: item.id || randomUUID(),
                id: item.id || randomUUID(),
                createdAt: now,
                updatedAt: now
              };

              return {
                PutRequest: {
                  Item: processedItem
                }
              };
            } catch (error) {
              failed++;
              errors.push(`Item ${i + index}: ${error instanceof Error ? error.message : 'Unknown error'}`);
              return null;
            }
          }).filter(Boolean);

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
              errors.push(`Batch ${Math.floor(i / 25)}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
          }
        }

        // Create audit log
        await createAuditLog('BULK_IMPORT', {
          table: tableConfig.name,
          imported,
          failed,
          total: items.length
        });

        return createResponse(200, {
          success: true,
          imported,
          failed,
          errors
        });
      } catch (error) {
        console.error('Bulk import error:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // Individual table CRUD operations
    const tableMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?$/);
    if (tableMatch) {
      const tableIndex = tableMatch[1];
      const itemId = tableMatch[2];
      const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      
      if (!tableConfig) {
        return createResponse(404, { error: 'Table not found' });
      }

      // GET /api/{tableIndex} - List items
      if (method === 'GET' && !itemId) {
        if (!hasPermission(role, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        try {
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: {
              ':pk': tableConfig.pk
            }
          }));

          return createResponse(200, {
            success: true,
            data: result.Items || [],
            total: result.Items?.length || 0
          });
        } catch (error) {
          console.error('Error fetching items:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      // GET /api/{tableIndex}/{id} - Get item by ID
      if (method === 'GET' && itemId) {
        if (!hasPermission(role, 'read')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        try {
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

          return createResponse(200, {
            success: true,
            data: result.Item
          });
        } catch (error) {
          console.error('Error fetching item:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      // POST /api/{tableIndex} - Create item
      if (method === 'POST' && !itemId) {
        if (!hasPermission(role, 'write')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (!event.body) {
          return createResponse(400, { error: 'Request body is required' });
        }

        try {
          const data = JSON.parse(event.body);
          const now = new Date().toISOString();
          const id = randomUUID();

          const item = {
            ...data,
            pk: tableConfig.pk,
            sk: id,
            id,
            createdAt: now,
            updatedAt: now
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: item
          }));

          await createAuditLog('CREATE', {
            table: tableConfig.name,
            itemId: id
          });

          return createResponse(201, {
            success: true,
            data: item
          });
        } catch (error) {
          console.error('Error creating item:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      // PUT /api/{tableIndex}/{id} - Update item
      if (method === 'PUT' && itemId) {
        if (!hasPermission(role, 'write')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        if (!event.body) {
          return createResponse(400, { error: 'Request body is required' });
        }

        try {
          const data = JSON.parse(event.body);
          const now = new Date().toISOString();

          // Check if item exists
          const existing = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: tableConfig.pk,
              sk: itemId
            }
          }));

          if (!existing.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          const item = {
            ...existing.Item,
            ...data,
            pk: tableConfig.pk,
            sk: itemId,
            id: itemId,
            updatedAt: now
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: item
          }));

          await createAuditLog('UPDATE', {
            table: tableConfig.name,
            itemId
          });

          return createResponse(200, {
            success: true,
            data: item
          });
        } catch (error) {
          console.error('Error updating item:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }

      // DELETE /api/{tableIndex}/{id} - Delete item
      if (method === 'DELETE' && itemId) {
        if (!hasPermission(role, 'delete')) {
          return createResponse(403, { error: 'Insufficient permissions' });
        }

        try {
          // Check if item exists
          const existing = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: tableConfig.pk,
              sk: itemId
            }
          }));

          if (!existing.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: tableConfig.pk,
              sk: itemId
            }
          }));

          await createAuditLog('DELETE', {
            table: tableConfig.name,
            itemId
          });

          return createResponse(200, {
            success: true,
            message: 'Item deleted successfully'
          });
        } catch (error) {
          console.error('Error deleting item:', error);
          return createResponse(500, { error: 'Internal server error' });
        }
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};