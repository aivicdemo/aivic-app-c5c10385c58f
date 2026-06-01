import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { hasPermission, extractUserFromEvent, User } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE || 'inventory-management';

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
      Item: auditItem
    }));
  } catch (error) {
    console.error('Failed to write audit log:', error);
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

function getRequiredFieldsByTable(tableIndex: string): string[] {
  const fieldMap: { [key: string]: string[] } = {
    '0': ['ログインID', 'パスワードハッシュ', 'ユーザー名', '権限レベル', 'アクティブフラグ', '作成者'],
    '1': ['商品コード', '商品名', '有効フラグ'],
    '2': ['仕入先コード', '仕入先名', '有効フラグ'],
    '3': ['商品ID', '現在庫数', '安全在庫数', '在庫状態'],
    '4': ['仕入日', '仕入先ID', '商品ID', '仕入数量', '仕入単価', '仕入金額'],
    '5': ['売上日', '商品ID', '売上数量', '単価', '売上金額', '販売担当者ID'],
    '6': ['集計年月', '売上数量', '売上金額', '仕入数量', '仕入金額', '期首在庫数量', '期末在庫数量', '期末在庫金額', '粗利益', '粗利率', '集計ステータス', '集計実行日時'],
    '7': ['商品ID', '仕入先ID', '推奨日', '現在在庫数', '安全在庫数', '推奨発注数', '予想消費数', 'リードタイム日数', '優先度', '推奨理由', '処理状況'],
    '8': ['仕入先ID', '提案商品名', '提案種別', '提案内容', '検討状況'],
    '9': ['顧客コード', '顧客名', '有効フラグ', '作成者'],
    '10': ['顧客ID', 'ペット名', '種別', '登録状況'],
    '11': ['顧客ID', '利用種別', '利用日時', 'フォローアップ要否', '作成者'],
    '12': ['商品ID', '予測年月', '予測数量', '予測根拠', '信頼度', 'ステータス'],
    '13': ['発注番号', '商品ID', '仕入先ID', '発注数量', '発注単価', '発注金額', '発注日', '納期予定日', '発注ステータス'],
    '14': ['商品ID', '調整日時', '調整理由区分', '調整前数量', '調整後数量', '調整数量']
  };
  return fieldMap[tableIndex] || [];
}

export const handler = async (event: APIGatewayEvent): Promise<APIGatewayResponse> => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return createResponse(200, {});
    }

    const path = event.pathParameters?.proxy || '';
    const pathParts = path.split('/');
    
    if (pathParts[0] !== 'resources') {
      return createResponse(404, { error: 'Not found' });
    }

    let user: User;
    try {
      user = extractUserFromEvent(event);
    } catch (error) {
      return createResponse(401, { error: 'Unauthorized' });
    }

    const method = event.httpMethod;
    const tableIndex = pathParts[1];
    const itemId = pathParts[2];
    const isBulk = pathParts[2] === 'bulk';

    if (!tableIndex || !TABLE_CONFIGS[tableIndex]) {
      return createResponse(404, { error: 'Table not found' });
    }

    const tableConfig = TABLE_CONFIGS[tableIndex];
    const resource = tableConfig.name;

    // GET /resources - 全リソース一覧
    if (method === 'GET' && !tableIndex) {
      if (!hasPermission(user, '*', 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        index,
        name: config.name,
        pk: config.pk
      }));

      return createResponse(200, { resources });
    }

    // GET /resources/{tableIndex} - テーブル一覧取得
    if (method === 'GET' && tableIndex && !itemId) {
      if (!hasPermission(user, resource, 'read')) {
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
        console.error('Scan error:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // GET /resources/{tableIndex}/{id} - 詳細取得
    if (method === 'GET' && tableIndex && itemId && !isBulk) {
      if (!hasPermission(user, resource, 'read')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      try {
        const command = new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.pk,
            sk: itemId
          }
        });

        const result = await docClient.send(command);
        if (!result.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        return createResponse(200, result.Item);
      } catch (error) {
        console.error('Get error:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // POST /resources/{tableIndex} - 新規作成
    if (method === 'POST' && tableIndex && !isBulk) {
      if (!hasPermission(user, resource, 'create')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      if (!event.body) {
        return createResponse(400, { error: 'Request body is required' });
      }

      try {
        const body = JSON.parse(event.body);
        const requiredFields = getRequiredFieldsByTable(tableIndex);
        const validationErrors = validateRequiredFields(body, requiredFields);
        
        if (validationErrors.length > 0) {
          return createResponse(400, { error: 'Validation failed', details: validationErrors });
        }

        const now = new Date().toISOString();
        const id = randomUUID();
        
        const item = {
          ...body,
          pk: tableConfig.pk,
          sk: id,
          id,
          作成日時: now,
          更新日時: now,
          作成者ID: user.id,
          更新者ID: user.id
        };

        const command = new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        });

        await docClient.send(command);
        await writeAuditLog(user, 'CREATE', resource, { id });

        return createResponse(201, item);
      } catch (error) {
        console.error('Create error:', error);
        if (error instanceof SyntaxError) {
          return createResponse(400, { error: 'Invalid JSON' });
        }
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // POST /resources/{tableIndex}/bulk - 一括インポート
    if (method === 'POST' && tableIndex && isBulk) {
      if (!hasPermission(user, resource, 'bulk')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      if (!event.body) {
        return createResponse(400, { error: 'Request body is required' });
      }

      try {
        const body = JSON.parse(event.body);
        if (!body.items || !Array.isArray(body.items)) {
          return createResponse(400, { error: 'items array is required' });
        }

        const items = body.items;
        let imported = 0;
        let failed = 0;
        const errors: string[] = [];
        const now = new Date().toISOString();

        // 25件ずつに分割してバッチ処理
        for (let i = 0; i < items.length; i += 25) {
          const batch = items.slice(i, i + 25);
          const writeRequests = batch.map(item => {
            const id = item.id || randomUUID();
            return {
              PutRequest: {
                Item: {
                  ...item,
                  pk: tableConfig.pk,
                  sk: id,
                  id,
                  作成日時: now,
                  更新日時: now,
                  作成者ID: user.id,
                  更新者ID: user.id
                }
              }
            };
          });

          try {
            const command = new BatchWriteCommand({
              RequestItems: {
                [TABLE_NAME]: writeRequests
              }
            });

            const result = await docClient.send(command);
            imported += batch.length;
            
            // 未処理のアイテムがある場合の処理
            if (result.UnprocessedItems && result.UnprocessedItems[TABLE_NAME]) {
              const unprocessedCount = result.UnprocessedItems[TABLE_NAME].length;
              imported -= unprocessedCount;
              failed += unprocessedCount;
              errors.push(`${unprocessedCount} items were not processed in batch ${Math.floor(i/25) + 1}`);
            }
          } catch (error) {
            failed += batch.length;
            errors.push(`Batch ${Math.floor(i/25) + 1} failed: ${error}`);
          }
        }

        await writeAuditLog(user, 'BULK_IMPORT', resource, { imported, failed, total: items.length });

        return createResponse(200, { imported, failed, errors });
      } catch (error) {
        console.error('Bulk import error:', error);
        if (error instanceof SyntaxError) {
          return createResponse(400, { error: 'Invalid JSON' });
        }
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // PUT /resources/{tableIndex}/{id} - 更新
    if (method === 'PUT' && tableIndex && itemId) {
      if (!hasPermission(user, resource, 'update')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      if (!event.body) {
        return createResponse(400, { error: 'Request body is required' });
      }

      try {
        const body = JSON.parse(event.body);
        
        // 既存アイテムの存在確認
        const getCommand = new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.pk,
            sk: itemId
          }
        });

        const existingItem = await docClient.send(getCommand);
        if (!existingItem.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        const now = new Date().toISOString();
        const updatedItem = {
          ...existingItem.Item,
          ...body,
          pk: tableConfig.pk,
          sk: itemId,
          id: itemId,
          更新日時: now,
          更新者ID: user.id
        };

        const putCommand = new PutCommand({
          TableName: TABLE_NAME,
          Item: updatedItem
        });

        await docClient.send(putCommand);
        await writeAuditLog(user, 'UPDATE', resource, { id: itemId });

        return createResponse(200, updatedItem);
      } catch (error) {
        console.error('Update error:', error);
        if (error instanceof SyntaxError) {
          return createResponse(400, { error: 'Invalid JSON' });
        }
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    // DELETE /resources/{tableIndex}/{id} - 削除
    if (method === 'DELETE' && tableIndex && itemId) {
      if (!hasPermission(user, resource, 'delete')) {
        return createResponse(403, { error: 'Forbidden' });
      }

      try {
        // 削除前に存在確認
        const getCommand = new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.pk,
            sk: itemId
          }
        });

        const existingItem = await docClient.send(getCommand);
        if (!existingItem.Item) {
          return createResponse(404, { error: 'Item not found' });
        }

        const deleteCommand = new DeleteCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: tableConfig.pk,
            sk: itemId
          }
        });

        await docClient.send(deleteCommand);
        await writeAuditLog(user, 'DELETE', resource, { id: itemId });

        return createResponse(200, { message: 'Item deleted successfully' });
      } catch (error) {
        console.error('Delete error:', error);
        return createResponse(500, { error: 'Internal server error' });
      }
    }

    return createResponse(404, { error: 'Not found' });
  } catch (error) {
    console.error('Handler error:', error);
    return createResponse(500, { error: 'Internal server error' });
  }
};