import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
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
  pathParameters: any;
  queryStringParameters: any;
  body: string | null;
  headers: any;
}

interface APIGatewayResponse {
  statusCode: number;
  headers: any;
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
    userId: user.userId,
    action,
    resource,
    details,
    timestamp: new Date().toISOString()
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditRecord
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

function generateId(): string {
  return randomUUID();
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
      
      const command = new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'pk <> :auditPk',
        ExpressionAttributeValues: {
          ':auditPk': 'AUDIT'
        }
      });
      
      const result = await docClient.send(command);
      return createResponse(200, { items: result.Items || [] });
    }

    if (pathParts[0] === 'api' && pathParts[1] && validateTableIndex(pathParts[1])) {
      const tableIndex = pathParts[1];
      const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      const isBulkOperation = pathParts[2] === 'bulk';
      const itemId = pathParts[2] && !isBulkOperation ? pathParts[2] : null;

      if (isBulkOperation && event.httpMethod === 'POST') {
        if (!hasPermission(user, tableConfig.name, 'bulk')) {
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

        const items = requestBody.items;
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
              pk: tableConfig.pk,
              sk: item.id || generateId(),
              id: item.id || generateId()
            };
            addTimestamps(processedItem, false);
            
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

        await writeAuditLog(user, 'BULK_IMPORT', tableConfig.name, { imported, failed });
        
        return createResponse(200, { imported, failed, errors });
      }

      switch (event.httpMethod) {
        case 'GET':
          if (!hasPermission(user, tableConfig.name, 'read')) {
            return createResponse(403, { error: 'Forbidden' });
          }

          if (itemId) {
            const command = new GetCommand({
              TableName: TABLE_NAME,
              Key: { pk: tableConfig.pk, sk: itemId }
            });
            const result = await docClient.send(command);
            
            if (!result.Item) {
              return createResponse(404, { error: 'Item not found' });
            }
            
            return createResponse(200, result.Item);
          } else {
            const command = new ScanCommand({
              TableName: TABLE_NAME,
              FilterExpression: 'pk = :pk',
              ExpressionAttributeValues: {
                ':pk': tableConfig.pk
              }
            });
            const result = await docClient.send(command);
            return createResponse(200, { items: result.Items || [] });
          }

        case 'POST':
          if (!hasPermission(user, tableConfig.name, 'create')) {
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
            sk: generateId(),
            id: generateId()
          };
          addTimestamps(newItem, false);

          const createCommand = new PutCommand({
            TableName: TABLE_NAME,
            Item: newItem
          });
          
          await docClient.send(createCommand);
          await writeAuditLog(user, 'CREATE', tableConfig.name, { id: newItem.id });
          
          return createResponse(201, newItem);

        case 'PUT':
          if (!itemId) {
            return createResponse(400, { error: 'Item ID is required' });
          }
          
          if (!hasPermission(user, tableConfig.name, 'update')) {
            return createResponse(403, { error: 'Forbidden' });
          }

          let updateBody;
          try {
            updateBody = JSON.parse(event.body || '{}');
          } catch (error) {
            return createResponse(400, { error: 'Invalid JSON' });
          }

          const existingCommand = new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: tableConfig.pk, sk: itemId }
          });
          const existingResult = await docClient.send(existingCommand);
          
          if (!existingResult.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          const updatedItem = {
            ...existingResult.Item,
            ...updateBody,
            pk: tableConfig.pk,
            sk: itemId
          };
          addTimestamps(updatedItem, true);

          const updateCommand = new PutCommand({
            TableName: TABLE_NAME,
            Item: updatedItem
          });
          
          await docClient.send(updateCommand);
          await writeAuditLog(user, 'UPDATE', tableConfig.name, { id: itemId });
          
          return createResponse(200, updatedItem);

        case 'DELETE':
          if (!itemId) {
            return createResponse(400, { error: 'Item ID is required' });
          }
          
          if (!hasPermission(user, tableConfig.name, 'delete')) {
            return createResponse(403, { error: 'Forbidden' });
          }

          const deleteCheckCommand = new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: tableConfig.pk, sk: itemId }
          });
          const deleteCheckResult = await docClient.send(deleteCheckCommand);
          
          if (!deleteCheckResult.Item) {
            return createResponse(404, { error: 'Item not found' });
          }

          const deleteCommand = new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { pk: tableConfig.pk, sk: itemId }
          });
          
          await docClient.send(deleteCommand);
          await writeAuditLog(user, 'DELETE', tableConfig.name, { id: itemId });
          
          return createResponse(200, { message: 'Item deleted successfully' });

        default:
          return createResponse(405, { error: 'Method not allowed' });
      }
    }

    return createResponse(404, { error: 'Not found' });

  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};