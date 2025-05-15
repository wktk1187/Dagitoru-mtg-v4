import { WebClient } from '@slack/web-api';
import { Storage } from '@google-cloud/storage';
import { PubSub } from '@google-cloud/pubsub';
import axios from 'axios';
import { CONFIG, getGCSPath } from './config';
import { SlackFile, ProcessingJob } from './types';

// Slackクライアント初期化
const slackClient = new WebClient(CONFIG.SLACK_TOKEN);

// GCSクライアント初期化
const storage = new Storage();
const bucket = storage.bucket(CONFIG.GCS_BUCKET_NAME);

// PubSubクライアント初期化
const pubsub = new PubSub();
// デフォルトのトピック名を設定
const topicName = CONFIG.PUBSUB_TOPIC || 'dagitoru-topic';
const topic = pubsub.topic(topicName);

// Slackにメッセージを送信する関数
export async function sendSlackMessage(channel: string, text: string, thread_ts?: string) {
  try {
    await slackClient.chat.postMessage({
      channel,
      text,
      thread_ts
    });
    return true;
  } catch (error) {
    console.error('Slack message sending failed:', error);
    return false;
  }
}

// ファイルをGCSにアップロードする関数
export async function uploadFileToGCS(fileUrl: string, jobId: string, filename: string) {
  try {
    // Slackからファイルをダウンロード
    const response = await axios.get(fileUrl, {
      headers: {
        Authorization: `Bearer ${CONFIG.SLACK_TOKEN}`,
      },
      responseType: 'arraybuffer'
    });
    
    // GCSにアップロード
    const gcsPath = getGCSPath(jobId, filename);
    const file = bucket.file(gcsPath);
    await file.save(response.data);
    
    return {
      success: true,
      path: gcsPath,
      url: `gs://${CONFIG.GCS_BUCKET_NAME}/${gcsPath}`
    };
  } catch (error) {
    console.error('File upload to GCS failed:', error);
    return {
      success: false,
      error: (error as Error).message
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