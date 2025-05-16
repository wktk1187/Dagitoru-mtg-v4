import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { CONFIG } from '@app/lib/config';
import { SlackEventPayload, ProcessingJob } from '@app/lib/types';
import { uploadFileToGCS, sendSlackMessage, startCloudRunJob, getFileType } from '@/app/lib/utils';

// 処理済みイベントIDを保持するキャッシュ（メモリ内、サーバーレス環境では制限あり）
const processedEvents = new Map<string, number>();

// キャッシュのクリーンアップ（5分より古いエントリを削除）
function cleanupEventCache() {
  const now = Date.now();
  for (const [eventId, timestamp] of processedEvents.entries()) {
    if (now - timestamp > 5 * 60 * 1000) {
      processedEvents.delete(eventId);
    }
  }
}

// 重複イベントかどうかチェックする関数
function isDuplicateEvent(eventId: string): boolean {
  // 5分に1回キャッシュをクリーンアップ
  if (Math.random() < 0.1) {
    cleanupEventCache();
  }
  
  if (processedEvents.has(eventId)) {
    console.log(`Duplicate event detected: ${eventId}`);
    return true;
  }
  
  // 新しいイベントを記録
  processedEvents.set(eventId, Date.now());
  return false;
}

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
      const { event, event_id } = payload;
      
      // メッセージかつファイルがある場合に処理する
      if (event.type === 'message' && event.files && event.files.length > 0) {
        console.log('直接処理: ファイル付きメッセージを受信しました');
        
        // 一意のジョブIDを生成
        const jobId = uuidv4();
        
        // ファイルをGoogle Cloud Storageにアップロード
        const uploadResults = await Promise.all(
          event.files.map(async (file) => {
            try {
              const fileType = getFileType(file);
              console.log(`ファイルタイプ: ${fileType}, ファイル名: ${file.name}`);
              
              const uploadResult = await uploadFileToGCS(
                file.url_private,
                jobId,
                file.name
              );
              
              if (uploadResult.success) {
                console.log(`ファイルのアップロードに成功: ${file.name}`);
                return {
                  success: true,
                  file: file,
                  gcsPath: uploadResult.path
                };
              } else {
                console.error(`ファイルのアップロードに失敗: ${file.name}`);
                return {
                  success: false,
                  file: file,
                  error: uploadResult.error
                };
              }
            } catch (error) {
              console.error(`ファイル処理エラー: ${file.name}`, error);
              return {
                success: false,
                file: file,
                error: error instanceof Error ? error.message : 'Unknown error'
              };
            }
          })
        );
        
        // 成功したアップロードの数を確認
        const successfulUploads = uploadResults.filter(r => r.success);
        
        // ジョブ情報を作成
        if (successfulUploads.length > 0) {
          const job: ProcessingJob = {
            id: jobId,
            fileIds: successfulUploads.map(r => (r as any).file.id),
            text: event.text || '',
            channel: event.channel,
            ts: event.ts,
            thread_ts: event.thread_ts,
            user: event.user,
            status: 'pending',
            createdAt: new Date(),
            updatedAt: new Date()
          };
          
          // 完了メッセージの生成
          const successCount = successfulUploads.length;
          const failCount = uploadResults.length - successCount;
          
          let statusMessage = `📋 処理ジョブを作成しました (ID: ${jobId})\n`;
          
          if (successCount > 0) {
            statusMessage += `✅ 処理中のファイル: ${successCount}件\n`;
          }
          
          if (failCount > 0) {
            statusMessage += `❌ 処理できなかったファイル: ${failCount}件\n`;
            statusMessage += uploadResults
              .filter(r => !r.success)
              .map(r => `• ${(r as any).file.name}: ${(r as any).error}`)
              .join('\n');
            statusMessage += '\n';
          }
          
          // Slack通知を送信（1回のみ）
          try {
            await sendSlackMessage(
              event.channel,
              statusMessage,
              event.thread_ts || event.ts
            );
          } catch (e) {
            console.error('Slack通知の送信に失敗:', e);
          }
          
          // Cloud Runジョブの開始
          try {
            await startCloudRunJob(job);
            console.log(`Cloud Runジョブを開始: ${jobId}`);
          } catch (e) {
            console.error('Cloud Runジョブの開始に失敗:', e);
          }
        } else {
          // すべてのファイルのアップロードが失敗した場合
          try {
            await sendSlackMessage(
              event.channel,
              `❌ ファイルの処理に失敗しました。すべてのファイルをアップロードできませんでした。`,
              event.thread_ts || event.ts
            );
          } catch (e) {
            console.error('Slack通知の送信に失敗:', e);
          }
        }
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