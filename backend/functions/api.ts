import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
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
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditRecord
  }));
}

function validateRequiredFields(item: any, requiredFields: string[]): string[] {
  const errors: string[] = [];
  for (const field of requiredFields) {
    if (!item[field]) {
      errors.push(`${field} is required`);
    }
  }
  return errors;
}

function getRequiredFieldsByTableIndex(tableIndex: string): string[] {
  const fieldMap: { [key: string]: string[] } = {
    '0': ['ログインID', 'パスワードハッシュ', 'ユーザー名', '権限レベル', 'アクティブフラグ', '作成者'],
    '1': ['商品コード', '商品名', '有効フラグ', '作成者ID', '更新者ID'],
    '2': ['仕入先コード', '仕入先名', '有効フラグ', '作成者ID', '更新者ID'],
    '3': ['商品ID', '現在庫数', '安全在庫数', '在庫状態', '作成者', '更新者'],
    '4': ['仕入日', '仕入先ID', '商品ID', '仕入数量', '仕入単価', '仕入金額', '作成者ID', '更新者ID'],
    '5': ['売上日', '商品ID', '売上数量', '単価', '売上金額', '販売担当者ID', '作成者ID'],
    '6': ['集計年月', '売上数量', '売上金額', '仕入数量', '仕入金額', '期首在庫数量', '期末在庫数量', '期末在庫金額', '粗利益', '粗利率', '集計ステータス', '集計実行日時', '作成者'],
    '7': ['商品ID', '仕入先ID', '推奨日', '現在在庫数', '安全在庫数', '推奨発注数', '予想消費数', 'リードタイム日数', '優先度', '推奨理由', '処理状況', '作成者ID'],
    '8': ['仕入先ID', '提案商品名', '提案種別', '提案内容', '検討状況', '作成者ID', '更新者ID'],
    '9': ['顧客コード', '顧客名', '有効フラグ', '作成者', '更新者'],
    '10': ['顧客ID', 'ペット名', '種別', '登録状況', '作成者', '更新者'],
    '11': ['顧客ID', '利用種別', '利用日時', 'フォローアップ要否', '作成者'],
    '12': ['商品ID', '予測年月', '予測数量', '予測根拠', '信頼度', 'ステータス', '作成者'],
    '13': ['発注番号', '商品ID', '仕入先ID', '発注数量', '発注単価', '発注金額', '発注日', '納期予定日', '発注ステータス', '作成者ID'],
    '14': ['商品ID', '調整日時', '調整理由区分', '調整前数量', '調整後数量', '調整数量', '作成者ID']
  };
  return fieldMap[tableIndex] || [];
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

    if (pathParts[0] === 'api' && pathParts[1] && TABLE_CONFIGS[pathParts[1] as keyof typeof TABLE_CONFIGS]) {
      const tableIndex = pathParts[1];
      const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
      const resourceId = pathParts[2];
      const isBulkOperation = pathParts[2] === 'bulk';
      
      if (isBulkOperation && event.httpMethod === 'POST') {
        if (!hasPermission(user, tableConfig.pk, 'bulk')) {
          return createResponse(403, { error: 'Forbidden' });
        }
        
        let requestBody;
        try {
          requestBody = JSON.parse(event.body || '{}');
        } catch (error) {
          return createResponse(400, { error: 'Invalid JSON' });
        }
        
        const items = requestBody.items || [];
        if (!Array.isArray(items)) {
          return createResponse(400, { error: 'items must be an array' });
        }
        
        const requiredFields = getRequiredFieldsByTableIndex(tableIndex);
        let imported = 0;
        let failed = 0;
        const errors: string[] = [];
        
        const chunks = [];
        for (let i = 0; i < items.length; i += 25) {
          chunks.push(items.slice(i, i + 25));
        }
        
        for (const chunk of chunks) {
          const writeRequests = [];
          
          for (const item of chunk) {
            const validationErrors = validateRequiredFields(item, requiredFields);
            if (validationErrors.length > 0) {
              failed++;
              errors.push(...validationErrors);
              continue;
            }
            
            const now = new Date().toISOString();
            const processedItem = {
              ...item,
              pk: tableConfig.pk,
              sk: item.id || randomUUID(),
              id: item.id || randomUUID(),
              作成日時: item.作成日時 || now,
              更新日時: now
            };
            
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
        
        await writeAuditLog(user, 'bulk_import', tableConfig.pk, { imported, failed });
        
        return createResponse(200, { imported, failed, errors });
      }
      
      switch (event.httpMethod) {
        case 'GET':
          if (!hasPermission(user, tableConfig.pk, 'read')) {
            return createResponse(403, { error: 'Forbidden' });
          }
          
          if (resourceId) {
            const result = await docClient.send(new GetCommand({
              TableName: TABLE_NAME,
              Key: { pk: tableConfig.pk, sk: resourceId }
            }));
            
            if (!result.Item) {
              return createResponse(404, { error: 'Resource not found' });
            }
            
            return createResponse(200, result.Item);
          } else {
            const result = await docClient.send(new QueryCommand({
              TableName: TABLE_NAME,
              KeyConditionExpression: 'pk = :pk',
              ExpressionAttributeValues: {
                ':pk': tableConfig.pk
              }
            }));
            
            return createResponse(200, { items: result.Items || [] });
          }
          
        case 'POST':
          if (!hasPermission(user, tableConfig.pk, 'create')) {
            return createResponse(403, { error: 'Forbidden' });
          }
          
          let createBody;
          try {
            createBody = JSON.parse(event.body || '{}');
          } catch (error) {
            return createResponse(400, { error: 'Invalid JSON' });
          }
          
          const createValidationErrors = validateRequiredFields(createBody, getRequiredFieldsByTableIndex(tableIndex));
          if (createValidationErrors.length > 0) {
            return createResponse(400, { errors: createValidationErrors });
          }
          
          const newId = randomUUID();
          const now = new Date().toISOString();
          const newItem = {
            ...createBody,
            pk: tableConfig.pk,
            sk: newId,
            id: newId,
            作成日時: now,
            更新日時: now
          };
          
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: newItem
          }));
          
          await writeAuditLog(user, 'create', tableConfig.pk, { id: newId });
          
          return createResponse(201, newItem);
          
        case 'PUT':
          if (!resourceId) {
            return createResponse(400, { error: 'Resource ID required' });
          }
          
          if (!hasPermission(user, tableConfig.pk, 'update')) {
            return createResponse(403, { error: 'Forbidden' });
          }
          
          let updateBody;
          try {
            updateBody = JSON.parse(event.body || '{}');
          } catch (error) {
            return createResponse(400, { error: 'Invalid JSON' });
          }
          
          const existingItem = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: tableConfig.pk, sk: resourceId }
          }));
          
          if (!existingItem.Item) {
            return createResponse(404, { error: 'Resource not found' });
          }
          
          const updatedItem = {
            ...existingItem.Item,
            ...updateBody,
            pk: tableConfig.pk,
            sk: resourceId,
            id: resourceId,
            更新日時: new Date().toISOString()
          };
          
          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: updatedItem
          }));
          
          await writeAuditLog(user, 'update', tableConfig.pk, { id: resourceId });
          
          return createResponse(200, updatedItem);
          
        case 'DELETE':
          if (!resourceId) {
            return createResponse(400, { error: 'Resource ID required' });
          }
          
          if (!hasPermission(user, tableConfig.pk, 'delete')) {
            return createResponse(403, { error: 'Forbidden' });
          }
          
          const itemToDelete = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: tableConfig.pk, sk: resourceId }
          }));
          
          if (!itemToDelete.Item) {
            return createResponse(404, { error: 'Resource not found' });
          }
          
          await docClient.send(new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { pk: tableConfig.pk, sk: resourceId }
          }));
          
          await writeAuditLog(user, 'delete', tableConfig.pk, { id: resourceId });
          
          return createResponse(200, { message: 'Resource deleted successfully' });
          
        default:
          return createResponse(405, { error: 'Method not allowed' });
      }
    }
    
    return createResponse(404, { error: 'Endpoint not found' });
    
  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};