import { NextRequest, NextResponse } from 'next/server';

// 簡易テスト用エンドポイント
export async function POST(req: NextRequest) {
  try {
    // リクエストボディを取得
    const body = await req.text();
    console.log('Received test request body:', body);
    
    // JSONとしてパース
    const jsonBody = JSON.parse(body);
    
    // URL検証に対応
    if (jsonBody.type === 'url_verification') {
      console.log('Challenge received:', jsonBody.challenge);
      return NextResponse.json({ challenge: jsonBody.challenge });
    }
    
    // その他のリクエストには単純に200を返す
    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    console.error('Error in test endpoint:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// GETリクエストにも対応
export async function GET() {
  return NextResponse.json({ status: 'The test endpoint is working' });
} 