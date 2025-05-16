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
    
    // リクエストボディをJSONとしてパース
    const jsonBody = JSON.parse(body);
    console.log('Received Slack event:', JSON.stringify(jsonBody));
    
    // URL検証チャレンジに応答（最優先）
    if (jsonBody.type === 'url_verification') {
      console.log('Responding to URL verification challenge:', jsonBody.challenge);
      // チャレンジレスポンスを明示的な形式で返す
      return new Response(JSON.stringify({ challenge: jsonBody.challenge }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // シグネチャ検証は検証後に行う
    const timestamp = req.headers.get('x-slack-request-timestamp');
    const signature = req.headers.get('x-slack-signature');
    
    console.log('Request headers:', {
      timestamp,
      signature
    });
    
    // リクエスト検証（10分以上前のリクエストは拒否）
    const now = Math.floor(Date.now() / 1000);
    if (!timestamp || Number(timestamp) < (now - 60 * 10)) {
      console.error('Invalid timestamp:', timestamp);
      return NextResponse.json({ error: 'Invalid timestamp' }, { status: 401 });
    }
    
    // シグネチャ検証
    if (!signature || !verifySlackSignature(body, signature, timestamp)) {
      console.error('Invalid signature for request');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }
    
    // イベントコールバック処理
    if (jsonBody.type === 'event_callback') {
      const payload = jsonBody as SlackEventPayload;
      const { event } = payload;
      
      console.log('Processing event type:', event.type);
      
      // イベントタイプによって処理を分岐
      if (event.type === 'file_shared') {
        // ファイル共有イベント - file-handlerに転送
        console.log('Handling file_shared event');
        await handleFileShared(payload);
      } else if (event.type === 'message' && event.files) {
        // ファイル付きメッセージ - combined-handlerに転送
        console.log('Handling message with files');
        await handleCombinedContent(payload);
      } else if (event.type === 'message' && event.text && !event.files) {
        // テキストのみのメッセージ - text-handlerに転送
        console.log('Handling text-only message');
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
  try {
    const basestring = `v0:${timestamp}:${body}`;
    const hmac = crypto
      .createHmac('sha256', CONFIG.SLACK_SIGNING_SECRET)
      .update(basestring)
      .digest('hex');
    const computedSignature = `v0=${hmac}`;
    
    // シグネチャのデバッグログ
    console.log('Signature verification:', {
      expected: signature,
      computed: computedSignature
    });
    
    return crypto.timingSafeEqual(
      Buffer.from(computedSignature),
      Buffer.from(signature)
    );
  } catch (error) {
    console.error('Error verifying signature:', error);
    return false;
  }
}

// ファイル共有イベントを処理する関数
async function handleFileShared(payload: SlackEventPayload) {
  try {
    const endpointUrl = new URL('/api/slack/file-handler', process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000');
    console.log('Forwarding to file-handler:', endpointUrl.toString());
    
    // file-handlerエンドポイントにリクエスト転送
    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    
    if (!response.ok) {
      console.error('Error forwarding to file-handler:', await response.text());
    } else {
      console.log('Successfully forwarded to file-handler');
    }
  } catch (error) {
    console.error('Failed to forward to file-handler:', error);
  }
}

// テキスト+ファイル処理関数
async function handleCombinedContent(payload: SlackEventPayload) {
  try {
    // combined-handlerエンドポイントにリクエスト転送
    const endpointUrl = new URL('/api/slack/combined-handler', process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000');
    console.log('Forwarding to combined-handler:', endpointUrl.toString());
    
    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    
    if (!response.ok) {
      console.error('Error forwarding to combined-handler:', await response.text());
    } else {
      console.log('Successfully forwarded to combined-handler');
    }
  } catch (error) {
    console.error('Failed to forward to combined-handler:', error);
  }
}

// テキストのみ処理関数
async function handleTextOnly(payload: SlackEventPayload) {
  try {
    // text-handlerエンドポイントにリクエスト転送
    const endpointUrl = new URL('/api/slack/text-handler', process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000');
    console.log('Forwarding to text-handler:', endpointUrl.toString());
    
    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    
    if (!response.ok) {
      console.error('Error forwarding to text-handler:', await response.text());
    } else {
      console.log('Successfully forwarded to text-handler');
    }
  } catch (error) {
    console.error('Failed to forward to text-handler:', error);
  }
} 