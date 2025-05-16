import { WebClient } from '@slack/web-api';
import { Storage } from '@google-cloud/storage';
import { PubSub } from '@google-cloud/pubsub';
import axios from 'axios';
import { CONFIG, getGCSPath } from './config';
import { SlackFile, ProcessingJob } from './types';
import { EventProcessor } from './kv-store';

// イベント処理インスタンスの作成
const eventProcessor = new EventProcessor();

// Base64でエンコードされたサービスアカウントJSONをデコードする関数
function getGoogleCredentials() {
  try {
    // 環境変数からBase64エンコードされたJSON文字列を取得
    const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (!credentialsJson) {
      console.error('Google credentials not found in environment variables');
      return null;
    }
    
    // Base64デコード
    const decodedCredentials = Buffer.from(credentialsJson, 'base64').toString('utf-8');
    
    // デコードされたJSONをパース
    const credentials = JSON.parse(decodedCredentials);
    
    // プロジェクトIDの確認
    if (!credentials.project_id) {
      console.error('project_id not found in credentials');
      // 環境変数から取得したプロジェクトIDを追加
      credentials.project_id = process.env.GCP_PROJECT_ID || '';
    }
    
    return credentials;
  } catch (error) {
    console.error('Failed to parse Google credentials:', error);
    return null;
  }
}

// 認証情報の取得
const googleCredentials = getGoogleCredentials();

// Slackクライアント初期化
const slackClient = new WebClient(CONFIG.SLACK_TOKEN);

// GCSクライアント初期化
const storage = new Storage({
  credentials: googleCredentials,
  projectId: CONFIG.GCP_PROJECT_ID
});
const bucket = storage.bucket(CONFIG.GCS_BUCKET_NAME);

// PubSubクライアント初期化
const pubsub = new PubSub({
  credentials: googleCredentials,
  projectId: CONFIG.GCP_PROJECT_ID
});
// デフォルトのトピック名を設定
const topicName = CONFIG.PUBSUB_TOPIC || 'dagitoru-topic';
const topic = pubsub.topic(topicName);

/**
 * Slackにメッセージを送信する関数
 * Vercel KVを使用して重複送信を防止
 */
export async function sendSlackMessage(channel: string, text: string, thread_ts?: string) {
  try {
    // 重複防止のためのキーを生成
    const messageKey = `${channel}_${thread_ts || 'main'}_${text.substring(0, 100)}`;
    
    // KVを使用して送信済みかどうかを確認
    const isSent = await eventProcessor.isMessageSentOrMark(messageKey);
    
    // すでに送信済みの場合はスキップ
    if (isSent) {
      console.log(`重複メッセージをスキップしました: ${messageKey}`);
      return true; // 送信成功として扱う
    }
    
    // メッセージを送信
    await slackClient.chat.postMessage({
      channel,
      text,
      thread_ts
    });
    
    console.log(`メッセージを送信しました: ${messageKey}`);
    return true;
  } catch (error) {
    console.error('Slack message sending failed:', error);
    return false;
  }
}

// ファイルをGCSにアップロードする関数
export async function uploadFileToGCS(fileUrl: string, jobId: string, filename: string) {
  try {
    console.log(`[GCS_UPLOAD] ファイルをSlackからダウンロード開始: ${filename}, URL: ${fileUrl.substring(0, 50)}...`);
    
    // Slackからファイルをダウンロード
    const response = await axios.get(fileUrl, {
      headers: {
        Authorization: `Bearer ${CONFIG.SLACK_TOKEN}`,
      },
      responseType: 'arraybuffer',
      // タイムアウト設定を追加（60秒）
      timeout: 60000
    });
    
    console.log(`[GCS_UPLOAD] ファイルをSlackからダウンロード完了: ${filename}, サイズ: ${response.data.length} バイト`);
    
    if (!response.data || response.data.length === 0) {
      throw new Error('ダウンロードしたファイルが空です');
    }
    
    // GCS保存先パス
    const gcsPath = getGCSPath(jobId, filename);
    console.log(`[GCS_UPLOAD] GCSへのアップロード開始: ${gcsPath}`);
    
    // バケット名のログ出力
    console.log(`[GCS_UPLOAD] バケット名: ${CONFIG.GCS_BUCKET_NAME}`);
    
    // ファイルオブジェクトを作成
    const file = bucket.file(gcsPath);
    
    // メタデータを含めて保存
    await file.save(response.data, {
      metadata: {
        contentType: response.headers['content-type'] || 'application/octet-stream',
        metadata: {
          sourceUrl: fileUrl,
          jobId: jobId,
          originalName: filename,
          uploadTime: new Date().toISOString()
        }
      }
    });
    
    console.log(`[GCS_UPLOAD] GCSへのアップロード完了: ${gcsPath}`);
    
    // アップロード検証（存在確認）
    const [exists] = await file.exists();
    if (!exists) {
      throw new Error('ファイルはアップロードされましたが、GCSに存在しません');
    }
    
    console.log(`[GCS_UPLOAD] ファイル存在確認成功: ${gcsPath}`);
    
    return {
      success: true,
      path: gcsPath,
      url: `gs://${CONFIG.GCS_BUCKET_NAME}/${gcsPath}`
    };
  } catch (error) {
    console.error('[GCS_UPLOAD_ERROR] ファイルアップロード失敗:', error);
    
    // エラーの詳細情報を記録
    const errorDetails = {
      message: error instanceof Error ? error.message : '不明なエラー',
      stack: error instanceof Error ? error.stack : null,
      fileUrl: fileUrl ? fileUrl.substring(0, 30) + '...' : 'undefined',
      jobId,
      filename,
      time: new Date().toISOString()
    };
    
    console.error('[GCS_UPLOAD_ERROR] 詳細:', JSON.stringify(errorDetails));
    
    return {
      success: false,
      error: error instanceof Error ? error.message : '不明なエラー'
    };
  }
}

// Cloud Run Jobを起動する関数
export async function startCloudRunJob(job: ProcessingJob) {
  try {
    // Cloud Run Jobをトリガーするためのメッセージをパブリッシュ
    const dataBuffer = Buffer.from(JSON.stringify(job));
    const messageId = await topic.publish(dataBuffer);
    
    console.log(`Published message for job ${job.id}, message ID: ${messageId}`);
    return true;
  } catch (error) {
    console.error('Failed to publish message:', error);
    return false;
  }
}

// ファイルタイプを判別する関数
export function getFileType(file: SlackFile): 'video' | 'audio' | 'document' | 'image' | 'other' {
  const { mimetype } = file;
  
  if (mimetype.startsWith('video/')) {
    return 'video';
  } else if (mimetype.startsWith('audio/')) {
    return 'audio';
  } else if (mimetype.startsWith('image/')) {
    return 'image';
  } else if (
    mimetype.includes('pdf') || 
    mimetype.includes('word') || 
    mimetype.includes('text/') || 
    mimetype.includes('application/vnd.openxmlformats-officedocument')
  ) {
    return 'document';
  } else {
    return 'other';
  }
}

// 日付文字列を抽出する関数
export function extractDateFromText(text: string): string | null {
  // YYYY/MM/DDまたは年/月/日形式の日付を抽出
  const datePattern = /(\d{4}\/\d{1,2}\/\d{1,2})|(\d{4}年\d{1,2}月\d{1,2}日)/;
  const match = text.match(datePattern);
  
  return match ? match[0] : null;
}

// クライアント名とコンサルタント名を抽出する関数
export function extractNamesFromText(text: string): { client?: string; consultant?: string } {
  // 単純な実装例：「クライアント：XXX」、「コンサルタント：YYY」から抽出
  const clientMatch = text.match(/クライアント[：:]\s*([^\s,]+)/);
  const consultantMatch = text.match(/コンサルタント[：:]\s*([^\s,]+)/);
  
  return {
    client: clientMatch ? clientMatch[1] : undefined,
    consultant: consultantMatch ? consultantMatch[1] : undefined
  };
} 