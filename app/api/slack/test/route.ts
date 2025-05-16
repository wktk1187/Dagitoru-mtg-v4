import { NextRequest, NextResponse } from 'next/server';

// 完全にシンプル化したテストエンドポイント
export async function GET() {
  console.log('GET request to /api/slack/test');
  return new Response('Slack API Test Endpoint');
}

// 最もシンプルなチャレンジレスポンス
export async function POST(req: NextRequest) {
  try {
    console.log('POST request to /api/slack/test');
    const rawText = await req.text();
    console.log('Request body:', rawText);
    
    let data;
    
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      console.error('Invalid JSON:', e);
      return new Response('Invalid JSON', { status: 400 });
    }
    
    // URL検証の場合はチャレンジをそのまま返す
    if (data && data.type === 'url_verification') {
      console.log('Responding to URL verification challenge:', data.challenge);
      return new Response(JSON.stringify({ challenge: data.challenge }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // イベントの種類をログに記録
    if (data && data.type) {
      console.log('Received event type:', data.type);
    }
    
    // それ以外は単純にOKを返す
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Error in /api/slack/test:', error);
    return new Response('Error', { status: 500 });
  }
} 