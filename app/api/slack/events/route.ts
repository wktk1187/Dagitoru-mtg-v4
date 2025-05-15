import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { CONFIG } from '@app/lib/config';
import { SlackEventPayload, ProcessingJob } from '@app/lib/types';

// Slackのイベント受信エンドポイント
export async function POST(req: NextRequest) {
  try {
    // Slackからのリクエストを検証
    const body = await req.text();
    const timestamp = req.headers.get('x-slack-request-timestamp');
    const signature = req.headers.get('x-slack-signature');
    
    // リクエスト検証（10分以上前のリクエストは拒否）
    const now = Math.floor(Date.now() / 1000);
    if (!timestamp || Number(timestamp) < (now - 60 * 10)) {
      return NextResponse.json({ error: 'Invalid timestamp' }, { status: 401 });
    }
    
    // シグネチャ検証
    if (!signature || !verifySlackSignature(body, signature, timestamp)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }
    
    // リクエストボディをJSONとしてパース
    const jsonBody = JSON.parse(body);
    
    // URL検証チャレンジに応答
    if (jsonBody.type === 'url_verification') {
      return NextResponse.json({ challenge: jsonBody.challenge });
    }
    
    // イベントコールバック処理
    if (jsonBody.type === 'event_callback') {
      const payload = jsonBody as SlackEventPayload;
      const { event } = payload;
      
      // イベントタイプによって処理を分岐
      if (event.type === 'file_shared') {
        // ファイル共有イベント - file-handlerに転送
        await handleFileShared(payload);
      } else if (event.type === 'message' && event.files) {
        // ファイル付きメッセージ - combined-handlerに転送
        await handleCombinedContent(payload);
      } else if (event.type === 'message' && event.text && !event.files) {
        // テキストのみのメッセージ - text-handlerに転送
        await handleTextOnly(payload);
      }
    }
    
    // Slackには即時に200を返す
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Error processing Slack event:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Slackリクエストのシグネチャを検証する関数
function verifySlackSignature(body: string, signature: string, timestamp: string): boolean {
  const basestring = `v0:${timestamp}:${body}`;
  const hmac = crypto
    .createHmac('sha256', CONFIG.SLACK_SIGNING_SECRET)
    .update(basestring)
    .digest('hex');
  const computedSignature = `v0=${hmac}`;
  
  return crypto.timingSafeEqual(
    Buffer.from(computedSignature),
    Buffer.from(signature)
  );
}

// ファイル共有イベントを処理する関数
async function handleFileShared(payload: SlackEventPayload) {
  try {
    // file-handlerエンドポイントにリクエスト転送
    const response = await fetch(new URL('/api/slack/file-handler', process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    
    if (!response.ok) {
      console.error('Error forwarding to file-handler:', await response.text());
    }
  } catch (error) {
    console.error('Failed to forward to file-handler:', error);
  }
}

// テキスト+ファイル処理関数
async function handleCombinedContent(payload: SlackEventPayload) {
  try {
    // combined-handlerエンドポイントにリクエスト転送
    const response = await fetch(new URL('/api/slack/combined-handler', process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    
    if (!response.ok) {
      console.error('Error forwarding to combined-handler:', await response.text());
    }
  } catch (error) {
    console.error('Failed to forward to combined-handler:', error);
  }
}

// テキストのみ処理関数
async function handleTextOnly(payload: SlackEventPayload) {
  try {
    // text-handlerエンドポイントにリクエスト転送
    const response = await fetch(new URL('/api/slack/text-handler', process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    
    if (!response.ok) {
      console.error('Error forwarding to text-handler:', await response.text());
    }
  } catch (error) {
    console.error('Failed to forward to text-handler:', error);
  }
} 