import { notionClient, getMeetingsDbId } from './client';
import { MeetingInput, MeetingRecord, NotionPropertyValue } from './types';
import { logger } from '@app/lib/utils/logger';

/**
 * 会議記録をNotionデータベースに作成する
 */
export async function createMeetingRecord(meeting: MeetingInput): Promise<MeetingRecord> {
  try {
    const databaseId = getMeetingsDbId();
    
    logger.info(`Creating meeting record in Notion: ${meeting.title}`);
    
    // メタデータをJSON文字列に変換
    const metadataString = meeting.metadata 
      ? JSON.stringify(meeting.metadata, null, 2) 
      : "";
    
    // タスクをJSON文字列に変換
    const tasksString = meeting.tasks && meeting.tasks.length > 0 
      ? JSON.stringify(meeting.tasks, null, 2) 
      : "";
    
    // Notionページのプロパティを準備
    const properties: Record<string, any> = {
      // タイトル
      "タイトル": {
        title: [
          {
            text: {
              content: meeting.title
            }
          }
        ]
      },
      
      // 日付
      "日付": {
        date: {
          start: meeting.date
        }
      },
      
      // 要約
      "要約": {
        rich_text: [
          {
            text: {
              content: meeting.summary.substring(0, 2000) // Notionの制限に合わせる
            }
          }
        ]
      },
      
      // ジョブID
      "ジョブID": {
        rich_text: [
          {
            text: {
              content: meeting.jobId
            }
          }
        ]
      },
      
      // 参加者
      "参加者": {
        multi_select: meeting.participants.map(name => ({ name: name.substring(0, 100) }))
      }
    };
    
    // 決定事項がある場合
    if (meeting.decisions && meeting.decisions.length > 0) {
      properties["決定事項"] = {
        rich_text: [
          {
            text: {
              content: meeting.decisions.join("\n")
            }
          }
        ]
      };
    }
    
    // 文字起こしを段落ブロックに分割
    const transcriptBlocks = createTranscriptBlocks(meeting.transcript);
    
    // 基本ブロック（文字起こし以外の部分）を準備
    const baseBlocks = [
      // 文字起こし全文見出し
      {
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: [
            {
              type: "text",
              text: {
                content: "文字起こし全文"
              }
            }
          ]
        }
      },
      
      // ここに文字起こしのブロックが挿入される
      
      // タスク一覧見出し
      {
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: [
            {
              type: "text",
              text: {
                content: "タスク一覧"
              }
            }
          ]
        }
      },
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [
            {
              type: "text",
              text: {
                content: tasksString || "タスクはありません"
              }
            }
          ]
        }
      },
      
      // メタデータ見出し
      {
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: [
            {
              type: "text",
              text: {
                content: "メタデータ"
              }
            }
          ]
        }
      },
      {
        object: "block",
        type: "code",
        code: {
          rich_text: [
            {
              type: "text",
              text: {
                content: metadataString || "{}"
              }
            }
          ],
          language: "json"
        }
      }
    ];
    
    // 文字起こしのブロックを見出しの後に挿入
    const children = [
      baseBlocks[0], // 文字起こし見出し
      ...transcriptBlocks,
      ...baseBlocks.slice(1) // 残りのブロック
    ];
    
    // Notionページを作成
    const response = await notionClient.pages.create({
      parent: {
        database_id: databaseId
      },
      properties: properties,
      children: children
    });
    
    logger.info(`Successfully created meeting record: ${response.id}`);
    
    return {
      id: response.id,
      url: (response as any).url || '', // Notionの型定義に合わせてキャスト
      title: meeting.title,
      date: meeting.date,
      summary: meeting.summary
    };
    
  } catch (error) {
    logger.error(`Error creating meeting record: ${error}`);
    throw error;
  }
}

/**
 * 長いテキストを複数の段落ブロックに分割する
 * Notionでは1つのリッチテキストブロックは2000文字までの制限がある
 */
function createTranscriptBlocks(text: string, maxLength = 2000): any[] {
  if (!text) return [{
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: []
    }
  }];
  
  const blocks = [];
  
  // テキストを約2000文字ごとに分割
  for (let i = 0; i < text.length; i += maxLength) {
    const chunk = text.substring(i, i + maxLength);
    
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [
          {
            type: "text",
            text: {
              content: chunk
            }
          }
        ]
      }
    });
  }
  
  return blocks;
}

/**
 * ジョブIDから会議記録を検索する
 */
export async function findMeetingByJobId(jobId: string): Promise<MeetingRecord | null> {
  try {
    const databaseId = getMeetingsDbId();
    
    // ジョブIDでフィルタリングしてデータベースを検索
    const response = await notionClient.databases.query({
      database_id: databaseId,
      filter: {
        property: "ジョブID",
        rich_text: {
          equals: jobId
        }
      }
    });
    
    if (response.results.length === 0) {
      return null;
    }
    
    const page = response.results[0];
    
    // @ts-ignore - Notionの型が複雑なため
    const title = page.properties["タイトル"]?.title?.[0]?.plain_text || "無題";
    // @ts-ignore
    const date = page.properties["日付"]?.date?.start || new Date().toISOString();
    // @ts-ignore
    const summary = page.properties["要約"]?.rich_text?.[0]?.plain_text || "";
    
    return {
      id: page.id,
      url: (page as any).url || '',
      title,
      date,
      summary
    };
    
  } catch (error) {
    logger.error(`Error finding meeting by job ID: ${error}`);
    return null;
  }
} 