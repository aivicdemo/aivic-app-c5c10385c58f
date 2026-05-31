import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { hasPermission, validateRole, Role } from './rbac';
import { randomUUID } from 'crypto';

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.MAIN_TABLE!;

interface AuthContext {
  userId: string;
  role: Role;
}

const TABLE_CONFIGS = {
  '0': { name: 'ログインユーザー', pk: 'USER', fields: ['ユーザーID', 'ログインID', 'パスワードハッシュ', 'ユーザー名', 'メールアドレス', '権限レベル', 'アクティブフラグ', '最終ログイン日時', '作成日時', '更新日時', '作成者'] },
  '1': { name: '商品マスタ', pk: 'PRODUCT', fields: ['商品ID', '商品コード', '商品名', '商品説明', 'カテゴリID', '仕入先ID', '標準仕入価格', '販売価格', '単位', '安全在庫数', '発注点', '有効フラグ', '作成日時', '更新日時', '作成者ID', '更新者ID'] },
  '2': { name: '仕入先マスタ', pk: 'SUPPLIER', fields: ['仕入先ID', '仕入先コード', '仕入先名', '仕入先名カナ', '郵便番号', '住所', '電話番号', 'FAX番号', 'メールアドレス', '担当者名', '支払条件', '取引開始日', '有効フラグ', '備考', '作成日時', '更新日時', '作成者ID', '更新者ID'] },
  '3': { name: '在庫管理', pk: 'INVENTORY', fields: ['在庫ID', '商品ID', '現在庫数', '安全在庫数', '最大在庫数', '在庫状態', '保管場所', '最終入庫日', '最終出庫日', '棚卸日', '備考', '作成日時', '更新日時', '作成者', '更新者'] },
  '4': { name: '仕入実績', pk: 'PURCHASE', fields: ['仕入実績ID', '仕入日', '仕入先ID', '商品ID', '仕入数量', '仕入単価', '仕入金額', '発注番号', '納品書番号', '備考', '作成日時', '更新日時', '作成者ID', '更新者ID'] },
  '5': { name: '売上実績', pk: 'SALES', fields: ['売上実績ID', '売上日', '商品ID', '売上数量', '単価', '売上金額', '顧客名', '販売担当者ID', '備考', '作成日時', '更新日時', '作成者ID'] },
  '6': { name: '月次集計', pk: 'MONTHLY', fields: ['集計ID', '集計年月', '商品ID', '仕入先ID', '売上数量', '売上金額', '仕入数量', '仕入金額', '期首在庫数量', '期末在庫数量', '期末在庫金額', '粗利益', '粗利率', '集計ステータス', '集計実行日時', '作成日時', '更新日時', '作成者'] },
  '7': { name: '発注推奨', pk: 'ORDER_RECOMMEND', fields: ['発注推奨ID', '商品ID', '仕入先ID', '推奨日', '現在在庫数', '安全在庫数', '推奨発注数', '予想消費数', 'リードタイム日数', '優先度', '推奨理由', '処理状況', '処理者ID', '処理日時', '実際発注数', '備考', '作成日時', '更新日時', '作成者ID'] },
  '8': { name: '商品提案情報', pk: 'PRODUCT_PROPOSAL', fields: ['提案ID', '仕入先ID', '提案商品名', '提案種別', '関連商品ID', '提案価格', '提案内容', '提案理由', '検討状況', '検討担当者ID', '検討コメント', '回答期限', '回答日', '採用予定数量', '採用開始予定日', '作成日時', '更新日時', '作成者ID', '更新者ID'] },
  '9': { name: '顧客マスタ', pk: 'CUSTOMER', fields: ['顧客ID', '顧客コード', '顧客名', '顧客名カナ', '郵便番号', '住所', '電話番号', 'メールアドレス', '生年月日', '性別', 'ペット名', 'ペット種別', 'ペット品種', 'ペット生年月日', 'ペット性別', '顧客ランク', '初回来店日', '最終来店日', '備考', '有効フラグ', '作成日時', '更新日時', '作成者', '更新者'] },
  '10': { name: 'ペット情報', pk: 'PET', fields: ['ペットID', '顧客ID', 'ペット名', '種別', '品種', '性別', '生年月日', '体重', '去勢避妊済み', 'アレルギー情報', '特記事項', '登録状況', '作成日時', '更新日時', '作成者', '更新者'] },
  '11': { name: '顧客利用履歴', pk: 'CUSTOMER_HISTORY', fields: ['利用履歴ID', '顧客ID', 'ペットID', '利用種別', '商品ID', '利用日時', '利用数量', '利用金額', '利用内容', '対応担当者', '満足度', 'フォローアップ要否', '作成日時', '更新日時', '作成者'] },
  '12': { name: '需要予測', pk: 'DEMAND_FORECAST', fields: ['需要予測ID', '商品ID', '予測年月', '予測数量', '予測根拠', '信頼度', '実績数量', '予測精度', '季節要因', '特別要因', 'ステータス', '作成日時', '更新日時', '作成者'] },
  '13': { name: '発注履歴', pk: 'ORDER_HISTORY', fields: ['発注履歴ID', '発注番号', '商品ID', '仕入先ID', '発注数量', '発注単価', '発注金額', '発注日', '納期予定日', '発注ステータス', '発注理由', '発注推奨ID', '備考', 'キャンセル日時', 'キャンセル理由', '作成者ID', '作成日時', '更新者ID', '更新日時'] },
  '14': { name: '在庫調整履歴', pk: 'INVENTORY_ADJUSTMENT', fields: ['調整履歴ID', '商品ID', '調整日時', '調整理由区分', '調整前数量', '調整後数量', '調整数量', '調整理由詳細', '承認者ID', '承認日時', '作成者ID', '作成日時', '更新日時'] }
};

function getAuthContext(event: APIGatewayProxyEvent): AuthContext {
  const userId = event.headers['x-user-id'] || 'anonymous';
  const roleHeader = event.headers['x-user-role'] || 'viewer';
  const role = validateRole(roleHeader);
  return { userId, role };
}

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-user-id, x-user-role'
    },
    body: JSON.stringify(body)
  };
}

async function createAuditLog(action: string, tableName: string, recordId: string, userId: string, details?: any): Promise<void> {
  const auditRecord = {
    pk: 'AUDIT',
    sk: `${Date.now()}_${randomUUID()}`,
    action,
    tableName,
    recordId,
    userId,
    timestamp: new Date().toISOString(),
    details: details || {}
  };
  
  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: auditRecord
  }));
}

function validateTableIndex(tableIndex: string): string {
  if (!TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS]) {
    throw new Error('Invalid table index');
  }
  return tableIndex;
}

function addTimestamps(item: any, isUpdate: boolean = false): any {
  const now = new Date().toISOString();
  if (!isUpdate) {
    item.作成日時 = now;
  }
  item.更新日時 = now;
  return item;
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const auth = getAuthContext(event);
    const path = event.path;
    const method = event.httpMethod;
    
    if (method === 'OPTIONS') {
      return createResponse(200, {});
    }

    // GET /resources - システム全体のリソース一覧
    if (path === '/resources' && method === 'GET') {
      if (!hasPermission(auth.role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const resources = Object.entries(TABLE_CONFIGS).map(([index, config]) => ({
        index,
        name: config.name,
        pk: config.pk,
        fields: config.fields
      }));

      return createResponse(200, { resources });
    }

    // パスパラメータの解析
    const pathMatch = path.match(/^\/api\/(\d+)(?:\/(\w+))?(?:\/(\w+))?$/);
    if (!pathMatch) {
      return createResponse(404, { error: 'Not found' });
    }

    const [, tableIndex, action, id] = pathMatch;
    
    try {
      validateTableIndex(tableIndex);
    } catch (error) {
      return createResponse(400, { error: 'Invalid table index' });
    }

    const tableConfig = TABLE_CONFIGS[tableIndex as keyof typeof TABLE_CONFIGS];
    const pk = tableConfig.pk;

    // 一括インポート: POST /api/{tableIndex}/bulk
    if (action === 'bulk' && method === 'POST') {
      if (!hasPermission(auth.role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      let requestBody;
      try {
        requestBody = JSON.parse(event.body || '{}');
      } catch (error) {
        return createResponse(400, { error: 'Invalid JSON in request body' });
      }

      if (!requestBody.items || !Array.isArray(requestBody.items)) {
        return createResponse(400, { error: 'Request body must contain items array' });
      }

      const items = requestBody.items;
      let imported = 0;
      let failed = 0;
      const errors: string[] = [];

      // 25件ずつに分割してバッチ処理
      const chunks = chunkArray(items, 25);
      
      for (const chunk of chunks) {
        const writeRequests = chunk.map((item, index) => {
          try {
            const processedItem = {
              ...item,
              pk,
              sk: item.id || randomUUID(),
              id: item.id || randomUUID()
            };
            addTimestamps(processedItem, false);
            
            return {
              PutRequest: {
                Item: processedItem
              }
            };
          } catch (error) {
            failed++;
            errors.push(`Item ${index}: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return null;
          }
        }).filter(req => req !== null);

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
            errors.push(`Batch write failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
          }
        }
      }

      // 監査ログ記録
      await createAuditLog('BULK_IMPORT', tableConfig.name, 'bulk', auth.userId, {
        imported,
        failed,
        totalItems: items.length
      });

      return createResponse(200, { imported, failed, errors });
    }

    // 一覧取得: GET /api/{tableIndex}
    if (!action && method === 'GET') {
      if (!hasPermission(auth.role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const result = await docClient.send(new ScanCommand({
        TableName: TABLE_NAME,
        FilterExpression: 'pk = :pk',
        ExpressionAttributeValues: {
          ':pk': pk
        }
      }));

      return createResponse(200, { items: result.Items || [] });
    }

    // 詳細取得: GET /api/{tableIndex}/{id}
    if (action && !id && method === 'GET') {
      if (!hasPermission(auth.role, 'read')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      const result = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk,
          sk: action
        }
      }));

      if (!result.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      return createResponse(200, { item: result.Item });
    }

    // 登録: POST /api/{tableIndex}
    if (!action && method === 'POST') {
      if (!hasPermission(auth.role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      let requestBody;
      try {
        requestBody = JSON.parse(event.body || '{}');
      } catch (error) {
        return createResponse(400, { error: 'Invalid JSON in request body' });
      }

      const id = requestBody.id || randomUUID();
      const item = {
        ...requestBody,
        pk,
        sk: id,
        id,
        作成者ID: auth.userId,
        更新者ID: auth.userId
      };
      addTimestamps(item, false);

      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      }));

      await createAuditLog('CREATE', tableConfig.name, id, auth.userId, item);

      return createResponse(201, { item });
    }

    // 更新: PUT /api/{tableIndex}/{id}
    if (action && !id && method === 'PUT') {
      if (!hasPermission(auth.role, 'write')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      let requestBody;
      try {
        requestBody = JSON.parse(event.body || '{}');
      } catch (error) {
        return createResponse(400, { error: 'Invalid JSON in request body' });
      }

      // 既存アイテムの確認
      const existingResult = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk,
          sk: action
        }
      }));

      if (!existingResult.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      const updatedItem = {
        ...existingResult.Item,
        ...requestBody,
        pk,
        sk: action,
        id: action,
        更新者ID: auth.userId
      };
      addTimestamps(updatedItem, true);

      await docClient.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: updatedItem
      }));

      await createAuditLog('UPDATE', tableConfig.name, action, auth.userId, updatedItem);

      return createResponse(200, { item: updatedItem });
    }

    // 削除: DELETE /api/{tableIndex}/{id}
    if (action && !id && method === 'DELETE') {
      if (!hasPermission(auth.role, 'delete')) {
        return createResponse(403, { error: 'Insufficient permissions' });
      }

      // 既存アイテムの確認
      const existingResult = await docClient.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: {
          pk,
          sk: action
        }
      }));

      if (!existingResult.Item) {
        return createResponse(404, { error: 'Item not found' });
      }

      await docClient.send(new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          pk,
          sk: action
        }
      }));

      await createAuditLog('DELETE', tableConfig.name, action, auth.userId, existingResult.Item);

      return createResponse(200, { message: 'Item deleted successfully' });
    }

    return createResponse(404, { error: 'Not found' });

  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, {
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};