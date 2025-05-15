import { Client } from '@notionhq/client';
import { logger } from '@app/lib/utils/logger';

// 環境変数からNotionの設定を取得
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_MEETINGS_DB_ID = process.env.NOTION_MEETINGS_DB_ID;

// API キーが設定されていない場合はエラーログを出力
if (!NOTION_API_KEY) {
  logger.error('NOTION_API_KEY is not set in environment variables');
}

if (!NOTION_MEETINGS_DB_ID) {
  logger.error('NOTION_MEETINGS_DB_ID is not set in environment variables');
}

// Notion クライアントの初期化
export const notionClient = new Client({
  auth: NOTION_API_KEY,
});

// 会議データベースIDを取得する関数
export function getMeetingsDbId(): string {
  if (!NOTION_MEETINGS_DB_ID) {
    throw new Error('NOTION_MEETINGS_DB_ID is not set in environment variables');
  }
  return NOTION_MEETINGS_DB_ID;
} 