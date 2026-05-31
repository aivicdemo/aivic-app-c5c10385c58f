import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { User, checkPermission } from './rbac';
import * as crypto from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface TableConfig {
  name: string;
  pkField: string;
  skField?: string;
}

const TABLES: Record<string, TableConfig> = {
  '0': { name: 'LoginUser', pkField: 'userId' },
  '1': { name: 'ProductMaster', pkField: 'productId' },
  '2': { name: 'SupplierMaster', pkField: 'supplierId' },
  '3': { name: 'InventoryManagement', pkField: 'inventoryId' },
  '4': { name: 'PurchaseRecord', pkField: 'purchaseRecordId' },
  '5': { name: 'SalesRecord', pkField: 'salesRecordId' },
  '6': { name: 'MonthlySummary', pkField: 'summaryId' },
  '7': { name: 'OrderRecommendation', pkField: 'orderRecommendationId' },
  '8': { name: 'ProductProposal', pkField: 'proposalId' },
  '9': { name: 'CustomerMaster', pkField: 'customerId' },
  '10': { name: 'PetInfo', pkField: 'petId' },
  '11': { name: 'CustomerUsageHistory', pkField: 'usageHistoryId' },
  '12': { name: 'DemandForecast', pkField: 'demandForecastId' },
  '13': { name: 'OrderHistory', pkField: 'orderHistoryId' },
  '14': { name: 'InventoryAdjustmentHistory', pkField: 'adjustmentHistoryId' }
};

function getCurrentUser(event: APIGatewayProxyEvent): User {
  const role = event.headers['x-user-role'] || 'viewer';
  const userId = event.headers['x-user-id'] || 'anonymous';
  return { id: userId, role: role as 'admin' | 'operator' | 'viewer' };
}

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-user-role, x-user-id'
    },
    body: JSON.stringify(body)
  };
}

async function writeAuditLog(action: string, resource: string, userId: string, details?: any): Promise<void> {
  const auditLog = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${crypto.randomUUID()}`,
    action,
    resource,
    userId,
    timestamp: new Date().toISOString(),
    details: details || {}
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditLog
  }));
}

function addTimestamps(item: any, isUpdate: boolean = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.createdAt = now;
  }
  item.updatedAt = now;
  return item;
}

function generateId(): string {
  return crypto.randomUUID();
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

function getRequiredFields(tableIndex: string): string[] {
  const fieldMap: Record<string, string[]> = {
    '0': ['loginId', 'passwordHash', 'userName', 'authorityLevel', 'activeFlag', 'createdBy'],
    '1': ['productCode', 'productName', 'validFlag', 'createdById', 'updatedById'],
    '2': ['supplierCode', 'supplierName', 'validFlag', 'createdById', 'updatedById'],
    '3': ['productId', 'currentStock', 'safetyStock', 'stockStatus', 'createdBy', 'updatedBy'],
    '4': ['purchaseDate', 'supplierId', 'productId', 'purchaseQuantity', 'purchaseUnitPrice', 'purchaseAmount', 'createdById', 'updatedById'],
    '5': ['salesDate', 'productId', 'salesQuantity', 'unitPrice', 'salesAmount', 'salesPersonId', 'createdById'],
    '6': ['summaryYearMonth', 'salesQuantity', 'salesAmount', 'purchaseQuantity', 'purchaseAmount', 'beginningInventoryQuantity', 'endingInventoryQuantity', 'endingInventoryAmount', 'grossProfit', 'grossProfitRate', 'summaryStatus', 'summaryExecutionDateTime', 'createdBy'],
    '7': ['productId', 'supplierId', 'recommendationDate', 'currentInventoryQuantity', 'safetyStockQuantity', 'recommendedOrderQuantity', 'expectedConsumptionQuantity', 'leadTimeDays', 'priority', 'recommendationReason', 'processingStatus', 'createdById'],
    '8': ['supplierId', 'proposedProductName', 'proposalType', 'proposalContent', 'reviewStatus', 'createdById', 'updatedById'],
    '9': ['customerCode', 'customerName', 'validFlag', 'createdBy', 'updatedBy'],
    '10': ['customerId', 'petName', 'species', 'registrationStatus', 'createdBy', 'updatedBy'],
    '11': ['customerId', 'usageType', 'usageDateTime', 'followUpRequired', 'createdBy'],
    '12': ['productId', 'forecastYearMonth', 'forecastQuantity', 'forecastBasis', 'confidenceLevel', 'status', 'createdBy'],
    '13': ['orderNumber', 'productId', 'supplierId', 'orderQuantity', 'orderUnitPrice', 'orderAmount', 'orderDate', 'scheduledDeliveryDate', 'orderStatus', 'createdById'],
    '14': ['productId', 'adjustmentDateTime', 'adjustmentReasonCategory', 'beforeQuantity', 'afterQuantity', 'adjustmentQuantity', 'createdById']
  };
  return fieldMap[tableIndex] || [];
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const user = getCurrentUser(event);
    const path = event.path;
    const method = event.httpMethod;

    if (path === '/resources') {
      checkPermission(user, 'resources', 'read');
      
      const command = new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'attribute_exists(pk) AND pk <> :audit',
        ExpressionAttributeValues: {
          ':audit': 'AUDIT'
        }
      });
      
      const result = await docClient.send(command);
      return createResponse(200, { items: result.Items || [] });
    }

    const pathParts = path.split('/');
    if (pathParts.length < 3 || pathParts[1] !== 'api') {
      return createResponse(404, { error: 'Not found' });
    }

    const tableIndex = pathParts[2];
    const tableConfig = TABLES[tableIndex];
    
    if (!tableConfig) {
      return createResponse(404, { error: 'Table not found' });
    }

    const isBulkEndpoint = pathParts[3] === 'bulk';
    const itemId = pathParts[3];

    if (isBulkEndpoint && method === 'POST') {
      checkPermission(user, tableConfig.name, 'bulk');
      
      const body = JSON.parse(event.body || '{}');
      const items = body.items || [];
      
      if (!Array.isArray(items)) {
        return createResponse(400, { error: 'items must be an array' });
      }

      let imported = 0;
      let failed = 0;
      const errors: string[] = [];
      const requiredFields = getRequiredFields(tableIndex);

      const chunks = [];
      for (let i = 0; i < items.length; i += 25) {
        chunks.push(items.slice(i, i + 25));
      }

      for (const chunk of chunks) {
        const writeRequests = [];
        
        for (const item of chunk) {
          const validationErrors = validateRequired(item, requiredFields);
          if (validationErrors.length > 0) {
            failed++;
            errors.push(`Item validation failed: ${validationErrors.join(', ')}`);
            continue;
          }

          const processedItem = {
            ...item,
            [tableConfig.pkField]: item[tableConfig.pkField] || generateId(),
            pk: tableConfig.name,
            sk: item[tableConfig.pkField] || generateId()
          };
          
          addTimestamps(processedItem, false);
          
          writeRequests.push({
            PutRequest: {
              Item: processedItem
            }
          });
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
            errors.push(`Batch write failed: ${error}`);
          }
        }
      }

      await writeAuditLog('BULK_IMPORT', tableConfig.name, user.id, { imported, failed });
      
      return createResponse(200, { imported, failed, errors });
    }

    switch (method) {
      case 'GET':
        checkPermission(user, tableConfig.name, 'read');
        
        if (itemId) {
          const command = new GetCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: tableConfig.name,
              sk: itemId
            }
          });
          
          const result = await docClient.send(command);
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, result.Item);
        } else {
          const command = new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: {
              ':pk': tableConfig.name
            }
          });
          
          const result = await docClient.send(command);
          return createResponse(200, { items: result.Items || [] });
        }

      case 'POST':
        checkPermission(user, tableConfig.name, 'create');
        
        const createBody = JSON.parse(event.body || '{}');
        const requiredFieldsCreate = getRequiredFields(tableIndex);
        const createValidationErrors = validateRequired(createBody, requiredFieldsCreate);
        
        if (createValidationErrors.length > 0) {
          return createResponse(400, { errors: createValidationErrors });
        }
        
        const newId = generateId();
        const newItem = {
          ...createBody,
          [tableConfig.pkField]: newId,
          pk: tableConfig.name,
          sk: newId
        };
        
        addTimestamps(newItem, false);
        
        const createCommand = new PutCommand({
          TableName: TABLE_NAME,
          Item: newItem
        });
        
        await docClient.send(createCommand);
        await writeAuditLog('CREATE', tableConfig.name, user.id, { id: newId });
        
        return createResponse(201, newItem);

      case 'PUT':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID is required' });
        }
        
        checkPermission(user, tableConfig.name, 'update');
        
        const updateBody = JSON.parse(event.body || '{}');
        const requiredFieldsUpdate = getRequiredFields(tableIndex);
        const updateValidationErrors = validateRequired(updateBody, requiredFieldsUpdate);
        
        if (updateValidationErrors.length > 0) {
          return createResponse(400, { errors: updateValidationErrors });
        }
        
        const updatedItem = {
          ...updateBody,
          [tableConfig.pkField]: itemId,
          pk: tableConfig.name,
          sk: itemId
        };
        
        addTimestamps(updatedItem, true);
        
        const updateCommand = new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        });
        
        await docClient.send(updateCommand);
        await writeAuditLog('UPDATE', tableConfig.name, user.id, { id: itemId });
        
        return createResponse(200, updatedItem);

      case 'DELETE':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID is required' });
        }
        
        checkPermission(user, tableConfig.name, 'delete');
        
        const deleteCommand = new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.name,
            sk: itemId
          }
        });
        
        await docClient.send(deleteCommand);
        await writeAuditLog('DELETE', tableConfig.name, user.id, { id: itemId });
        
        return createResponse(200, { message: 'Item deleted successfully' });

      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error: any) {
    console.error('Error:', error);
    
    if (error.message?.includes('Access denied')) {
      return createResponse(403, { error: error.message });
    }
    
    return createResponse(500, { error: 'Internal server error' });
  }
};