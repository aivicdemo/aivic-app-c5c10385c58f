import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE || 'inventory-management';

const TABLE_CONFIGS = {
  '0': { name: 'ログインユーザー', pk: 'USER', fields: ['userId', 'loginId', 'passwordHash', 'userName', 'email', 'role', 'isActive', 'lastLoginAt', 'createdAt', 'updatedAt', 'createdBy'] },
  '1': { name: '商品マスタ', pk: 'PRODUCT', fields: ['productId', 'productCode', 'productName', 'description', 'categoryId', 'supplierId', 'standardPurchasePrice', 'salePrice', 'unit', 'safetyStock', 'reorderPoint', 'isActive', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'] },
  '2': { name: '仕入先マスタ', pk: 'SUPPLIER', fields: ['supplierId', 'supplierCode', 'supplierName', 'supplierNameKana', 'postalCode', 'address', 'phoneNumber', 'faxNumber', 'email', 'contactPerson', 'paymentTerms', 'tradeStartDate', 'isActive', 'remarks', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'] },
  '3': { name: '在庫管理', pk: 'INVENTORY', fields: ['inventoryId', 'productId', 'currentStock', 'safetyStock', 'maxStock', 'stockStatus', 'storageLocation', 'lastInboundDate', 'lastOutboundDate', 'stocktakeDate', 'remarks', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'] },
  '4': { name: '仕入実績', pk: 'PURCHASE', fields: ['purchaseId', 'purchaseDate', 'supplierId', 'productId', 'quantity', 'unitPrice', 'totalAmount', 'orderNumber', 'deliveryNumber', 'remarks', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'] },
  '5': { name: '売上実績', pk: 'SALES', fields: ['salesId', 'salesDate', 'productId', 'quantity', 'unitPrice', 'totalAmount', 'customerName', 'salesPersonId', 'remarks', 'createdAt', 'updatedAt', 'createdBy'] },
  '6': { name: '月次集計', pk: 'MONTHLY', fields: ['aggregateId', 'targetMonth', 'productId', 'supplierId', 'salesQuantity', 'salesAmount', 'purchaseQuantity', 'purchaseAmount', 'openingStock', 'closingStock', 'closingStockValue', 'grossProfit', 'grossProfitRate', 'status', 'executedAt', 'createdAt', 'updatedAt', 'createdBy'] },
  '7': { name: '発注推奨', pk: 'ORDER_RECOMMENDATION', fields: ['recommendationId', 'productId', 'supplierId', 'recommendationDate', 'currentStock', 'safetyStock', 'recommendedQuantity', 'expectedConsumption', 'leadTimeDays', 'priority', 'reason', 'status', 'processedBy', 'processedAt', 'actualOrderQuantity', 'remarks', 'createdAt', 'updatedAt', 'createdBy'] },
  '8': { name: '商品提案情報', pk: 'PRODUCT_PROPOSAL', fields: ['proposalId', 'supplierId', 'proposedProductName', 'proposalType', 'relatedProductId', 'proposedPrice', 'proposalContent', 'proposalReason', 'reviewStatus', 'reviewerId', 'reviewComment', 'responseDeadline', 'responseDate', 'plannedQuantity', 'plannedStartDate', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'] },
  '9': { name: '顧客マスタ', pk: 'CUSTOMER', fields: ['customerId', 'customerCode', 'customerName', 'customerNameKana', 'postalCode', 'address', 'phoneNumber', 'email', 'birthDate', 'gender', 'petName', 'petType', 'petBreed', 'petBirthDate', 'petGender', 'customerRank', 'firstVisitDate', 'lastVisitDate', 'remarks', 'isActive', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'] },
  '10': { name: 'ペット情報', pk: 'PET', fields: ['petId', 'customerId', 'petName', 'type', 'breed', 'gender', 'birthDate', 'weight', 'isNeutered', 'allergyInfo', 'specialNotes', 'status', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy'] },
  '11': { name: '顧客利用履歴', pk: 'CUSTOMER_HISTORY', fields: ['historyId', 'customerId', 'petId', 'usageType', 'productId', 'usageDateTime', 'quantity', 'amount', 'usageContent', 'staff', 'satisfaction', 'needsFollowUp', 'createdAt', 'updatedAt', 'createdBy'] },
  '12': { name: '需要予測', pk: 'DEMAND_FORECAST', fields: ['forecastId', 'productId', 'forecastMonth', 'forecastQuantity', 'forecastBasis', 'confidence', 'actualQuantity', 'accuracy', 'seasonalFactor', 'specialFactors', 'status', 'createdAt', 'updatedAt', 'createdBy'] },
  '13': { name: '発注履歴', pk: 'ORDER_HISTORY', fields: ['orderHistoryId', 'orderNumber', 'productId', 'supplierId', 'orderQuantity', 'unitPrice', 'totalAmount', 'orderDate', 'expectedDeliveryDate', 'orderStatus', 'orderReason', 'recommendationId', 'remarks', 'cancelDate', 'cancelReason', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt'] },
  '14': { name: '在庫調整履歴', pk: 'INVENTORY_ADJUSTMENT', fields: ['adjustmentId', 'productId', 'adjustmentDateTime', 'adjustmentReason', 'beforeQuantity', 'afterQuantity', 'adjustmentQuantity', 'reasonDetail', 'approvedBy', 'approvedAt', 'createdBy', 'createdAt', 'updatedAt'] }
};

interface APIGatewayEvent {
  httpMethod: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  body?: string;
  headers?: { [key: string]: string };
}

interface APIResponse {
  statusCode: number;
  headers: { [key: string]: string };
  body: string;
}

function createResponse(statusCode: number, body: any): APIResponse {
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

async function createAuditLog(user: User, action: string, resource: string, details: any = {}) {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    userId: user.userId,
    userName: user.userName,
    action,
    resource,
    details,
    timestamp: new Date().toISOString()
  };
  
  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: auditLog
    }));
  } catch (error) {
    console.error('Failed to create audit log:', error);
  }
}

function validateRequiredFields(item: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (item[field] === undefined || item[field] === null || item[field] === '') {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

export const handler = async (event: APIGatewayEvent): Promise<APIResponse> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const user = extractUserFromEvent(event);
    if (!user) {
      return createResponse(401, { error: 'Unauthorized' });
    }

    const path = event.pathParameters?.proxy || '';
    const pathParts = path.split('/');
    
    if (pathParts[0] === 'resources') {
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

    const tableIndex = pathParts[0];
    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }

    const resourceName = tableConfig.name;
    
    // Bulk import endpoint
    if (pathParts[1] === 'bulk' && event.httpMethod === 'POST') {
      if (!hasPermission(user, resourceName, 'bulk')) {
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
        const writeRequests = [];
        
        for (const item of batch) {
          try {
            const now = new Date().toISOString();
            const processedItem = {
              ...item,
              pk: tableConfig.pk,
              sk: item.id || randomUUID(),
              createdAt: now,
              updatedAt: now,
              createdBy: user.userId
            };
            
            writeRequests.push({
              PutRequest: {
                Item: processedItem
              }
            });
          } catch (error) {
            failed++;
            errors.push(`Item ${i + writeRequests.length}: ${error}`);
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
      
      await createAuditLog(user, 'BULK_IMPORT', resourceName, { imported, failed, total: items.length });
      
      return createResponse(200, { imported, failed, errors });
    }

    // CRUD operations
    switch (event.httpMethod) {
      case 'GET':
        if (!hasPermission(user, resourceName, 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        if (pathParts[1]) {
          // Get single item
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: tableConfig.pk,
              sk: pathParts[1]
            }
          }));
          
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, result.Item);
        } else {
          // List items
          const limit = event.queryStringParameters?.limit ? parseInt(event.queryStringParameters.limit) : 50;
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: {
              ':pk': tableConfig.pk
            },
            Limit: Math.min(limit, 100)
          }));
          
          return createResponse(200, {
            items: result.Items || [],
            count: result.Count || 0,
            scannedCount: result.ScannedCount || 0
          });
        }

      case 'POST':
        if (!hasPermission(user, resourceName, 'create')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        const createBody = JSON.parse(event.body || '{}');
        const createErrors = validateRequiredFields(createBody, ['name']);
        
        if (createErrors.length > 0) {
          return createResponse(400, { errors: createErrors });
        }
        
        const newItem = {
          ...createBody,
          pk: tableConfig.pk,
          sk: randomUUID(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          createdBy: user.userId
        };
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: newItem
        }));
        
        await createAuditLog(user, 'CREATE', resourceName, { itemId: newItem.sk });
        
        return createResponse(201, newItem);

      case 'PUT':
        if (!hasPermission(user, resourceName, 'update')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        if (!pathParts[1]) {
          return createResponse(400, { error: 'Item ID required' });
        }
        
        const updateBody = JSON.parse(event.body || '{}');
        const updatedItem = {
          ...updateBody,
          pk: tableConfig.pk,
          sk: pathParts[1],
          updatedAt: new Date().toISOString(),
          updatedBy: user.userId
        };
        
        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));
        
        await createAuditLog(user, 'UPDATE', resourceName, { itemId: pathParts[1] });
        
        return createResponse(200, updatedItem);

      case 'DELETE':
        if (!hasPermission(user, resourceName, 'delete')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        if (!pathParts[1]) {
          return createResponse(400, { error: 'Item ID required' });
        }
        
        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.pk,
            sk: pathParts[1]
          }
        }));
        
        await createAuditLog(user, 'DELETE', resourceName, { itemId: pathParts[1] });
        
        return createResponse(200, { message: 'Item deleted successfully' });

      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};