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
  '7': { name: '発注推奨', pk: 'ORDER_RECOMMEND' },
  '8': { name: '商品提案情報', pk: 'PRODUCT_PROPOSAL' },
  '9': { name: '顧客マスタ', pk: 'CUSTOMER' },
  '10': { name: 'ペット情報', pk: 'PET' },
  '11': { name: '顧客利用履歴', pk: 'CUSTOMER_HISTORY' },
  '12': { name: '需要予測', pk: 'DEMAND_FORECAST' },
  '13': { name: '発注履歴', pk: 'ORDER_HISTORY' },
  '14': { name: '在庫調整履歴', pk: 'INVENTORY_ADJUSTMENT' }
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

async function writeAuditLog(user: User, action: string, resource: string, details: any = {}) {
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
    const tableIndex = event.pathParameters?.tableIndex;
    if (!tableIndex || !TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS]) {
      return createResponse(400, { error: 'Invalid table index' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit) : 50;
    const lastKey = event.queryStringParameters?.lastKey;

    const params: any = {
      TableName: TABLE_NAME,
      FilterExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': config.pk
      },
      Limit: limit
    };

    if (lastKey) {
      params.ExclusiveStartKey = JSON.parse(decodeURIComponent(lastKey));
    }

    const result = await docClient.send(new ScanCommand(params));
    
    return createResponse(200, {
      items: result.Items || [],
      lastEvaluatedKey: result.LastEvaluatedKey,
      count: result.Count
    });
  } catch (error) {
    console.error('Error getting resources:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGetResource(event: APIGatewayEvent, user: User): Promise<APIGatewayResponse> {
  if (!hasPermission(user, 'resources', 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const tableIndex = event.pathParameters?.tableIndex;
    const id = event.pathParameters?.id;
    
    if (!tableIndex || !id || !TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS]) {
      return createResponse(400, { error: 'Invalid parameters' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: id
      }
    }));

    if (!result.Item) {
      return createResponse(404, { error: 'Resource not found' });
    }

    return createResponse(200, result.Item);
  } catch (error) {
    console.error('Error getting resource:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleCreateResource(event: APIGatewayEvent, user: User): Promise<APIGatewayResponse> {
  if (!hasPermission(user, 'resources', 'create')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const tableIndex = event.pathParameters?.tableIndex;
    if (!tableIndex || !TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS]) {
      return createResponse(400, { error: 'Invalid table index' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const data = JSON.parse(event.body || '{}');
    
    const requiredFields = getRequiredFields(tableIndex);
    const validationErrors = validateRequired(data, requiredFields);
    if (validationErrors.length > 0) {
      return createResponse(400, { error: 'Validation failed', details: validationErrors });
    }

    const id = randomUUID();
    const item = {
      pk: config.pk,
      sk: id,
      id,
      ...data,
      createdBy: user.id,
      updatedBy: user.id
    };
    
    addTimestamps(item);

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    }));

    await writeAuditLog(user, 'CREATE', config.name, { id });

    return createResponse(201, item);
  } catch (error) {
    console.error('Error creating resource:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpdateResource(event: APIGatewayEvent, user: User): Promise<APIGatewayResponse> {
  if (!hasPermission(user, 'resources', 'update')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const tableIndex = event.pathParameters?.tableIndex;
    const id = event.pathParameters?.id;
    
    if (!tableIndex || !id || !TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS]) {
      return createResponse(400, { error: 'Invalid parameters' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const data = JSON.parse(event.body || '{}');
    
    const existing = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: id
      }
    }));

    if (!existing.Item) {
      return createResponse(404, { error: 'Resource not found' });
    }

    const updatedItem = {
      ...existing.Item,
      ...data,
      updatedBy: user.id
    };
    
    addTimestamps(updatedItem, true);

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedItem
    }));

    await writeAuditLog(user, 'UPDATE', config.name, { id });

    return createResponse(200, updatedItem);
  } catch (error) {
    console.error('Error updating resource:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDeleteResource(event: APIGatewayEvent, user: User): Promise<APIGatewayResponse> {
  if (!hasPermission(user, 'resources', 'delete')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const tableIndex = event.pathParameters?.tableIndex;
    const id = event.pathParameters?.id;
    
    if (!tableIndex || !id || !TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS]) {
      return createResponse(400, { error: 'Invalid parameters' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    const existing = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: id
      }
    }));

    if (!existing.Item) {
      return createResponse(404, { error: 'Resource not found' });
    }

    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: id
      }
    }));

    await writeAuditLog(user, 'DELETE', config.name, { id });

    return createResponse(200, { message: 'Resource deleted successfully' });
  } catch (error) {
    console.error('Error deleting resource:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleBulkImport(event: APIGatewayEvent, user: User): Promise<APIGatewayResponse> {
  if (!hasPermission(user, 'resources', 'bulk')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const tableIndex = event.pathParameters?.tableIndex;
    if (!tableIndex || !TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS]) {
      return createResponse(400, { error: 'Invalid table index' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const { items } = JSON.parse(event.body || '{}');
    
    if (!Array.isArray(items)) {
      return createResponse(400, { error: 'Items must be an array' });
    }

    let imported = 0;
    let failed = 0;
    const errors: string[] = [];

    // Process in batches of 25 (DynamoDB BatchWrite limit)
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      const writeRequests = batch.map(item => {
        const id = item.id || randomUUID();
        const processedItem = {
          pk: config.pk,
          sk: id,
          id,
          ...item,
          createdBy: user.id,
          updatedBy: user.id
        };
        addTimestamps(processedItem);
        
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

    await writeAuditLog(user, 'BULK_IMPORT', config.name, { imported, failed, total: items.length });

    return createResponse(200, { imported, failed, errors });
  } catch (error) {
    console.error('Error in bulk import:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

function getRequiredFields(tableIndex: string): string[] {
  const requiredFieldsMap: Record<string, string[]> = {
    '0': ['loginId', 'passwordHash', 'userName', 'permissionLevel', 'activeFlag', 'createdBy'],
    '1': ['productCode', 'productName', 'activeFlag'],
    '2': ['supplierCode', 'supplierName', 'activeFlag'],
    '3': ['productId', 'currentStock', 'safetyStock', 'stockStatus'],
    '4': ['purchaseDate', 'supplierId', 'productId', 'quantity', 'unitPrice', 'totalAmount'],
    '5': ['salesDate', 'productId', 'quantity', 'unitPrice', 'totalAmount', 'salesPersonId'],
    '6': ['aggregateMonth', 'salesQuantity', 'salesAmount', 'purchaseQuantity', 'purchaseAmount', 'openingStock', 'closingStock', 'closingStockValue', 'grossProfit', 'grossProfitRate', 'aggregateStatus', 'aggregateDateTime'],
    '7': ['productId', 'supplierId', 'recommendDate', 'currentStock', 'safetyStock', 'recommendedQuantity', 'expectedConsumption', 'leadTimeDays', 'priority', 'recommendReason', 'processStatus'],
    '8': ['supplierId', 'proposalProductName', 'proposalType', 'proposalContent', 'reviewStatus'],
    '9': ['customerCode', 'customerName', 'activeFlag'],
    '10': ['customerId', 'petName', 'species', 'registrationStatus'],
    '11': ['customerId', 'usageType', 'usageDateTime', 'followUpRequired'],
    '12': ['productId', 'forecastMonth', 'forecastQuantity', 'forecastBasis', 'confidenceLevel', 'status'],
    '13': ['orderNumber', 'productId', 'supplierId', 'orderQuantity', 'orderUnitPrice', 'orderAmount', 'orderDate', 'expectedDeliveryDate', 'orderStatus'],
    '14': ['productId', 'adjustmentDateTime', 'reasonCategory', 'beforeQuantity', 'afterQuantity', 'adjustmentQuantity']
  };
  
  return requiredFieldsMap[tableIndex] || [];
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  if (event.httpMethod === 'OPTIONS') {
    return createResponse(200, {});
  }

  try {
    const user = extractUserFromEvent(event);
    const path = event.pathParameters?.proxy || '';
    const pathParts = path.split('/');

    if (pathParts[0] === 'resources') {
      return await handleGetResources(event, user);
    }

    if (pathParts[0] === 'api' && pathParts[1] && TABLE_CONFIGS[pathParts[1] as keyof typeof TABLE_CONFIGS]) {
      const tableIndex = pathParts[1];
      
      if (pathParts[2] === 'bulk' && event.httpMethod === 'POST') {
        return await handleBulkImport(event, user);
      }
      
      if (event.httpMethod === 'GET' && !pathParts[2]) {
        event.pathParameters = { ...event.pathParameters, tableIndex };
        return await handleGetResources(event, user);
      }
      
      if (event.httpMethod === 'GET' && pathParts[2]) {
        event.pathParameters = { ...event.pathParameters, tableIndex, id: pathParts[2] };
        return await handleGetResource(event, user);
      }
      
      if (event.httpMethod === 'POST' && !pathParts[2]) {
        event.pathParameters = { ...event.pathParameters, tableIndex };
        return await handleCreateResource(event, user);
      }
      
      if (event.httpMethod === 'PUT' && pathParts[2]) {
        event.pathParameters = { ...event.pathParameters, tableIndex, id: pathParts[2] };
        return await handleUpdateResource(event, user);
      }
      
      if (event.httpMethod === 'DELETE' && pathParts[2]) {
        event.pathParameters = { ...event.pathParameters, tableIndex, id: pathParts[2] };
        return await handleDeleteResource(event, user);
      }
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