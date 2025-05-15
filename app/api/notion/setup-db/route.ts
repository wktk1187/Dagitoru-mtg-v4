import { NextRequest, NextResponse } from 'next/server';
import { setupDatabaseSchema } from '@app/lib/notion/setup-db';
import { logger } from '@app/lib/utils/logger';

/**
 * Notionデータベースのスキーマを設定するAPIエンドポイント
 */
export async function POST(req: NextRequest) {
  try {
    // 環境変数の確認
    if (!process.env.NOTION_API_KEY || !process.env.NOTION_MEETINGS_DB_ID) {
      return NextResponse.json(
        { error: 'NOTION_API_KEYまたはNOTION_MEETINGS_DB_IDが設定されていません' },
        { status: 500 }
      );
    }

    // データベーススキーマの設定
    const response = await setupDatabaseSchema();

    return NextResponse.json({
      success: true,
      message: 'データベーススキーマの設定が完了しました',
      database_id: response.id
    });

  } catch (error) {
    logger.error(`データベーススキーマ設定中にエラーが発生しました: ${error}`);
    return NextResponse.json(
      { error: `スキーマ設定エラー: ${(error as Error).message}` },
      { status: 500 }
    );
  }
}

/**
 * ヘルスチェック用のエンドポイント
 */
export async function GET(req: NextRequest) {
  return NextResponse.json({
    status: 'ok',
    message: 'Notionデータベーススキーマ設定APIは正常に動作しています'
  });
} 