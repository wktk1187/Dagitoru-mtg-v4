import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { CONFIG } from '@/app/lib/config';
import { SlackEventPayload, ProcessingJob } from '@/app/lib/types';
import { sendSlackMessage, extractDateFromText, extractNamesFromText } from '@/app/lib/utils';

// テキスト処理エンドポイント
export async function POST(req: NextRequest) {
  try {
    console.log('text-handler: Received request');
    const payload = await req.json() as SlackEventPayload;
    const { event } = payload;
    
    // テキスト内容チェック
    if (!event.text || event.text.trim() === '') {
      console.log('text-handler: No text content');
      return NextResponse.json({ error: 'No text content' }, { status: 400 });
    }
    
    console.log('text-handler: Processing text message:', event.text);
    
    // テキスト内容から日付やクライアント情報などを抽出
    const dateStr = extractDateFromText(event.text);
    const { client, consultant } = extractNamesFromText(event.text);
    
    console.log('text-handler: Extracted metadata:', { dateStr, client, consultant });
    
    // テキストのみの場合はGeminiで要約や分析が可能
    // テキストのみの場合は簡単な応答メッセージを送信
    await sendSlackMessage(
      event.channel,
      `📝 メッセージを受け取りました。\n抽出情報: ${dateStr ? `日付: ${dateStr}、` : ''}${client ? `クライアント: ${client}、` : ''}${consultant ? `コンサルタント: ${consultant}` : ''}`,
      event.thread_ts || event.ts
    );
    
    // 必要に応じてテキスト処理ジョブを作成
    const jobId = uuidv4();
    const job: ProcessingJob = {
      id: jobId,
      text: event.text,
      channel: event.channel,
      ts: event.ts,
      thread_ts: event.thread_ts,
      user: event.user,
      status: 'completed', // テキストのみなので即時完了
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    console.log('text-handler: Completed text processing job:', jobId);
    
    return NextResponse.json({ 
      jobId, 
      success: true,
      metadata: {
        date: dateStr,
        client,
        consultant
      }
    });
  } catch (error) {
    console.error('text-handler: Error processing text:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
} 