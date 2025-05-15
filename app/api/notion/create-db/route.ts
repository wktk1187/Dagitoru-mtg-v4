import { NextRequest, NextResponse } from 'next/server';
import { createMeetingsDatabase } from '@app/lib/notion/setup-db';
import { logger } from '@app/lib/utils/logger';

/**
 * 新しいNotionデータベースを作成するAPIエンドポイント
 */
export async function POST(req: NextRequest) {
  try {
    // 環境変数の確認
    if (!process.env.NOTION_API_KEY) {
      return NextResponse.json(
        { error: 'NOTION_API_KEYが設定されていません' },
        { status: 500 }
      );
    }

    // リクエストボディを取得
    const requestData = await req.json();
    const { parentPageId, databaseName } = requestData;

    // 親ページIDは必須
    if (!parentPageId) {
      return NextResponse.json(
        { error: '親ページIDが必要です' },
        { status: 400 }
      );
    }

    // データベースを作成
    const response = await createMeetingsDatabase(
      parentPageId,
      databaseName || 'デジトル面談履歴テスト開発'
    );

    return NextResponse.json({
      success: true,
      message: '新しいデータベースが作成されました',
      database_id: response.id,
      database_url: (response as any).url || ''
    });

  } catch (error) {
    logger.error(`データベース作成中にエラーが発生しました: ${error}`);
    return NextResponse.json(
      { error: `データベース作成エラー: ${(error as Error).message}` },
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
    message: 'Notionデータベース作成APIは正常に動作しています'
  });
} 