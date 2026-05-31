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
  '14': { name: '在庫調整履歴', pk: 'ADJUST_HIST' }
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

function addTimestamps(item: any, isUpdate: boolean = false): any {
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
    const id = event.pathParameters?.id;

    if (id) {
      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: config.pk, sk: id }
      }));

      if (!result.Item) {
        return createResponse(404, { error: 'Resource not found' });
      }

      return createResponse(200, result.Item);
    } else {
      const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit) : 100;
      const result = await docClient.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': config.pk },
        Limit: limit
      }));

      return createResponse(200, {
        items: result.Items || [],
        count: result.Count || 0
      });
    }
  } catch (error) {
    console.error('Error in handleGetResources:', error);
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
    const body = JSON.parse(event.body || '{}');

    const requiredFields = getRequiredFields(tableIndex);
    const validationErrors = validateRequired(body, requiredFields);
    if (validationErrors.length > 0) {
      return createResponse(400, { error: 'Validation failed', details: validationErrors });
    }

    const id = randomUUID();
    const item = {
      pk: config.pk,
      sk: id,
      id,
      ...body,
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
    console.error('Error in handleCreateResource:', error);
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
    
    if (!tableIndex || !TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS] || !id) {
      return createResponse(400, { error: 'Invalid parameters' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const body = JSON.parse(event.body || '{}');

    const existing = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: config.pk, sk: id }
    }));

    if (!existing.Item) {
      return createResponse(404, { error: 'Resource not found' });
    }

    const updatedItem = {
      ...existing.Item,
      ...body,
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
    console.error('Error in handleUpdateResource:', error);
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
    
    if (!tableIndex || !TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS] || !id) {
      return createResponse(400, { error: 'Invalid parameters' });
    }

    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];

    const existing = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: config.pk, sk: id }
    }));

    if (!existing.Item) {
      return createResponse(404, { error: 'Resource not found' });
    }

    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { pk: config.pk, sk: id }
    }));

    await writeAuditLog(user, 'DELETE', config.name, { id });

    return createResponse(200, { message: 'Resource deleted successfully' });
  } catch (error) {
    console.error('Error in handleDeleteResource:', error);
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
    const body = JSON.parse(event.body || '{}');
    const items = body.items || [];

    if (!Array.isArray(items) || items.length === 0) {
      return createResponse(400, { error: 'Items array is required and must not be empty' });
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
        imported += chunk.length;
      } catch (error) {
        failed += chunk.length;
        errors.push(`Batch write failed: ${error}`);
      }
    }

    await writeAuditLog(user, 'BULK_IMPORT', config.name, { imported, failed });

    return createResponse(200, { imported, failed, errors });
  } catch (error) {
    console.error('Error in handleBulkImport:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
}

function getRequiredFields(tableIndex: string): string[] {
  const requiredFieldsMap: Record<string, string[]> = {
    '0': ['loginId', 'passwordHash', 'userName', 'authorityLevel', 'activeFlag', 'createdBy'],
    '1': ['productCode', 'productName', 'validFlag'],
    '2': ['supplierCode', 'supplierName', 'validFlag'],
    '3': ['productId', 'currentStock', 'safetyStock', 'stockStatus'],
    '4': ['purchaseDate', 'supplierId', 'productId', 'purchaseQuantity', 'purchaseUnitPrice', 'purchaseAmount'],
    '5': ['salesDate', 'productId', 'salesQuantity', 'unitPrice', 'salesAmount', 'salesPersonId'],
    '6': ['aggregationYearMonth', 'salesQuantity', 'salesAmount', 'purchaseQuantity', 'purchaseAmount', 'beginningStock', 'endingStock', 'endingStockAmount', 'grossProfit', 'grossProfitRate', 'aggregationStatus', 'aggregationExecutionDate'],
    '7': ['productId', 'supplierId', 'recommendationDate', 'currentStock', 'safetyStock', 'recommendedOrderQuantity', 'expectedConsumption', 'leadTimeDays', 'priority', 'recommendationReason', 'processingStatus'],
    '8': ['supplierId', 'proposedProductName', 'proposalType', 'proposalContent', 'reviewStatus'],
    '9': ['customerCode', 'customerName', 'validFlag'],
    '10': ['customerId', 'petName', 'species', 'registrationStatus'],
    '11': ['customerId', 'usageType', 'usageDateTime', 'followUpRequired'],
    '12': ['productId', 'forecastYearMonth', 'forecastQuantity', 'forecastBasis', 'confidenceLevel', 'status'],
    '13': ['orderNumber', 'productId', 'supplierId', 'orderQuantity', 'orderUnitPrice', 'orderAmount', 'orderDate', 'expectedDeliveryDate', 'orderStatus'],
    '14': ['productId', 'adjustmentDateTime', 'adjustmentReasonCategory', 'quantityBeforeAdjustment', 'quantityAfterAdjustment', 'adjustmentQuantity']
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
    
    if (pathParts[0] === 'api' && pathParts[1] && pathParts[2] === 'bulk' && event.httpMethod === 'POST') {
      return await handleBulkImport({ ...event, pathParameters: { tableIndex: pathParts[1] } }, user);
    }
    
    if (pathParts[0] === 'api' && pathParts[1]) {
      const tableIndex = pathParts[1];
      const id = pathParts[2];
      
      const modifiedEvent = {
        ...event,
        pathParameters: { tableIndex, id }
      };
      
      switch (event.httpMethod) {
        case 'GET':
          return await handleGetResources(modifiedEvent, user);
        case 'POST':
          return await handleCreateResource(modifiedEvent, user);
        case 'PUT':
          return await handleUpdateResource(modifiedEvent, user);
        case 'DELETE':
          return await handleDeleteResource(modifiedEvent, user);
        default:
          return createResponse(405, { error: 'Method not allowed' });
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