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
    userId: user.userId,
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

function validateRequired(item: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (!item[field]) {
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
      
      if (pathParts[2] === 'bulk' && event.httpMethod === 'POST') {
        return await handleBulkImport(user, tableConfig, event);
      }
      
      return await handleTableEndpoint(user, tableConfig, pathParts, event);
    }

    return createResponse(404, { error: 'Endpoint not found' });
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

async function handleResourcesEndpoint(user: User, event: APIGatewayEvent): Promise<APIGatewayResponse> {
  if (!hasPermission(user, 'resources', 'read')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  if (event.httpMethod !== 'GET') {
    return createResponse(405, { error: 'Method not allowed' });
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

async function handleBulkImport(user: User, tableConfig: any, event: APIGatewayEvent): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'bulk')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  try {
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
          const processedItem = {
            ...item,
            pk: tableConfig.pk,
            sk: item.id || randomUUID(),
            id: item.id || randomUUID(),
            ...addTimestamps(item)
          };
          
          writeRequests.push({
            PutRequest: {
              Item: processedItem
            }
          });
        } catch (error) {
          failed++;
          errors.push(`Item ${i}: ${error}`);
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
          errors.push(`Batch ${Math.floor(i/25)}: ${error}`);
        }
      }
    }

    await writeAuditLog(user, 'BULK_IMPORT', tableConfig.pk, { imported, failed });

    return createResponse(200, { imported, failed, errors });
  } catch (error) {
    console.error('Bulk import error:', error);
    return createResponse(500, { error: 'Bulk import failed' });
  }
}

async function handleTableEndpoint(user: User, tableConfig: any, pathParts: string[], event: APIGatewayEvent): Promise<APIGatewayResponse> {
  const itemId = pathParts[2];
  
  switch (event.httpMethod) {
    case 'GET':
      if (itemId) {
        return await handleGetItem(user, tableConfig, itemId);
      } else {
        return await handleListItems(user, tableConfig, event);
      }
    case 'POST':
      return await handleCreateItem(user, tableConfig, event);
    case 'PUT':
      if (!itemId) {
        return createResponse(400, { error: 'Item ID required for update' });
      }
      return await handleUpdateItem(user, tableConfig, itemId, event);
    case 'DELETE':
      if (!itemId) {
        return createResponse(400, { error: 'Item ID required for delete' });
      }
      return await handleDeleteItem(user, tableConfig, itemId);
    default:
      return createResponse(405, { error: 'Method not allowed' });
  }
}

async function handleListItems(user: User, tableConfig: any, event: APIGatewayEvent): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'read')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  try {
    const params: any = {
      TableName: TABLE_NAME,
      FilterExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': tableConfig.pk
      }
    };

    const queryParams = event.queryStringParameters || {};
    if (queryParams.limit) {
      params.Limit = parseInt(queryParams.limit);
    }
    if (queryParams.lastKey) {
      params.ExclusiveStartKey = JSON.parse(decodeURIComponent(queryParams.lastKey));
    }

    const result = await docClient.send(new ScanCommand(params));
    
    return createResponse(200, {
      items: result.Items || [],
      lastKey: result.LastEvaluatedKey ? encodeURIComponent(JSON.stringify(result.LastEvaluatedKey)) : null,
      count: result.Count || 0
    });
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

    return createResponse(200, { item: result.Item });
  } catch (error) {
    console.error('Get item error:', error);
    return createResponse(500, { error: 'Failed to fetch item' });
  }
}

async function handleCreateItem(user: User, tableConfig: any, event: APIGatewayEvent): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'create')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    
    const requiredFields = getRequiredFields(tableConfig.pk);
    const validationErrors = validateRequired(body, requiredFields);
    if (validationErrors.length > 0) {
      return createResponse(400, { error: 'Validation failed', details: validationErrors });
    }

    const item = {
      ...body,
      pk: tableConfig.pk,
      sk: body.id || randomUUID(),
      id: body.id || randomUUID(),
      createdBy: user.userId,
      updatedBy: user.userId,
      ...addTimestamps(body)
    };

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    }));

    await writeAuditLog(user, 'CREATE', tableConfig.pk, { itemId: item.id });

    return createResponse(201, { item });
  } catch (error) {
    console.error('Create item error:', error);
    return createResponse(500, { error: 'Failed to create item' });
  }
}

async function handleUpdateItem(user: User, tableConfig: any, itemId: string, event: APIGatewayEvent): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'update')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  try {
    const body = JSON.parse(event.body || '{}');
    
    // Check if item exists
    const existingItem = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: tableConfig.pk,
        sk: itemId
      }
    }));

    if (!existingItem.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    const updatedItem = {
      ...existingItem.Item,
      ...body,
      pk: tableConfig.pk,
      sk: itemId,
      id: itemId,
      updatedBy: user.userId,
      ...addTimestamps(body, true)
    };

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedItem
    }));

    await writeAuditLog(user, 'UPDATE', tableConfig.pk, { itemId });

    return createResponse(200, { item: updatedItem });
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
    // Check if item exists
    const existingItem = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: tableConfig.pk,
        sk: itemId
      }
    }));

    if (!existingItem.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: tableConfig.pk,
        sk: itemId
      }
    }));

    await writeAuditLog(user, 'DELETE', tableConfig.pk, { itemId });

    return createResponse(200, { message: 'Item deleted successfully' });
  } catch (error) {
    console.error('Delete item error:', error);
    return createResponse(500, { error: 'Failed to delete item' });
  }
}

function getRequiredFields(pk: string): string[] {
  const fieldMap: Record<string, string[]> = {
    'USER': ['loginId', 'passwordHash', 'userName', 'permissionLevel', 'activeFlag'],
    'PRODUCT': ['productCode', 'productName', 'validFlag'],
    'SUPPLIER': ['supplierCode', 'supplierName', 'validFlag'],
    'INVENTORY': ['productId', 'currentStock', 'safetyStock', 'inventoryStatus'],
    'PURCHASE': ['purchaseDate', 'supplierId', 'productId', 'quantity', 'unitPrice', 'totalAmount'],
    'SALES': ['salesDate', 'productId', 'quantity', 'unitPrice', 'totalAmount', 'salesPersonId'],
    'MONTHLY': ['aggregateMonth', 'salesQuantity', 'salesAmount', 'purchaseQuantity', 'purchaseAmount', 'openingStock', 'closingStock', 'closingStockValue', 'grossProfit', 'grossProfitRate', 'aggregateStatus', 'aggregateExecutedAt'],
    'ORDER_REC': ['productId', 'supplierId', 'recommendDate', 'currentStock', 'safetyStock', 'recommendedQuantity', 'expectedConsumption', 'leadTimeDays', 'priority', 'recommendReason', 'processStatus'],
    'PROPOSAL': ['supplierId', 'proposalProductName', 'proposalType', 'proposalContent', 'reviewStatus'],
    'CUSTOMER': ['customerCode', 'customerName', 'validFlag'],
    'PET': ['customerId', 'petName', 'species', 'registrationStatus'],
    'USAGE': ['customerId', 'usageType', 'usageDateTime', 'followUpRequired'],
    'FORECAST': ['productId', 'forecastMonth', 'forecastQuantity', 'forecastBasis', 'confidence', 'status'],
    'ORDER_HIST': ['orderNumber', 'productId', 'supplierId', 'orderQuantity', 'orderUnitPrice', 'orderAmount', 'orderDate', 'expectedDeliveryDate', 'orderStatus'],
    'ADJUST_HIST': ['productId', 'adjustmentDateTime', 'adjustmentReason', 'beforeQuantity', 'afterQuantity', 'adjustmentQuantity']
  };
  
  return fieldMap[pk] || [];
}