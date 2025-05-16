import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { CONFIG } from '@app/lib/config';
import { SlackEventPayload, ProcessingJob } from '@app/lib/types';
import { uploadFileToGCS, sendSlackMessage, startCloudRunJob, getFileType } from '@/app/lib/utils';
import { EventProcessor } from '@/app/lib/kv-store';

// イベント処理インスタンスの作成
const eventProcessor = new EventProcessor();

// 処理済みイベントの一意識別子を生成する関数
function generateEventHash(event_id: string, channel: string, ts: string): string {
  const eventKey = `${event_id}_${channel}_${ts}`;
  return crypto.createHash('sha256').update(eventKey).digest('hex');
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
    
    // シグネチャ検証
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
      
      // 重複イベント検出のための一意なハッシュを生成
      if (event_id && event.ts && event.channel) {
        // イベントの一意性を確実に識別するハッシュを生成
        const eventHash = generateEventHash(event_id, event.channel, event.ts);
        
        // KVストアを使って重複チェック
        const isProcessed = await eventProcessor.isProcessedOrMark(eventHash);
        
        // 既に処理済みのイベントなら早期リターン
        if (isProcessed) {
          console.log(`永続ストアで重複リクエスト検出: ${event_id} (${event.channel}, ${event.ts})`);
          return NextResponse.json(
            { ok: true, status: 'duplicate_event_skipped' },
            { 
              headers: {
                'x-processed-event-hash': eventHash,
                'x-duplicate-detected': 'true',
                'cache-control': 'private, max-age=3600'
              }
            }
          );
        }
        
        // 以下、実際の処理を行う部分
        // メッセージかつファイルがある場合のみ処理
        if (event.type === 'message' && event.files && event.files.length > 0) {
          console.log(`処理開始: イベントID=${event_id}, チャンネル=${event.channel}, タイムスタンプ=${event.ts}`);
          
          try {
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
              
              // Slack通知を送信（1回のみ、重複防止に一意のIDを付与）
              try {
                await sendSlackMessage(
                  event.channel,
                  statusMessage,
                  event.thread_ts || event.ts
                );
                console.log(`Slackメッセージを送信しました: channel=${event.channel}, ts=${event.ts || event.thread_ts}`);
              } catch (e) {
                console.error('Slack通知の送信に失敗:', e);
              }
              
              // Cloud Runジョブの開始
              try {
                const jobStartResult = await startCloudRunJob(job);
                console.log(`Cloud Runジョブを開始: ${jobId}, 結果:`, jobStartResult);
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
          } catch (processingError) {
            console.error('ファイル処理中にエラーが発生:', processingError);
          }
        } else {
          console.log(`処理対象外のイベント: ${event.type}`);
        }
        
        // 処理完了レスポンス（重複検出用のヘッダー付き）
        return NextResponse.json(
          { ok: true, processed: true, event_hash: eventHash },
          { 
            headers: {
              'x-processed-event-hash': eventHash,
              'x-processed-at': new Date().toISOString(),
              'cache-control': 'private, max-age=3600'
            }
          }
        );
      }
    }
    
    // 通常のレスポンス
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