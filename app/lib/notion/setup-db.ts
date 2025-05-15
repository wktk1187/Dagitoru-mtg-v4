import { notionClient, getMeetingsDbId } from './client';
import { logger } from '@app/lib/utils/logger';

/**
 * Notionデータベースのスキーマを設定する関数
 * 会議名のみをタイトル型にし、他のフィールドはすべてテキスト型に設定
 */
export async function setupDatabaseSchema() {
  try {
    const databaseId = getMeetingsDbId();
    logger.info(`Notionデータベースのスキーマを設定します: ${databaseId}`);

    // データベーススキーマの更新
    const response = await notionClient.databases.update({
      database_id: databaseId,
      properties: {
        // タイトル型のプロパティ
        "会議名": {
          title: {}
        },
        // テキスト型のプロパティ
        "日時": {
          rich_text: {}
        },
        "クライアント名": {
          rich_text: {}
        },
        "コンサルタント名": {
          rich_text: {}
        },
        "会議の基本情報": {
          rich_text: {}
        },
        "会議の目的とアジェンダ": {
          rich_text: {}
        },
        "会議の内容": {
          rich_text: {}
        },
        "今後のスケジュール": {
          rich_text: {}
        },
        "共有情報・添付": {
          rich_text: {}
        },
        "その他特記事項": {
          rich_text: {}
        },
        "ジョブID": {
          rich_text: {}
        }
      }
    });

    logger.info(`データベーススキーマの更新が完了しました: ${response.id}`);
    return response;
  } catch (error) {
    logger.error(`データベーススキーマの更新中にエラーが発生しました: ${error}`);
    throw error;
  }
}

/**
 * 新しいNotionデータベースを作成する関数
 * @param parentPageId 親ページのID
 * @param databaseName データベースの名前
 */
export async function createMeetingsDatabase(parentPageId: string, databaseName: string = 'デジトル面談履歴テスト開発') {
  try {
    logger.info(`新しい会議データベースを作成します: ${databaseName}`);

    const response = await notionClient.databases.create({
      parent: {
        page_id: parentPageId,
        type: 'page_id'
      },
      title: [
        {
          type: 'text',
          text: {
            content: databaseName
          }
        }
      ],
      properties: {
        // タイトル型のプロパティ
        "会議名": {
          title: {}
        },
        // テキスト型のプロパティ
        "日時": {
          rich_text: {}
        },
        "クライアント名": {
          rich_text: {}
        },
        "コンサルタント名": {
          rich_text: {}
        },
        "会議の基本情報": {
          rich_text: {}
        },
        "会議の目的とアジェンダ": {
          rich_text: {}
        },
        "会議の内容": {
          rich_text: {}
        },
        "今後のスケジュール": {
          rich_text: {}
        },
        "共有情報・添付": {
          rich_text: {}
        },
        "その他特記事項": {
          rich_text: {}
        },
        "ジョブID": {
          rich_text: {}
        }
      }
    });

    logger.info(`新しいデータベースが作成されました: ${response.id}`);
    return response;
  } catch (error) {
    logger.error(`データベース作成中にエラーが発生しました: ${error}`);
    throw error;
  }
} 