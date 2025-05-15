/**
 * Notionデータベースのスキーマを設定するコマンドラインスクリプト
 * 
 * 使用方法:
 * 1. 既存のデータベースのスキーマを更新する場合:
 *    npx ts-node scripts/setup-notion-db.ts update
 * 
 * 2. 新しいデータベースを作成する場合:
 *    npx ts-node scripts/setup-notion-db.ts create <親ページID> [データベース名]
 */

import axios from 'axios';
// dotenvをrequireで読み込む
const dotenv = require('dotenv');

// 環境変数の読み込み
dotenv.config();

const API_URL = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
const NOTION_API_KEY = process.env.NOTION_API_KEY;

if (!NOTION_API_KEY) {
  console.error('エラー: NOTION_API_KEYが設定されていません。.envファイルを確認してください。');
  process.exit(1);
}

// コマンドライン引数の解析
const command = process.argv[2];
const parentPageId = process.argv[3];
const databaseName = process.argv[4];

// 共通のヘッダー
const headers = {
  'Content-Type': 'application/json'
};

/**
 * 既存のデータベースのスキーマを更新する関数
 */
async function updateDatabaseSchema() {
  try {
    console.log('既存のNotionデータベースのスキーマを更新しています...');
    
    const response = await axios.post(
      `${API_URL}/api/notion/setup-db`,
      {},
      { headers }
    );
    
    console.log('結果:', response.data);
    console.log('スキーマ更新が完了しました！');
  } catch (error: any) {
    console.error('エラー:', error.response?.data || error.message);
  }
}

/**
 * 新しいデータベースを作成する関数
 */
async function createNewDatabase(parentPageId: string, dbName?: string) {
  try {
    if (!parentPageId) {
      console.error('エラー: 親ページIDが必要です');
      console.log('使用方法: npx ts-node scripts/setup-notion-db.ts create <親ページID> [データベース名]');
      process.exit(1);
    }
    
    console.log('新しいNotionデータベースを作成しています...');
    
    const response = await axios.post(
      `${API_URL}/api/notion/create-db`,
      {
        parentPageId,
        databaseName: dbName
      },
      { headers }
    );
    
    console.log('結果:', response.data);
    console.log('データベース作成が完了しました！');
    console.log('データベースID:', response.data.database_id);
    
    if (response.data.database_url) {
      console.log('データベースURL:', response.data.database_url);
    }
    
    // 環境変数にセットするように指示
    console.log('\n次のステップ:');
    console.log('1. .envファイルに以下を追加してください:');
    console.log(`NOTION_MEETINGS_DB_ID=${response.data.database_id}`);
  } catch (error: any) {
    console.error('エラー:', error.response?.data || error.message);
  }
}

// コマンドの実行
switch (command) {
  case 'update':
    updateDatabaseSchema();
    break;
  case 'create':
    createNewDatabase(parentPageId, databaseName);
    break;
  default:
    console.log('使用方法:');
    console.log('1. 既存のデータベースのスキーマを更新する場合:');
    console.log('   npx ts-node scripts/setup-notion-db.ts update');
    console.log('2. 新しいデータベースを作成する場合:');
    console.log('   npx ts-node scripts/setup-notion-db.ts create <親ページID> [データベース名]');
    break;
} 