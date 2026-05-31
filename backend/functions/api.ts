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
    userId: user.id,
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
    console.error('Failed to write audit log:', error);
  }
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

function getRequiredFields(tableIndex: string): string[] {
  const fieldMap: Record<string, string[]> = {
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
      if (!hasPermission(user, 'system', 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }
      
      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        index,
        name: config.name,
        pk: config.pk
      }));
      
      return createResponse(200, { resources });
    }

    if (pathParts.length < 2) {
      return createResponse(400, { error: 'Invalid path' });
    }

    const tableIndex = pathParts[1];
    const config = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    
    if (!config) {
      return createResponse(404, { error: 'Table not found' });
    }

    const isBulkOperation = pathParts[2] === 'bulk';
    const itemId = pathParts[2] && !isBulkOperation ? pathParts[2] : null;

    switch (event.httpMethod) {
      case 'GET':
        if (!hasPermission(user, config.name, 'read')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        if (itemId) {
          const result = await docClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: config.pk, sk: itemId }
          }));
          
          if (!result.Item) {
            return createResponse(404, { error: 'Item not found' });
          }
          
          return createResponse(200, result.Item);
        } else {
          const result = await docClient.send(new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: 'pk = :pk',
            ExpressionAttributeValues: { ':pk': config.pk }
          }));
          
          return createResponse(200, { items: result.Items || [] });
        }

      case 'POST':
        if (isBulkOperation) {
          if (!hasPermission(user, config.name, 'bulk')) {
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

          for (let i = 0; i < items.length; i += 25) {
            const batch = items.slice(i, i + 25);
            const writeRequests = batch.map(item => {
              const now = new Date().toISOString();
              const processedItem = {
                ...item,
                pk: config.pk,
                sk: item.id || randomUUID(),
                createdAt: now,
                updatedAt: now
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

          await writeAuditLog(user, 'BULK_IMPORT', config.name, { imported, failed });
          
          return createResponse(200, { imported, failed, errors });
        } else {
          if (!hasPermission(user, config.name, 'create')) {
            return createResponse(403, { error: 'Forbidden' });
          }

          const body = JSON.parse(event.body || '{}');
          const requiredFields = getRequiredFields(tableIndex);
          const validationErrors = validateRequired(body, requiredFields);
          
          if (validationErrors.length > 0) {
            return createResponse(400, { errors: validationErrors });
          }

          const now = new Date().toISOString();
          const item = {
            ...body,
            pk: config.pk,
            sk: body.id || randomUUID(),
            createdAt: now,
            updatedAt: now
          };

          await docClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: item
          }));

          await writeAuditLog(user, 'CREATE', config.name, { id: item.sk });
          
          return createResponse(201, item);
        }

      case 'PUT':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID required' });
        }
        
        if (!hasPermission(user, config.name, 'update')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const updateBody = JSON.parse(event.body || '{}');
        const updateRequiredFields = getRequiredFields(tableIndex);
        const updateValidationErrors = validateRequired(updateBody, updateRequiredFields);
        
        if (updateValidationErrors.length > 0) {
          return createResponse(400, { errors: updateValidationErrors });
        }

        const existingItem = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk: config.pk, sk: itemId }
        }));
        
        if (!existingItem.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        const updatedItem = {
          ...existingItem.Item,
          ...updateBody,
          pk: config.pk,
          sk: itemId,
          updatedAt: new Date().toISOString()
        };

        await docClient.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        }));

        await writeAuditLog(user, 'UPDATE', config.name, { id: itemId });
        
        return createResponse(200, updatedItem);

      case 'DELETE':
        if (!itemId) {
          return createResponse(400, { error: 'Item ID required' });
        }
        
        if (!hasPermission(user, config.name, 'delete')) {
          return createResponse(403, { error: 'Forbidden' });
        }

        const deleteItem = await docClient.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: { pk: config.pk, sk: itemId }
        }));
        
        if (!deleteItem.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        await docClient.send(new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { pk: config.pk, sk: itemId }
        }));

        await writeAuditLog(user, 'DELETE', config.name, { id: itemId });
        
        return createResponse(200, { message: 'Item deleted successfully' });

      default:
        return createResponse(405, { error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};