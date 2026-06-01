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
  path: string;
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

async function handleList(tableIndex: string, user: User, queryParams: any = {}): Promise<APIGatewayResponse> {
  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!hasPermission(user, config.pk, 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const command = new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': config.pk
      }
    });

    const result = await docClient.send(command);
    return createResponse(200, { items: result.Items || [] });
  } catch (error) {
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleGet(tableIndex: string, id: string, user: User): Promise<APIGatewayResponse> {
  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!hasPermission(user, config.pk, 'read')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const command = new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: id
      }
    });

    const result = await docClient.send(command);
    if (!result.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    return createResponse(200, result.Item);
  } catch (error) {
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleCreate(tableIndex: string, data: any, user: User): Promise<APIGatewayResponse> {
  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!hasPermission(user, config.pk, 'create')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  const requiredFields = getRequiredFields(tableIndex);
  const validationErrors = validateRequired(data, requiredFields);
  if (validationErrors.length > 0) {
    return createResponse(400, { errors: validationErrors });
  }

  try {
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

    const command = new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    });

    await docClient.send(command);
    await writeAuditLog(user, 'CREATE', config.pk, { id });

    return createResponse(201, item);
  } catch (error) {
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleUpdate(tableIndex: string, id: string, data: any, user: User): Promise<APIGatewayResponse> {
  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!hasPermission(user, config.pk, 'update')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const getCommand = new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: id
      }
    });

    const existing = await docClient.send(getCommand);
    if (!existing.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    const updatedItem = {
      ...existing.Item,
      ...data,
      updatedBy: user.id
    };
    addTimestamps(updatedItem, true);

    const putCommand = new PutCommand({
      TableName: TABLE_NAME,
      Item: updatedItem
    });

    await docClient.send(putCommand);
    await writeAuditLog(user, 'UPDATE', config.pk, { id });

    return createResponse(200, updatedItem);
  } catch (error) {
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleDelete(tableIndex: string, id: string, user: User): Promise<APIGatewayResponse> {
  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!hasPermission(user, config.pk, 'delete')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  try {
    const getCommand = new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: id
      }
    });

    const existing = await docClient.send(getCommand);
    if (!existing.Item) {
      return createResponse(404, { error: 'Item not found' });
    }

    const deleteCommand = new DeleteCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: config.pk,
        sk: id
      }
    });

    await docClient.send(deleteCommand);
    await writeAuditLog(user, 'DELETE', config.pk, { id });

    return createResponse(200, { message: 'Item deleted successfully' });
  } catch (error) {
    return createResponse(500, { error: 'Internal server error' });
  }
}

async function handleBulkImport(tableIndex: string, items: any[], user: User): Promise<APIGatewayResponse> {
  const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
  if (!config) {
    return createResponse(404, { error: 'Table not found' });
  }

  if (!hasPermission(user, config.pk, 'bulk')) {
    return createResponse(403, { error: 'Insufficient permissions' });
  }

  let imported = 0;
  let failed = 0;
  const errors: string[] = [];

  try {
    const chunks = [];
    for (let i = 0; i < items.length; i += 25) {
      chunks.push(items.slice(i, i + 25));
    }

    for (const chunk of chunks) {
      const writeRequests = chunk.map(item => {
        const id = randomUUID();
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
        const batchCommand = new BatchWriteCommand({
          RequestItems: {
            [TABLE_NAME]: writeRequests
          }
        });

        await docClient.send(batchCommand);
        imported += chunk.length;
      } catch (error) {
        failed += chunk.length;
        errors.push(`Batch write failed: ${error}`);
      }
    }

    await writeAuditLog(user, 'BULK_IMPORT', config.pk, { imported, failed });

    return createResponse(200, { imported, failed, errors });
  } catch (error) {
    return createResponse(500, { error: 'Internal server error' });
  }
}

function getRequiredFields(tableIndex: string): string[] {
  const fieldMap: Record<string, string[]> = {
    '0': ['loginId', 'passwordHash', 'userName', 'authorityLevel', 'activeFlag', 'createdBy'],
    '1': ['productCode', 'productName', 'validFlag'],
    '2': ['supplierCode', 'supplierName', 'validFlag'],
    '3': ['productId', 'currentStock', 'safetyStock', 'stockStatus'],
    '4': ['purchaseDate', 'supplierId', 'productId', 'quantity', 'unitPrice', 'totalAmount'],
    '5': ['salesDate', 'productId', 'quantity', 'unitPrice', 'totalAmount', 'salesPersonId'],
    '6': ['aggregateYearMonth', 'salesQuantity', 'salesAmount', 'purchaseQuantity', 'purchaseAmount', 'openingStock', 'closingStock', 'closingStockValue', 'grossProfit', 'grossProfitRate', 'aggregateStatus', 'aggregateExecutionDate'],
    '7': ['productId', 'supplierId', 'recommendDate', 'currentStock', 'safetyStock', 'recommendedQuantity', 'expectedConsumption', 'leadTimeDays', 'priority', 'recommendReason', 'processStatus'],
    '8': ['supplierId', 'proposalProductName', 'proposalType', 'proposalContent', 'reviewStatus'],
    '9': ['customerCode', 'customerName', 'validFlag'],
    '10': ['customerId', 'petName', 'species', 'registrationStatus'],
    '11': ['customerId', 'usageType', 'usageDateTime', 'followUpRequired'],
    '12': ['productId', 'forecastYearMonth', 'forecastQuantity', 'forecastBasis', 'confidenceLevel', 'status'],
    '13': ['orderNumber', 'productId', 'supplierId', 'orderQuantity', 'orderUnitPrice', 'orderAmount', 'orderDate', 'expectedDeliveryDate', 'orderStatus'],
    '14': ['productId', 'adjustmentDateTime', 'adjustmentReasonCategory', 'beforeQuantity', 'afterQuantity', 'adjustmentQuantity']
  };
  return fieldMap[tableIndex] || [];
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  if (event.httpMethod === 'OPTIONS') {
    return createResponse(200, {});
  }

  try {
    const user = extractUserFromEvent(event);
    const pathParts = event.path.split('/').filter(p => p);
    
    if (event.path === '/resources' && event.httpMethod === 'GET') {
      if (!hasPermission(user, '*', 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }
      return createResponse(200, { tables: TABLE_CONFIGS });
    }

    if (pathParts.length < 2 || pathParts[0] !== 'api') {
      return createResponse(404, { error: 'Not found' });
    }

    const tableIndex = pathParts[1];
    const action = pathParts[2];
    const id = pathParts[3];

    if (action === 'bulk' && event.httpMethod === 'POST') {
      const body = event.body ? JSON.parse(event.body) : {};
      const items = body.items || [];
      return await handleBulkImport(tableIndex, items, user);
    }

    switch (event.httpMethod) {
      case 'GET':
        if (id) {
          return await handleGet(tableIndex, id, user);
        } else {
          return await handleList(tableIndex, user, event.queryStringParameters);
        }
      
      case 'POST':
        const createData = event.body ? JSON.parse(event.body) : {};
        return await handleCreate(tableIndex, createData, user);
      
      case 'PUT':
        if (!id) {
          return createResponse(400, { error: 'ID required for update' });
        }
        const updateData = event.body ? JSON.parse(event.body) : {};
        return await handleUpdate(tableIndex, id, updateData, user);
      
      case 'DELETE':
        if (!id) {
          return createResponse(400, { error: 'ID required for delete' });
        }
        return await handleDelete(tableIndex, id, user);
      
      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('authorization')) {
      return createResponse(401, { error: 'Unauthorized' });
    }
    return createResponse(500, { error: 'Internal server error' });
  }
};