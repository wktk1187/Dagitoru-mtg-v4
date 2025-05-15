import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { CONFIG } from '@/app/lib/config';
import { SlackEventPayload, ProcessingJob } from '@/app/lib/types';
import { sendSlackMessage, startCloudRunJob, extractDateFromText, extractNamesFromText } from '@/app/lib/utils';

// テキスト処理エンドポイント
export async function POST(req: NextRequest) {
  try {
    const payload = await req.json() as SlackEventPayload;
    const { event } = payload;
    
    // テキストが空の場合は処理しない
    if (!event.text || event.text.trim() === '') {
      return NextResponse.json({ error: 'No text content' }, { status: 400 });
    }
    
    // ボットからのメッセージは処理しない（無限ループ防止）
    if (event.bot_id) {
      return NextResponse.json({ ignored: 'Bot message' });
    }
    
    // テキスト内容から日付やクライアント情報などを抽出
    const dateStr = extractDateFromText(event.text);
    const { client, consultant } = extractNamesFromText(event.text);
    
    // 必要な情報が含まれているか確認
    const isValidContent = dateStr || client || consultant;
    if (!isValidContent) {
      // 情報が足りない場合はスキップ（オプション: ユーザーに通知することも可能）
      return NextResponse.json({ ignored: 'Insufficient information' });
    }
    
    // ジョブID生成
    const jobId = uuidv4();
    
    // ジョブ作成
    const job: ProcessingJob = {
      id: jobId,
      text: event.text,
      channel: event.channel,
      ts: event.ts,
      thread_ts: event.thread_ts,
      user: event.user,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    // テキスト処理の開始を通知
    await sendSlackMessage(
      event.channel,
      `テキスト内容を処理中です。`,
      event.thread_ts || event.ts
    );
    
    // Geminiでテキスト処理を開始
    // 注: ここでは直接Cloud Run Jobに送信せず、別のプロセスで処理する例
    // テキスト処理の場合は即時処理できることが多いため、別途API実装が必要
    
    // サンプル実装：実際にはここでGemini APIなどを呼び出してテキスト処理
    try {
      // API呼び出しのサンプル（実際の実装に置き換える）
      const response = await fetch(new URL('/api/gemini/analyze-text', process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jobId,
          text: event.text,
          metadata: {
            date: dateStr,
            client,
            consultant,
          }
        }),
      });
      
      if (!response.ok) {
        throw new Error(`API responded with status: ${response.status}`);
      }
      
      return NextResponse.json({ jobId, success: true });
    } catch (error) {
      console.error('Error processing text with Gemini:', error);
      
      // エラーの場合はCloud Run Jobをフォールバックとして使用
      await startCloudRunJob(job);
      
      return NextResponse.json({ 
        jobId, 
        success: true,
        note: 'Fallback to Cloud Run Job'
      });
    }
  } catch (error) {
    console.error('Error processing text:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
} 