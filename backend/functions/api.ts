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

function validateRequired(data: any, fields: string[]): string[] {
  const errors: string[] = [];
  for (const field of fields) {
    if (!data[field]) {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

function addTimestamps(item: any, isUpdate = false) {
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
      return await handleResourcesEndpoint(user, event);
    }

    if (pathParts[0] === 'api' && pathParts[1] && TABLE_CONFIGS[pathParts[1] as keyof typeof TABLE_CONFIGS]) {
      const tableIndex = pathParts[1];
      const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      
      if (pathParts[2] === 'bulk') {
        return await handleBulkImport(user, event, tableConfig);
      }
      
      return await handleTableEndpoint(user, event, tableConfig, pathParts);
    }

    return createResponse(404, { error: 'Not found' });
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

async function handleResourcesEndpoint(user: User, event: APIGatewayEvent): Promise<APIGatewayResponse> {
  if (event.httpMethod !== 'GET') {
    return createResponse(405, { error: 'Method not allowed' });
  }

  if (!hasPermission(user, 'resources', 'read')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  try {
    const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
      id: index,
      name: config.name,
      pk: config.pk
    }));

    return createResponse(200, { resources });
  } catch (error) {
    console.error('Resources error:', error);
    return createResponse(500, { error: 'Failed to fetch resources' });
  }
}

async function handleBulkImport(user: User, event: APIGatewayEvent, tableConfig: any): Promise<APIGatewayResponse> {
  if (event.httpMethod !== 'POST') {
    return createResponse(405, { error: 'Method not allowed' });
  }

  if (!hasPermission(user, tableConfig.pk, 'bulk')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { items } = body;

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
        const processedItem = {
          ...item,
          pk: tableConfig.pk,
          sk: item.id || randomUUID(),
          id: item.id || randomUUID(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          createdBy: user.id,
          updatedBy: user.id
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

    await writeAuditLog(user, 'BULK_IMPORT', tableConfig.pk, {
      imported,
      failed,
      totalItems: items.length
    });

    return createResponse(200, { imported, failed, errors });
  } catch (error) {
    console.error('Bulk import error:', error);
    return createResponse(500, { error: 'Bulk import failed' });
  }
}

async function handleTableEndpoint(user: User, event: APIGatewayEvent, tableConfig: any, pathParts: string[]): Promise<APIGatewayResponse> {
  const itemId = pathParts[2];

  switch (event.httpMethod) {
    case 'GET':
      if (itemId) {
        return await handleGetItem(user, tableConfig, itemId);
      } else {
        return await handleListItems(user, tableConfig, event.queryStringParameters);
      }
    case 'POST':
      return await handleCreateItem(user, event, tableConfig);
    case 'PUT':
      if (!itemId) {
        return createResponse(400, { error: 'Item ID required for update' });
      }
      return await handleUpdateItem(user, event, tableConfig, itemId);
    case 'DELETE':
      if (!itemId) {
        return createResponse(400, { error: 'Item ID required for delete' });
      }
      return await handleDeleteItem(user, tableConfig, itemId);
    default:
      return createResponse(405, { error: 'Method not allowed' });
  }
}

async function handleListItems(user: User, tableConfig: any, queryParams?: { [key: string]: string }): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'read')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  try {
    const command = new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': tableConfig.pk
      }
    });

    const result = await docClient.send(command);
    return createResponse(200, { items: result.Items || [] });
  } catch (error) {
    console.error('List items error:', error);
    return createResponse(500, { error: 'Failed to fetch items' });
  }
}

async function handleGetItem(user: User, tableConfig: any, itemId: string): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'read')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  try {
    const command = new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: tableConfig.pk,
        sk: itemId
      }
    });

    const result = await docClient.send(command);
    if (!result.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    return createResponse(200, result.Item);
  } catch (error) {
    console.error('Get item error:', error);
    return createResponse(500, { error: 'Failed to fetch item' });
  }
}

async function handleCreateItem(user: User, event: APIGatewayEvent, tableConfig: any): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'create')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    
    const requiredFields = getRequiredFields(tableConfig.pk);
    const validationErrors = validateRequired(body, requiredFields);
    if (validationErrors.length > 0) {
      return createResponse(400, { errors: validationErrors });
    }

    const itemId = body.id || randomUUID();
    const item = {
      ...body,
      pk: tableConfig.pk,
      sk: itemId,
      id: itemId,
      createdBy: user.id,
      updatedBy: user.id
    };

    addTimestamps(item);

    const command = new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    });

    await docClient.send(command);
    await writeAuditLog(user, 'CREATE', tableConfig.pk, { itemId });

    return createResponse(201, item);
  } catch (error) {
    console.error('Create item error:', error);
    return createResponse(500, { error: 'Failed to create item' });
  }
}

async function handleUpdateItem(user: User, event: APIGatewayEvent, tableConfig: any, itemId: string): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'update')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    
    const item = {
      ...body,
      pk: tableConfig.pk,
      sk: itemId,
      id: itemId,
      updatedBy: user.id
    };

    addTimestamps(item, true);

    const command = new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    });

    await docClient.send(command);
    await writeAuditLog(user, 'UPDATE', tableConfig.pk, { itemId });

    return createResponse(200, item);
  } catch (error) {
    console.error('Update item error:', error);
    return createResponse(500, { error: 'Failed to update item' });
  }
}

async function handleDeleteItem(user: User, tableConfig: any, itemId: string): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'delete')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  try {
    const command = new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: tableConfig.pk,
        sk: itemId
      }
    });

    await docClient.send(command);
    await writeAuditLog(user, 'DELETE', tableConfig.pk, { itemId });

    return createResponse(200, { message: 'Item deleted successfully' });
  } catch (error) {
    console.error('Delete item error:', error);
    return createResponse(500, { error: 'Failed to delete item' });
  }
}

function getRequiredFields(pk: string): string[] {
  const fieldMap: { [key: string]: string[] } = {
    'USER': ['loginId', 'passwordHash', 'userName', 'permissionLevel', 'activeFlag', 'createdBy'],
    'PRODUCT': ['productCode', 'productName', 'validFlag'],
    'SUPPLIER': ['supplierCode', 'supplierName', 'validFlag'],
    'INVENTORY': ['productId', 'currentStock', 'safetyStock', 'stockStatus'],
    'PURCHASE': ['purchaseDate', 'supplierId', 'productId', 'quantity', 'unitPrice', 'totalAmount'],
    'SALES': ['saleDate', 'productId', 'quantity', 'unitPrice', 'totalAmount', 'salesPersonId'],
    'MONTHLY': ['targetMonth', 'salesQuantity', 'salesAmount', 'purchaseQuantity', 'purchaseAmount', 'openingStock', 'closingStock', 'closingStockValue', 'grossProfit', 'grossProfitRate', 'aggregationStatus', 'aggregationDate'],
    'ORDER_REC': ['productId', 'supplierId', 'recommendationDate', 'currentStock', 'safetyStock', 'recommendedQuantity', 'expectedConsumption', 'leadTimeDays', 'priority', 'recommendationReason', 'processingStatus'],
    'PROPOSAL': ['supplierId', 'proposedProductName', 'proposalType', 'proposalContent', 'reviewStatus'],
    'CUSTOMER': ['customerCode', 'customerName', 'validFlag'],
    'PET': ['customerId', 'petName', 'species', 'registrationStatus'],
    'USAGE': ['customerId', 'usageType', 'usageDateTime', 'followUpRequired'],
    'FORECAST': ['productId', 'forecastMonth', 'forecastQuantity', 'forecastBasis', 'confidenceLevel', 'status'],
    'ORDER_HIST': ['orderNumber', 'productId', 'supplierId', 'orderQuantity', 'unitPrice', 'totalAmount', 'orderDate', 'expectedDeliveryDate', 'orderStatus'],
    'INV_ADJ': ['productId', 'adjustmentDateTime', 'adjustmentReason', 'beforeQuantity', 'afterQuantity', 'adjustmentQuantity']
  };
  
  return fieldMap[pk] || [];
}