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

function createResponse(statusCode: number, body: any) {
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
  const auditItem = {
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
    Item: auditItem
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

export const handler = async (event: any) => {
  try {
    const method = event.httpMethod;
    const path = event.path;
    const pathParams = event.pathParameters || {};
    
    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    let user: User;
    try {
      user = extractUserFromEvent(event);
    } catch (error) {
      return createResponse(401, { error: 'Unauthorized' });
    }

    // GET /resources
    if (method === 'GET' && path === '/resources') {
      if (!hasPermission(user, 'resources', 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        index,
        name: config.name,
        pk: config.pk
      }));

      return createResponse(200, { resources });
    }

    // Bulk import endpoints: POST /api/{tableIndex}/bulk
    const bulkMatch = path.match(/^\/api\/(\d+)\/bulk$/);
    if (method === 'POST' && bulkMatch) {
      const tableIndex = bulkMatch[1];
      const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      
      if (!config) {
        return createResponse(404, { error: 'Table not found' });
      }

      if (!hasPermission(user, config.pk, 'bulk')) {
        return createResponse(403, { error: 'Forbidden' });
      }

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
        const writeRequests = batch.map(item => {
          const processedItem = {
            ...item,
            pk: config.pk,
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
          imported += batch.length;
        } catch (error) {
          failed += batch.length;
          errors.push(`Batch ${Math.floor(i/25) + 1}: ${error}`);
        }
      }

      await createAuditLog(user, 'BULK_IMPORT', config.pk, { imported, failed, total: items.length });

      return createResponse(200, { imported, failed, errors });
    }

    // Table-specific CRUD operations: /api/{tableIndex}
    const tableMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?$/);
    if (tableMatch) {
      const tableIndex = tableMatch[1];
      const itemId = tableMatch[2];
      const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      
      if (!config) {
        return createResponse(404, { error: 'Table not found' });
      }

      // GET /api/{tableIndex} - List all items
      if (method === 'GET' && !itemId) {
        if (!hasPermission(user, config.pk, 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const result = await docClient.send(new ScanCommand({
          TableName: TABLE_NAME,
          FilterExpression: 'pk = :pk',
          ExpressionAttributeValues: {
            ':pk': config.pk
          }
        }));

        return createResponse(200, { items: result.Items || [] });
      }

      // GET /api/{tableIndex}/{id} - Get specific item
      if (method === 'GET' && itemId) {
        if (!hasPermission(user, config.pk, 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }

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

        return createResponse(200, result.Item);
      }

      // POST /api/{tableIndex} - Create new item
      if (method === 'POST' && !itemId) {
        if (!hasPermission(user, config.pk, 'create')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const body = JSON.parse(event.body || '{}');
        const id = body.id || randomUUID();
        
        const item = {
          ...body,
          pk: config.pk,
          sk: id,
          id,
          createdBy: user.id,
          updatedBy: user.id,
          ...addTimestamps(body)
        };

        // Basic validation based on table type
        const requiredFields = getRequiredFields(config.pk);
        const validationErrors = validateRequired(item, requiredFields);
        if (validationErrors.length > 0) {
          return createResponse(400, { errors: validationErrors });
        }

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        }));

        await createAuditLog(user, 'CREATE', config.pk, { id });

        return createResponse(201, item);
      }

      // PUT /api/{tableIndex}/{id} - Update item
      if (method === 'PUT' && itemId) {
        if (!hasPermission(user, config.pk, 'update')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const body = JSON.parse(event.body || '{}');
        
        // Check if item exists
        const existing = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: config.pk,
            sk: itemId
          }
        }));

        if (!existing.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        const updatedItem = {
          ...existing.Item,
          ...body,
          pk: config.pk,
          sk: itemId,
          id: itemId,
          updatedBy: user.id,
          ...addTimestamps(body, true)
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));

        await createAuditLog(user, 'UPDATE', config.pk, { id: itemId });

        return createResponse(200, updatedItem);
      }

      // DELETE /api/{tableIndex}/{id} - Delete item
      if (method === 'DELETE' && itemId) {
        if (!hasPermission(user, config.pk, 'delete')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        // Check if item exists
        const existing = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: config.pk,
            sk: itemId
          }
        }));

        if (!existing.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: config.pk,
            sk: itemId
          }
        }));

        await createAuditLog(user, 'DELETE', config.pk, { id: itemId });

        return createResponse(200, { message: 'Item deleted successfully' });
      }
    }

    return createResponse(404, { error: 'Endpoint not found' });

  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};

function getRequiredFields(pk: string): string[] {
  const fieldMap: Record<string, string[]> = {
    'USER': ['loginId', 'passwordHash', 'userName', 'permissionLevel', 'activeFlag', 'createdBy'],
    'PRODUCT': ['productCode', 'productName', 'validFlag'],
    'SUPPLIER': ['supplierCode', 'supplierName', 'validFlag'],
    'INVENTORY': ['productId', 'currentStock', 'safetyStock', 'stockStatus'],
    'PURCHASE': ['purchaseDate', 'supplierId', 'productId', 'quantity', 'unitPrice', 'totalAmount'],
    'SALES': ['salesDate', 'productId', 'quantity', 'unitPrice', 'totalAmount', 'salesPersonId'],
    'MONTHLY': ['targetMonth', 'salesQuantity', 'salesAmount', 'purchaseQuantity', 'purchaseAmount', 'openingStock', 'closingStock', 'closingStockValue', 'grossProfit', 'grossProfitRate', 'aggregationStatus', 'aggregationDate'],
    'ORDER_REC': ['productId', 'supplierId', 'recommendationDate', 'currentStock', 'safetyStock', 'recommendedQuantity', 'expectedConsumption', 'leadTimeDays', 'priority', 'reason', 'status'],
    'PROPOSAL': ['supplierId', 'proposalProductName', 'proposalType', 'proposalContent', 'reviewStatus'],
    'CUSTOMER': ['customerCode', 'customerName', 'validFlag'],
    'PET': ['customerId', 'petName', 'species', 'registrationStatus'],
    'USAGE': ['customerId', 'usageType', 'usageDateTime', 'followUpRequired'],
    'FORECAST': ['productId', 'forecastMonth', 'forecastQuantity', 'forecastBasis', 'confidenceLevel', 'status'],
    'ORDER_HIST': ['orderNumber', 'productId', 'supplierId', 'orderQuantity', 'orderUnitPrice', 'orderAmount', 'orderDate', 'expectedDeliveryDate', 'orderStatus'],
    'INV_ADJ': ['productId', 'adjustmentDateTime', 'adjustmentReason', 'beforeQuantity', 'afterQuantity', 'adjustmentQuantity']
  };
  
  return fieldMap[pk] || [];
}