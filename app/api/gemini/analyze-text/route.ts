import { NextRequest, NextResponse } from 'next/server';
import { Client } from '@notionhq/client';
import { CONFIG } from '@app/lib/config';
import { sendSlackMessage } from '@app/lib/utils';
import axios from 'axios';

// Notionクライアント初期化
const notion = new Client({
  auth: CONFIG.NOTION_API_KEY,
});

// テキスト解析エンドポイント
export async function POST(req: NextRequest) {
  try {
    const { text, metadata = {}, jobId } = await req.json();
    
    if (!text) {
      return NextResponse.json(
        { error: 'Text content is required' },
        { status: 400 }
      );
    }
    
    // Gemini APIに送信するプロンプト
    const prompt = generateTextAnalysisPrompt(text, metadata);
    
    try {
      // Gemini APIを呼び出し
      const response = await callGeminiAPI(prompt);
      
      // レスポンスを解析して整形
      const summary = parseGeminiResponse(response);
      
      // Notionに保存
      const notionPage = await createNotionPage(summary, null, metadata);
      
      // Slackに通知（チャンネルとスレッド情報がある場合）
      if (metadata.channel && (metadata.thread_ts || metadata.ts)) {
        await sendSlackMessage(
          metadata.channel,
          `テキスト内容から議事録を作成しました: ${notionPage.url}`,
          metadata.thread_ts || metadata.ts
        );
      }
      
      return NextResponse.json({
        jobId,
        success: true,
        summary,
        notionPage
      });
    } catch (error) {
      console.error('Error in text analysis:', error);
      return NextResponse.json(
        { error: `Text analysis error: ${(error as Error).message}` },
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

// テキスト解析用のプロンプトを生成する関数
function generateTextAnalysisPrompt(text: string, metadata: any): string {
  const { date, client, consultant } = metadata;
  
  // 日付、クライアント、コンサルタントの情報を追加
  let contextInfo = '';
  if (date) contextInfo += `日付: ${date}\n`;
  if (client) contextInfo += `クライアント: ${client}\n`;
  if (consultant) contextInfo += `コンサルタント: ${consultant}\n`;
  
  return `以下のテキストを解析して、会議議事録の形式にまとめてください。
  
${contextInfo}

# テキスト内容
${text}

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
- 必要に応じて箇条書きを使用してください
- 提供されたテキストにない情報は推測せず、記載されている情報のみを使用してください
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
          maxOutputTokens: 4096,
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
      meetingName: 'テキスト分析',
      basicInfo: '情報なし',
      purpose: '',
      content: '',
      schedule: '',
      resources: '',
      notes: 'Geminiの応答解析中にエラーが発生しました'
    };
  }
}

// Notionページを作成する関数
async function createNotionPage(summary: any, transcriptUrl: string | null, metadata: any = {}) {
  try {
    const { meetingName, basicInfo, purpose, content, schedule, resources, notes } = summary;
    
    // Notionページプロパティ
    const pageProperties: any = {
      '会議名': {
        title: [
          {
            text: {
              content: meetingName || 'テキスト分析',
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
      }
    };
    
    // トランスクリプトURLがある場合は追加
    if (transcriptUrl) {
      pageProperties['Transcript_URL'] = {
        url: transcriptUrl,
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
      title: meetingName || 'テキスト分析',
    };
  } catch (error) {
    console.error('Error creating Notion page:', error);
    throw error;
  }
} 