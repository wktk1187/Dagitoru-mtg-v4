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
  console.log('Received CloudRun callback');
  
  try {
    // リクエストボディの検証
    if (!req.body) {
      console.error('Empty request body');
      return NextResponse.json(
        { error: 'Empty request body' },
        { status: 400 }
      );
    }
    
    const callback = await req.json() as CloudRunCallback;
    console.log('Callback payload:', JSON.stringify(callback));
    
    const { jobId, status, transcriptUrl, error } = callback;
    
    if (!jobId) {
      console.error('Missing jobId in callback');
      return NextResponse.json(
        { error: 'Missing jobId in callback' },
        { status: 400 }
      );
    }
    
    // 処理失敗の場合
    if (status === 'failure') {
      console.error(`Job ${jobId} failed with error: ${error}`);
      
      // Slackに失敗通知を送信
      try {
        if (callback.metadata?.channel) {
          await sendSlackMessage(
            callback.metadata.channel,
            `音声/動画処理中にエラーが発生しました: ${error || '不明なエラー'}`,
            callback.metadata.thread_ts || callback.metadata.ts
          );
        }
      } catch (slackError) {
        console.error('Failed to send error notification to Slack:', slackError);
      }
      
      return NextResponse.json({ 
        received: true, 
        status: 'error_logged',
        jobId 
      });
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
      console.log(`Fetching transcript from: ${transcriptUrl}`);
      const response = await fetch(transcriptUrl);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch transcript: ${response.status} ${response.statusText}`);
      }
      
      const transcriptData = await response.json();
      console.log(`Transcript data received: ${transcriptData.transcript.length} characters`);
      
      // Geminiで要約処理
      console.log('Starting summarization with Gemini');
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
        throw new Error(`Summarization failed: ${summaryResponse.status} ${summaryResponse.statusText}`);
      }
      
      const summaryData = await summaryResponse.json();
      console.log('Summarization completed successfully');
      
      // Notionに議事録ページを作成
      console.log('Creating Notion page');
      const notionPage = await createNotionPage(
        summaryData.summary,
        transcriptUrl,
        transcriptData.metadata
      );
      console.log(`Notion page created: ${notionPage.url}`);
      
      // Slackに完了通知
      if (transcriptData.metadata?.channel && (transcriptData.metadata.thread_ts || transcriptData.metadata.ts)) {
        try {
          await sendSlackMessage(
            transcriptData.metadata.channel,
            `✅ 音声/動画からの議事録が完成しました！\n📝 <${notionPage.url}|Notionで見る>`,
            transcriptData.metadata.thread_ts || transcriptData.metadata.ts
          );
          console.log('Slack notification sent');
        } catch (slackError) {
          console.error('Failed to send Slack notification:', slackError);
        }
      }
      
      return NextResponse.json({
        success: true,
        jobId,
        notionPageId: notionPage.id,
        notionPageUrl: notionPage.url
      });
    } catch (error) {
      console.error('Error processing transcript:', error);
      
      // エラー通知をSlackに送信
      try {
        if (callback.metadata?.channel) {
          await sendSlackMessage(
            callback.metadata.channel,
            `処理中にエラーが発生しました: ${(error as Error).message}`,
            callback.metadata.thread_ts || callback.metadata.ts
          );
        }
      } catch (slackError) {
        console.error('Failed to send error notification to Slack:', slackError);
      }
      
      return NextResponse.json(
        { 
          error: `Processing failed: ${(error as Error).message}`,
          jobId
        },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('Invalid callback payload:', error);
    return NextResponse.json(
      { error: `Invalid callback payload: ${(error as Error).message}` },
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