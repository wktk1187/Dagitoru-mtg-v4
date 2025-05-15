import { NextRequest, NextResponse } from 'next/server';
import { CONFIG } from '@app/lib/config';
import axios from 'axios';

// Gemini APIでトランスクリプトを要約するエンドポイント
export async function POST(req: NextRequest) {
  try {
    const { transcript, metadata = {}, jobId } = await req.json();
    
    if (!transcript) {
      return NextResponse.json(
        { error: 'Transcript content is required' },
        { status: 400 }
      );
    }
    
    // Gemini APIに送信するプロンプト
    const prompt = generateSummaryPrompt(transcript, metadata);
    
    try {
      // Gemini APIを呼び出し
      const response = await callGeminiAPI(prompt);
      
      // レスポンスを解析して整形
      const summary = parseGeminiResponse(response);
      
      return NextResponse.json({
        jobId,
        success: true,
        summary
      });
    } catch (error) {
      console.error('Error calling Gemini API:', error);
      return NextResponse.json(
        { error: `Gemini API error: ${(error as Error).message}` },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('Invalid request payload:', error);
    return NextResponse.json(
      { error: 'Invalid request payload' },
      { status: 400 }
    );
  }
}

// 要約用のプロンプトを生成する関数
function generateSummaryPrompt(transcript: string, metadata: any): string {
  const { date, client, consultant } = metadata;
  
  // 日付、クライアント、コンサルタントの情報を追加
  let contextInfo = '';
  if (date) contextInfo += `日付: ${date}\n`;
  if (client) contextInfo += `クライアント: ${client}\n`;
  if (consultant) contextInfo += `コンサルタント: ${consultant}\n`;
  
  return `以下の会議の文字起こしを、日本語で要約して議事録形式にまとめてください。
  
${contextInfo}

# 文字起こし内容
${transcript}

# 出力形式 - 以下の7つのセクションにわけて要約してください（JSON形式）
{
  "meetingName": "会議のタイトル・議題", 
  "basicInfo": "日付、場所、参加者など",
  "purpose": "会議の目的とアジェンダ",
  "content": "会議の主要な議論と決定事項",
  "schedule": "今後のスケジュールとタスク管理",
  "resources": "共有された資料や情報",
  "notes": "その他特記事項"
}

# 指示
- 各セクションは要点をまとめた明確で簡潔な段落にしてください
- 主要な議論点と決定事項に焦点を当ててください
- 必要に応じて箇条書きを使用してください
- 対話の冗長な部分や関係のない雑談は省略してください
- 文字起こしにない情報は推測せず、記載されている情報のみを使用してください
- 要約は1000文字以内にまとめてください
- 出力は必ずJSON形式でお願いします`;
}

// Gemini APIを呼び出す関数
async function callGeminiAPI(prompt: string) {
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [
          {
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.2,
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 8192,
        }
      }
    );
    
    return response.data;
  } catch (error) {
    console.error('Gemini API error:', error);
    throw error;
  }
}

// Gemini APIのレスポンスを解析する関数
function parseGeminiResponse(response: any) {
  try {
    // レスポンスからテキスト部分を抽出
    const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!text) {
      throw new Error('No text content in Gemini response');
    }
    
    // JSONテキストを抽出（正規表現でJSONブロックを検出）
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON content found in response');
    }
    
    // JSONをパース
    const summaryJson = JSON.parse(jsonMatch[0]);
    
    // 期待されるセクションが存在するか確認
    const requiredSections = [
      'meetingName',
      'basicInfo',
      'purpose',
      'content',
      'schedule',
      'resources',
      'notes'
    ];
    
    // 不足しているセクションに空文字を設定
    for (const section of requiredSections) {
      if (!summaryJson[section]) {
        summaryJson[section] = '';
      }
    }
    
    return summaryJson;
  } catch (error) {
    console.error('Error parsing Gemini response:', error);
    // 解析エラーの場合はデフォルトの構造を返す
    return {
      meetingName: '会議議事録',
      basicInfo: '情報なし',
      purpose: '',
      content: '',
      schedule: '',
      resources: '',
      notes: 'Geminiの応答解析中にエラーが発生しました'
    };
  }
} 