import { NextRequest, NextResponse } from 'next/server';

// 完全にシンプル化したテストエンドポイント
export async function GET() {
  return new Response('OK');
}

// 最もシンプルなチャレンジレスポンス
export async function POST(req: NextRequest) {
  try {
    const rawText = await req.text();
    let data;
    
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return new Response('Invalid JSON', { status: 400 });
    }
    
    // URL検証の場合はチャレンジをそのまま返す
    if (data && data.type === 'url_verification') {
      return new Response(JSON.stringify({ challenge: data.challenge }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // それ以外は単純にOKを返す
    return new Response('OK');
  } catch (error) {
    return new Response('Error', { status: 500 });
  }
} 