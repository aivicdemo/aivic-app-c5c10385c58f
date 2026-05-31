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
  const auditRecord = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.id,
    action,
    resource,
    details,
    timestamp: new Date().toISOString()
  };
  
  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: auditRecord
    }));
  } catch (error) {
    console.error('Failed to write audit log:', error);
  }
}

function validateRequired(data: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (data[field] === undefined || data[field] === null || data[field] === '') {
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
      return await handleResourcesEndpoint(user, event);
    }

    if (pathParts[0] === 'api' && pathParts[1] && TABLE_CONFIGS[pathParts[1] as keyof typeof TABLE_CONFIGS]) {
      const tableIndex = pathParts[1];
      const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      
      if (pathParts[2] === 'bulk' && event.httpMethod === 'POST') {
        return await handleBulkImport(user, tableConfig, event);
      }
      
      return await handleTableEndpoint(user, tableConfig, pathParts.slice(2), event);
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
    console.error('Resources endpoint error:', error);
    return createResponse(500, { error: 'Failed to fetch resources' });
  }
}

async function handleBulkImport(user: User, tableConfig: any, event: APIGatewayEvent): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'bulk')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  if (!event.body) {
    return createResponse(400, { error: 'Request body is required' });
  }

  let requestData: { items: Record<string, unknown>[] };
  try {
    requestData = JSON.parse(event.body);
  } catch (error) {
    return createResponse(400, { error: 'Invalid JSON in request body' });
  }

  if (!Array.isArray(requestData.items)) {
    return createResponse(400, { error: 'items must be an array' });
  }

  let imported = 0;
  let failed = 0;
  const errors: string[] = [];

  try {
    const chunks = [];
    for (let i = 0; i < requestData.items.length; i += 25) {
      chunks.push(requestData.items.slice(i, i + 25));
    }

    for (const chunk of chunks) {
      const writeRequests = chunk.map(item => {
        const processedItem = {
          ...item,
          pk: tableConfig.pk,
          sk: item.id || randomUUID(),
          id: item.id || randomUUID(),
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

    await writeAuditLog(user, 'BULK_IMPORT', tableConfig.pk, {
      imported,
      failed,
      totalItems: requestData.items.length
    });

    return createResponse(200, { imported, failed, errors });
  } catch (error) {
    console.error('Bulk import error:', error);
    return createResponse(500, { error: 'Bulk import failed' });
  }
}

async function handleTableEndpoint(user: User, tableConfig: any, pathParts: string[], event: APIGatewayEvent): Promise<APIGatewayResponse> {
  const method = event.httpMethod;
  const id = pathParts[0];

  switch (method) {
    case 'GET':
      if (id) {
        return await handleGetItem(user, tableConfig, id);
      } else {
        return await handleListItems(user, tableConfig, event.queryStringParameters);
      }
    case 'POST':
      return await handleCreateItem(user, tableConfig, event.body);
    case 'PUT':
      if (!id) {
        return createResponse(400, { error: 'ID is required for PUT requests' });
      }
      return await handleUpdateItem(user, tableConfig, id, event.body);
    case 'DELETE':
      if (!id) {
        return createResponse(400, { error: 'ID is required for DELETE requests' });
      }
      return await handleDeleteItem(user, tableConfig, id);
    default:
      return createResponse(405, { error: 'Method not allowed' });
  }
}

async function handleListItems(user: User, tableConfig: any, queryParams: any): Promise<APIGatewayResponse> {
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

async function handleGetItem(user: User, tableConfig: any, id: string): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'read')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  try {
    const command = new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: tableConfig.pk,
        sk: id
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

async function handleCreateItem(user: User, tableConfig: any, body: string | null): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'create')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  if (!body) {
    return createResponse(400, { error: 'Request body is required' });
  }

  let itemData: any;
  try {
    itemData = JSON.parse(body);
  } catch (error) {
    return createResponse(400, { error: 'Invalid JSON in request body' });
  }

  const validationErrors = validateItemData(itemData, tableConfig.pk);
  if (validationErrors.length > 0) {
    return createResponse(400, { errors: validationErrors });
  }

  try {
    const id = randomUUID();
    const item = {
      ...itemData,
      pk: tableConfig.pk,
      sk: id,
      id,
      createdBy: user.id,
      updatedBy: user.id,
      ...addTimestamps(itemData)
    };

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    }));

    await writeAuditLog(user, 'CREATE', tableConfig.pk, { id });

    return createResponse(201, item);
  } catch (error) {
    console.error('Create item error:', error);
    return createResponse(500, { error: 'Failed to create item' });
  }
}

async function handleUpdateItem(user: User, tableConfig: any, id: string, body: string | null): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'update')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  if (!body) {
    return createResponse(400, { error: 'Request body is required' });
  }

  let updateData: any;
  try {
    updateData = JSON.parse(body);
  } catch (error) {
    return createResponse(400, { error: 'Invalid JSON in request body' });
  }

  try {
    const getCommand = new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: tableConfig.pk,
        sk: id
      }
    });

    const existingItem = await docClient.send(getCommand);
    if (!existingItem.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    const updatedItem = {
      ...existingItem.Item,
      ...updateData,
      updatedBy: user.id,
      ...addTimestamps(updateData, true)
    };

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedItem
    }));

    await writeAuditLog(user, 'UPDATE', tableConfig.pk, { id });

    return createResponse(200, updatedItem);
  } catch (error) {
    console.error('Update item error:', error);
    return createResponse(500, { error: 'Failed to update item' });
  }
}

async function handleDeleteItem(user: User, tableConfig: any, id: string): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'delete')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  try {
    const getCommand = new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: tableConfig.pk,
        sk: id
      }
    });

    const existingItem = await docClient.send(getCommand);
    if (!existingItem.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: tableConfig.pk,
        sk: id
      }
    }));

    await writeAuditLog(user, 'DELETE', tableConfig.pk, { id });

    return createResponse(200, { message: 'Item deleted successfully' });
  } catch (error) {
    console.error('Delete item error:', error);
    return createResponse(500, { error: 'Failed to delete item' });
  }
}

function validateItemData(data: any, pk: string): string[] {
  const errors: string[] = [];
  
  switch (pk) {
    case 'USER':
      errors.push(...validateRequired(data, ['loginId', 'passwordHash', 'userName', 'permissionLevel', 'activeFlag', 'createdBy']));
      break;
    case 'PRODUCT':
      errors.push(...validateRequired(data, ['productCode', 'productName', 'validFlag', 'createdById', 'updatedById']));
      break;
    case 'SUPPLIER':
      errors.push(...validateRequired(data, ['supplierCode', 'supplierName', 'validFlag', 'createdById', 'updatedById']));
      break;
    case 'INVENTORY':
      errors.push(...validateRequired(data, ['productId', 'currentStock', 'safetyStock', 'stockStatus', 'createdBy', 'updatedBy']));
      break;
    case 'PURCHASE':
      errors.push(...validateRequired(data, ['purchaseDate', 'supplierId', 'productId', 'quantity', 'unitPrice', 'totalAmount', 'createdById', 'updatedById']));
      break;
    case 'SALES':
      errors.push(...validateRequired(data, ['salesDate', 'productId', 'quantity', 'unitPrice', 'totalAmount', 'salesPersonId', 'createdById']));
      break;
    case 'MONTHLY':
      errors.push(...validateRequired(data, ['aggregateMonth', 'salesQuantity', 'salesAmount', 'purchaseQuantity', 'purchaseAmount', 'openingStock', 'closingStock', 'closingStockValue', 'grossProfit', 'grossProfitRate', 'aggregateStatus', 'aggregateDateTime', 'createdBy']));
      break;
    case 'ORDER_REC':
      errors.push(...validateRequired(data, ['productId', 'supplierId', 'recommendDate', 'currentStock', 'safetyStock', 'recommendedQuantity', 'expectedConsumption', 'leadTimeDays', 'priority', 'recommendReason', 'status', 'createdById']));
      break;
    case 'PROPOSAL':
      errors.push(...validateRequired(data, ['supplierId', 'proposalProductName', 'proposalType', 'proposalContent', 'reviewStatus', 'createdById', 'updatedById']));
      break;
    case 'CUSTOMER':
      errors.push(...validateRequired(data, ['customerCode', 'customerName', 'validFlag', 'createdBy', 'updatedBy']));
      break;
    case 'PET':
      errors.push(...validateRequired(data, ['customerId', 'petName', 'species', 'registrationStatus', 'createdBy', 'updatedBy']));
      break;
    case 'USAGE':
      errors.push(...validateRequired(data, ['customerId', 'usageType', 'usageDateTime', 'followUpRequired', 'createdBy']));
      break;
    case 'FORECAST':
      errors.push(...validateRequired(data, ['productId', 'forecastMonth', 'forecastQuantity', 'forecastBasis', 'confidenceLevel', 'status', 'createdBy']));
      break;
    case 'ORDER_HIST':
      errors.push(...validateRequired(data, ['orderNumber', 'productId', 'supplierId', 'orderQuantity', 'orderUnitPrice', 'orderAmount', 'orderDate', 'expectedDeliveryDate', 'orderStatus', 'createdById']));
      break;
    case 'INV_ADJ':
      errors.push(...validateRequired(data, ['productId', 'adjustmentDateTime', 'adjustmentReason', 'beforeQuantity', 'afterQuantity', 'adjustmentQuantity', 'createdById']));
      break;
  }
  
  return errors;
}