import { NextRequest, NextResponse } from 'next/server';
import { Client } from '@notionhq/client';
import { CONFIG } from '@app/lib/config';
import { CloudRunCallback } from '@app/lib/types';
import { sendSlackMessage } from '@app/lib/utils';

// Notionクライアント初期化
const notion = new Client({
  auth: CONFIG.NOTION_API_KEY,
});

// Cloud Runからのコールバック処理エンドポイント
export async function POST(req: NextRequest) {
  try {
    const callback = await req.json() as CloudRunCallback;
    const { jobId, status, transcriptUrl, error } = callback;
    
    // 処理失敗の場合
    if (status === 'failure') {
      console.error(`Job ${jobId} failed with error: ${error}`);
      
      // TODO: エラー通知（Slack、ログ監視など）
      
      return NextResponse.json({ received: true, status: 'error_logged' });
    }
    
    // 処理成功の場合
    if (!transcriptUrl) {
      return NextResponse.json(
        { error: 'No transcript URL provided' },
        { status: 400 }
      );
    }
    
    try {
      // 文字起こし結果を取得（Cloud Storageから）
      const response = await fetch(transcriptUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch transcript: ${response.statusText}`);
      }
      
      const transcriptData = await response.json();
      
      // Geminiで要約処理
      const summaryResponse = await fetch(new URL('/api/gemini/summarize', process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jobId,
          transcript: transcriptData.transcript,
          metadata: transcriptData.metadata || {}
        }),
      });
      
      if (!summaryResponse.ok) {
        throw new Error(`Summarization failed: ${summaryResponse.statusText}`);
      }
      
      const summaryData = await summaryResponse.json();
      
      // Notionに議事録ページを作成
      const notionPage = await createNotionPage(
        summaryData.summary,
        transcriptUrl,
        transcriptData.metadata
      );
      
      // Slackに完了通知
      if (transcriptData.channel && (transcriptData.thread_ts || transcriptData.ts)) {
        await sendSlackMessage(
          transcriptData.channel,
          `議事録が完成しました！ ${notionPage.url}`,
          transcriptData.thread_ts || transcriptData.ts
        );
      }
      
      return NextResponse.json({
        success: true,
        notionPageId: notionPage.id,
        notionPageUrl: notionPage.url
      });
    } catch (error) {
      console.error('Error processing transcript:', error);
      return NextResponse.json(
        { error: `Processing failed: ${(error as Error).message}` },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('Invalid callback payload:', error);
    return NextResponse.json(
      { error: 'Invalid callback payload' },
      { status: 400 }
    );
  }
}

// Notionページを作成する関数
async function createNotionPage(summary: any, transcriptUrl: string, metadata: any = {}) {
  try {
    const { meetingName, basicInfo, purpose, content, schedule, resources, notes } = summary;
    
    // Notionページプロパティ
    const pageProperties: any = {
      '会議名': {
        title: [
          {
            text: {
              content: meetingName || '会議議事録',
            },
          },
        ],
      },
      '会議の基本情報': {
        rich_text: [
          {
            text: {
              content: basicInfo || '',
            },
          },
        ],
      },
      '会議の目的とアジェンダ': {
        rich_text: [
          {
            text: {
              content: purpose || '',
            },
          },
        ],
      },
      '会議の内容（議論と決定事項）': {
        rich_text: [
          {
            text: {
              content: content || '',
            },
          },
        ],
      },
      '今後のスケジュールとタスク管理': {
        rich_text: [
          {
            text: {
              content: schedule || '',
            },
          },
        ],
      },
      '共有情報・添付資料': {
        rich_text: [
          {
            text: {
              content: resources || '',
            },
          },
        ],
      },
      'その他特記事項': {
        rich_text: [
          {
            text: {
              content: notes || '',
            },
          },
        ],
      },
      'Transcript_URL': {
        url: transcriptUrl || null,
      },
    };
    
    // Video_URLが存在する場合は追加
    if (metadata.videoUrl) {
      pageProperties['Video_URL'] = {
        url: metadata.videoUrl,
      };
    }
    
    // NotionのDBにページを作成
    const response = await notion.pages.create({
      parent: {
        database_id: CONFIG.NOTION_DATABASE_ID,
      },
      properties: pageProperties,
    });
    
    return {
      id: response.id,
      url: (response as any).url || '',
      title: meetingName || '会議議事録',
    };
  } catch (error) {
    console.error('Error creating Notion page:', error);
    throw error;
  }
} 