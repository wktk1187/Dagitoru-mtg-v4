import { NextRequest, NextResponse } from 'next/server';

// シンプルなテストエンドポイント
export async function GET(req: NextRequest) {
  return NextResponse.json({ status: 'ok', message: 'Slack API test endpoint is working' });
}

// Slackのチャレンジテスト用エンドポイント
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    console.log('Received test request:', body);
    
    // URL検証チャレンジに応答
    if (body.type === 'url_verification') {
      console.log('Responding to URL verification challenge');
      return NextResponse.json({ challenge: body.challenge });
    }
    
    // その他のリクエスト
    return NextResponse.json({ status: 'received', body });
  } catch (error) {
    console.error('Error in test endpoint:', error);
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
} 