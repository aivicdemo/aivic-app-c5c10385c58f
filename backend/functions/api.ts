import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import * as crypto from 'crypto';

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
  const auditItem = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${crypto.randomUUID()}`,
    userId: user.id,
    action,
    resource,
    details,
    timestamp: new Date().toISOString()
  };
  
  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: auditItem
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

function addTimestamps(item: any, isUpdate = false): any {
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
      
      return await handleTableEndpoint(user, tableConfig, event, pathParts);
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

  const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
    id: index,
    name: config.name,
    pk: config.pk
  }));

  return createResponse(200, { resources });
}

async function handleBulkImport(user: User, tableConfig: any, event: APIGatewayEvent): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'bulk')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  let requestBody;
  try {
    requestBody = JSON.parse(event.body || '{}');
  } catch {
    return createResponse(400, { error: 'Invalid JSON' });
  }

  const { items } = requestBody;
  if (!Array.isArray(items)) {
    return createResponse(400, { error: 'items must be an array' });
  }

  let imported = 0;
  let failed = 0;
  const errors: string[] = [];

  // Process in batches of 25 (DynamoDB BatchWrite limit)
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25);
    const writeRequests = batch.map(item => {
      const processedItem = {
        ...item,
        pk: tableConfig.pk,
        sk: item.id || crypto.randomUUID(),
        id: item.id || crypto.randomUUID(),
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
      imported += batch.length;
    } catch (error) {
      failed += batch.length;
      errors.push(`Batch ${Math.floor(i/25) + 1}: ${error}`);
    }
  }

  await writeAuditLog(user, 'BULK_IMPORT', tableConfig.pk, { imported, failed, total: items.length });

  return createResponse(200, { imported, failed, errors });
}

async function handleTableEndpoint(user: User, tableConfig: any, event: APIGatewayEvent, pathParts: string[]): Promise<APIGatewayResponse> {
  const method = event.httpMethod;
  const id = pathParts[2];

  switch (method) {
    case 'GET':
      if (id) {
        return await handleGetItem(user, tableConfig, id);
      } else {
        return await handleListItems(user, tableConfig, event);
      }
    case 'POST':
      return await handleCreateItem(user, tableConfig, event);
    case 'PUT':
      if (!id) {
        return createResponse(400, { error: 'ID required for PUT' });
      }
      return await handleUpdateItem(user, tableConfig, id, event);
    case 'DELETE':
      if (!id) {
        return createResponse(400, { error: 'ID required for DELETE' });
      }
      return await handleDeleteItem(user, tableConfig, id);
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

    const limit = event.queryStringParameters?.limit;
    if (limit && !isNaN(parseInt(limit))) {
      params.Limit = parseInt(limit);
    }

    const result = await docClient.send(new ScanCommand(params));
    return createResponse(200, { items: result.Items || [] });
  } catch (error) {
    console.error('List items error:', error);
    return createResponse(500, { error: 'Failed to list items' });
  }
}

async function handleGetItem(user: User, tableConfig: any, id: string): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'read')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  try {
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: tableConfig.pk,
        sk: id
      }
    }));

    if (!result.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    return createResponse(200, { item: result.Item });
  } catch (error) {
    console.error('Get item error:', error);
    return createResponse(500, { error: 'Failed to get item' });
  }
}

async function handleCreateItem(user: User, tableConfig: any, event: APIGatewayEvent): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'create')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  let requestBody;
  try {
    requestBody = JSON.parse(event.body || '{}');
  } catch {
    return createResponse(400, { error: 'Invalid JSON' });
  }

  const validationErrors = validateItemData(tableConfig.pk, requestBody, false);
  if (validationErrors.length > 0) {
    return createResponse(400, { errors: validationErrors });
  }

  const id = crypto.randomUUID();
  const item = {
    ...requestBody,
    pk: tableConfig.pk,
    sk: id,
    id,
    createdBy: user.id,
    updatedBy: user.id,
    ...addTimestamps(requestBody)
  };

  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    }));

    await writeAuditLog(user, 'CREATE', tableConfig.pk, { id });
    return createResponse(201, { item });
  } catch (error) {
    console.error('Create item error:', error);
    return createResponse(500, { error: 'Failed to create item' });
  }
}

async function handleUpdateItem(user: User, tableConfig: any, id: string, event: APIGatewayEvent): Promise<APIGatewayResponse> {
  if (!hasPermission(user, tableConfig.pk, 'update')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  let requestBody;
  try {
    requestBody = JSON.parse(event.body || '{}');
  } catch {
    return createResponse(400, { error: 'Invalid JSON' });
  }

  const validationErrors = validateItemData(tableConfig.pk, requestBody, true);
  if (validationErrors.length > 0) {
    return createResponse(400, { errors: validationErrors });
  }

  const updateData = {
    ...requestBody,
    updatedBy: user.id,
    ...addTimestamps(requestBody, true)
  };

  try {
    const updateExpressions: string[] = [];
    const expressionAttributeNames: any = {};
    const expressionAttributeValues: any = {};

    Object.keys(updateData).forEach((key, index) => {
      const attrName = `#attr${index}`;
      const attrValue = `:val${index}`;
      updateExpressions.push(`${attrName} = ${attrValue}`);
      expressionAttributeNames[attrName] = key;
      expressionAttributeValues[attrValue] = updateData[key];
    });

    const result = await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: tableConfig.pk,
        sk: id
      },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    }));

    await writeAuditLog(user, 'UPDATE', tableConfig.pk, { id });
    return createResponse(200, { item: result.Attributes });
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

function validateItemData(tablePk: string, data: any, isUpdate: boolean): string[] {
  const errors: string[] = [];
  
  if (isUpdate) {
    return errors; // Skip validation for updates
  }

  switch (tablePk) {
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
    case 'ADJUST_HIST':
      errors.push(...validateRequired(data, ['productId', 'adjustmentDateTime', 'adjustmentReason', 'beforeQuantity', 'afterQuantity', 'adjustmentQuantity', 'createdById']));
      break;
  }
  
  return errors;
}