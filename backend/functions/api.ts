import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

const TABLE_CONFIGS = {
  '0': { name: 'ログインユーザー', pk: 'USER', fields: ['userId', 'loginId', 'passwordHash', 'userName', 'email', 'permissionLevel', 'activeFlag', 'lastLoginAt', 'createdAt', 'updatedAt', 'createdBy'] },
  '1': { name: '商品マスタ', pk: 'PRODUCT', fields: ['productId', 'productCode', 'productName', 'description', 'categoryId', 'supplierId', 'standardPurchasePrice', 'salePrice', 'unit', 'safetyStock', 'reorderPoint', 'activeFlag', 'createdAt', 'updatedAt', 'createdById', 'updatedById'] },
  '2': { name: '仕入先マスタ', pk: 'SUPPLIER', fields: ['supplierId', 'supplierCode', 'supplierName', 'supplierNameKana', 'postalCode', 'address', 'phoneNumber', 'faxNumber', 'email', 'contactPerson', 'paymentTerms', 'transactionStartDate', 'activeFlag', 'notes', 'createdAt', 'updatedAt', 'createdById', 'updatedById'] },
  '3': { name: '在庫管理', pk: 'INVENTORY', fields: ['inventoryId', 'productId', 'currentStock', 'safetyStock', 'maxStock', 'stockStatus', 'storageLocation', 'lastInboundDate', 'lastOutboundDate', 'stocktakeDate', 'notes', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'] },
  '4': { name: '仕入実績', pk: 'PURCHASE', fields: ['purchaseId', 'purchaseDate', 'supplierId', 'productId', 'quantity', 'unitPrice', 'totalAmount', 'orderNumber', 'deliveryNumber', 'notes', 'createdAt', 'updatedAt', 'createdById', 'updatedById'] },
  '5': { name: '売上実績', pk: 'SALES', fields: ['salesId', 'salesDate', 'productId', 'quantity', 'unitPrice', 'totalAmount', 'customerName', 'salesPersonId', 'notes', 'createdAt', 'updatedAt', 'createdById'] },
  '6': { name: '月次集計', pk: 'MONTHLY', fields: ['aggregationId', 'targetMonth', 'productId', 'supplierId', 'salesQuantity', 'salesAmount', 'purchaseQuantity', 'purchaseAmount', 'openingStock', 'closingStock', 'closingStockValue', 'grossProfit', 'grossProfitRate', 'aggregationStatus', 'executedAt', 'createdAt', 'updatedAt', 'createdBy'] },
  '7': { name: '発注推奨', pk: 'ORDER_RECOMMENDATION', fields: ['recommendationId', 'productId', 'supplierId', 'recommendationDate', 'currentStock', 'safetyStock', 'recommendedQuantity', 'expectedConsumption', 'leadTimeDays', 'priority', 'reason', 'status', 'processedById', 'processedAt', 'actualOrderQuantity', 'notes', 'createdAt', 'updatedAt', 'createdById'] },
  '8': { name: '商品提案情報', pk: 'PRODUCT_PROPOSAL', fields: ['proposalId', 'supplierId', 'proposalProductName', 'proposalType', 'relatedProductId', 'proposalPrice', 'proposalContent', 'proposalReason', 'reviewStatus', 'reviewerId', 'reviewComment', 'responseDeadline', 'responseDate', 'plannedQuantity', 'plannedStartDate', 'createdAt', 'updatedAt', 'createdById', 'updatedById'] },
  '9': { name: '顧客マスタ', pk: 'CUSTOMER', fields: ['customerId', 'customerCode', 'customerName', 'customerNameKana', 'postalCode', 'address', 'phoneNumber', 'email', 'birthDate', 'gender', 'petName', 'petType', 'petBreed', 'petBirthDate', 'petGender', 'customerRank', 'firstVisitDate', 'lastVisitDate', 'notes', 'activeFlag', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'] },
  '10': { name: 'ペット情報', pk: 'PET', fields: ['petId', 'customerId', 'petName', 'type', 'breed', 'gender', 'birthDate', 'weight', 'neutered', 'allergyInfo', 'notes', 'status', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'] },
  '11': { name: '顧客利用履歴', pk: 'CUSTOMER_HISTORY', fields: ['historyId', 'customerId', 'petId', 'usageType', 'productId', 'usageDateTime', 'quantity', 'amount', 'usageContent', 'staff', 'satisfaction', 'followUpRequired', 'createdAt', 'updatedAt', 'createdBy'] },
  '12': { name: '需要予測', pk: 'DEMAND_FORECAST', fields: ['forecastId', 'productId', 'forecastMonth', 'forecastQuantity', 'forecastBasis', 'confidence', 'actualQuantity', 'accuracy', 'seasonalFactor', 'specialFactors', 'status', 'createdAt', 'updatedAt', 'createdBy'] },
  '13': { name: '発注履歴', pk: 'ORDER_HISTORY', fields: ['orderHistoryId', 'orderNumber', 'productId', 'supplierId', 'orderQuantity', 'unitPrice', 'totalAmount', 'orderDate', 'expectedDeliveryDate', 'orderStatus', 'orderReason', 'recommendationId', 'notes', 'cancelDate', 'cancelReason', 'createdById', 'createdAt', 'updatedById', 'updatedAt'] },
  '14': { name: '在庫調整履歴', pk: 'INVENTORY_ADJUSTMENT', fields: ['adjustmentId', 'productId', 'adjustmentDateTime', 'reasonCategory', 'quantityBefore', 'quantityAfter', 'adjustmentQuantity', 'reasonDetail', 'approverId', 'approvedAt', 'createdById', 'createdAt', 'updatedAt'] }
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

async function createAuditLog(user: User, action: string, resource: string, details: any) {
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
      return await handleResourcesEndpoint(event, user);
    }

    if (pathParts[0] === 'api' && pathParts[1] && pathParts[2] === 'bulk') {
      return await handleBulkImport(event, user, pathParts[1]);
    }

    if (pathParts[0] === 'api' && pathParts[1]) {
      const tableIndex = pathParts[1];
      const itemId = pathParts[2];
      return await handleTableEndpoint(event, user, tableIndex, itemId);
    }

    return createResponse(404, { error: 'Endpoint not found' });
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

async function handleResourcesEndpoint(event: APIGatewayEvent, user: User): Promise<APIGatewayResponse> {
  if (event.httpMethod !== 'GET') {
    return createResponse(405, { error: 'Method not allowed' });
  }

  if (!hasPermission(user, 'resources', 'read')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
    index,
    name: config.name,
    pk: config.pk,
    fields: config.fields
  }));

  return createResponse(200, { resources });
}

async function handleBulkImport(event: APIGatewayEvent, user: User, tableIndex: string): Promise<APIGatewayResponse> {
  if (event.httpMethod !== 'POST') {
    return createResponse(405, { error: 'Method not allowed' });
  }

  if (!hasPermission(user, 'bulk', 'bulk')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  let requestBody;
  try {
    requestBody = JSON.parse(event.body || '{}');
  } catch (error) {
    return createResponse(400, { error: 'Invalid JSON' });
  }

  const { items } = requestBody;
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
      const now = new Date().toISOString();
      const processedItem = {
        ...item,
        pk: config.pk,
        sk: item.id || randomUUID(),
        createdAt: now,
        updatedAt: now,
        createdBy: user.userId
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

  await createAuditLog(user, 'BULK_IMPORT', config.name, {
    tableIndex,
    imported,
    failed,
    totalItems: items.length
  });

  return createResponse(200, { imported, failed, errors });
}

async function handleTableEndpoint(event: APIGatewayEvent, user: User, tableIndex: string, itemId?: string): Promise<APIGatewayResponse> {
  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  switch (event.httpMethod) {
    case 'GET':
      if (itemId) {
        return await getItem(user, config, itemId);
      } else {
        return await listItems(user, config);
      }
    case 'POST':
      return await createItem(event, user, config);
    case 'PUT':
      if (!itemId) {
        return createResponse(400, { error: 'Item ID required for update' });
      }
      return await updateItem(event, user, config, itemId);
    case 'DELETE':
      if (!itemId) {
        return createResponse(400, { error: 'Item ID required for delete' });
      }
      return await deleteItem(user, config, itemId);
    default:
      return createResponse(405, { error: 'Method not allowed' });
  }
}

async function listItems(user: User, config: any): Promise<APIGatewayResponse> {
  if (!hasPermission(user, config.name, 'read')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  try {
    const result = await docClient.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': config.pk
      }
    }));

    return createResponse(200, { items: result.Items || [] });
  } catch (error) {
    console.error('List items error:', error);
    return createResponse(500, { error: 'Failed to retrieve items' });
  }
}

async function getItem(user: User, config: any, itemId: string): Promise<APIGatewayResponse> {
  if (!hasPermission(user, config.name, 'read')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  try {
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

    return createResponse(200, { item: result.Item });
  } catch (error) {
    console.error('Get item error:', error);
    return createResponse(500, { error: 'Failed to retrieve item' });
  }
}

async function createItem(event: APIGatewayEvent, user: User, config: any): Promise<APIGatewayResponse> {
  if (!hasPermission(user, config.name, 'create')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  let requestBody;
  try {
    requestBody = JSON.parse(event.body || '{}');
  } catch (error) {
    return createResponse(400, { error: 'Invalid JSON' });
  }

  const now = new Date().toISOString();
  const itemId = randomUUID();
  const item = {
    ...requestBody,
    pk: config.pk,
    sk: itemId,
    createdAt: now,
    updatedAt: now,
    createdBy: user.userId
  };

  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    }));

    await createAuditLog(user, 'CREATE', config.name, { itemId, item });

    return createResponse(201, { item });
  } catch (error) {
    console.error('Create item error:', error);
    return createResponse(500, { error: 'Failed to create item' });
  }
}

async function updateItem(event: APIGatewayEvent, user: User, config: any, itemId: string): Promise<APIGatewayResponse> {
  if (!hasPermission(user, config.name, 'update')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  let requestBody;
  try {
    requestBody = JSON.parse(event.body || '{}');
  } catch (error) {
    return createResponse(400, { error: 'Invalid JSON' });
  }

  const now = new Date().toISOString();
  const updateExpression = 'SET updatedAt = :updatedAt, updatedBy = :updatedBy';
  const expressionAttributeValues: any = {
    ':updatedAt': now,
    ':updatedBy': user.userId
  };

  Object.keys(requestBody).forEach((key, index) => {
    if (key !== 'pk' && key !== 'sk') {
      const placeholder = `:val${index}`;
      updateExpression += `, ${key} = ${placeholder}`;
      expressionAttributeValues[placeholder] = requestBody[key];
    }
  });

  try {
    const result = await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: itemId
      },
      UpdateExpression: updateExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    }));

    await createAuditLog(user, 'UPDATE', config.name, { itemId, updates: requestBody });

    return createResponse(200, { item: result.Attributes });
  } catch (error) {
    console.error('Update item error:', error);
    return createResponse(500, { error: 'Failed to update item' });
  }
}

async function deleteItem(user: User, config: any, itemId: string): Promise<APIGatewayResponse> {
  if (!hasPermission(user, config.name, 'delete')) {
    return createResponse(403, { error: 'Forbidden' });
  }

  try {
    const result = await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: itemId
      },
      ReturnValues: 'ALL_OLD'
    }));

    if (!result.Attributes) {
      return createResponse(404, { error: 'Item not found' });
    }

    await createAuditLog(user, 'DELETE', config.name, { itemId, deletedItem: result.Attributes });

    return createResponse(200, { message: 'Item deleted successfully' });
  } catch (error) {
    console.error('Delete item error:', error);
    return createResponse(500, { error: 'Failed to delete item' });
  }
}