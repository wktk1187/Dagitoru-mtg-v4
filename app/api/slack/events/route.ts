import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { PubSub } from '@google-cloud/pubsub';
import { CONFIG } from '@app/lib/config';
import { SlackEventPayload, ProcessingJob } from '@app/lib/types';
import { JobRecord, JobStatus } from '@app/lib/types/job';
import { uploadFileToGCS, sendSlackMessage, /* startCloudRunJob, */ getFileType } from '@/app/lib/utils';
import { EventProcessor } from '@/app/lib/kv-store';
import { db } from '@/app/lib/firebase';
import { Timestamp } from 'firebase-admin/firestore';

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
    
    // PubSubクライアントの初期化
    const gcpCredentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (!gcpCredentialsJson) {
      console.error('GOOGLE_APPLICATION_CREDENTIALS_JSON is not set');
      // Vercel環境ではビルド時にエラーになるべきだが、ランタイムでもチェック
      return NextResponse.json({ error: 'Server configuration error: GCP credentials missing' }, { status: 500 });
    }

    let credentials;
    try {
      credentials = JSON.parse(gcpCredentialsJson);
    } catch (err) {
      console.error('Failed to parse GCP credentials JSON:', err);
      return NextResponse.json({ error: 'Server configuration error: GCP credentials invalid' }, { status: 500 });
    }

    const pubsub = new PubSub({
      projectId: 'dagitoru-mtg', // CONFIG.GCP_PROJECT_ID も利用可
      credentials,
    });
    
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
            // ファイル情報の詳細ログ
            console.log(`処理対象ファイル: ${event.files.length}件`, {
              files: event.files.map(f => ({
                id: f.id,
                name: f.name,
                size: f.size,
                type: f.mimetype,
                url_private: f.url_private ? f.url_private.substring(0, 30) + '...' : undefined
              }))
            });
            
            // 一意のジョブIDを生成
            const jobId = uuidv4();
            console.log(`ジョブID生成: ${jobId}`);
            
            // ファイルをGoogle Cloud Storageにアップロード
            const uploadResults = await Promise.all(
              event.files.map(async (file) => {
                try {
                  if (!file.url_private) {
                    console.error(`ファイルにURL_PRIVATEがありません: ${file.id}, ${file.name}`);
                    return {
                      success: false,
                      file: file,
                      error: 'ファイルのプライベートURLがありません'
                    };
                  }
                  
                  const fileType = getFileType(file);
                  console.log(`ファイルタイプ: ${fileType}, ファイル名: ${file.name}, サイズ: ${file.size}`);
                  
                  // ファイルサイズチェック
                  if (file.size > CONFIG.MAX_FILE_SIZE) {
                    console.error(`ファイルサイズが大きすぎます: ${file.name}, ${file.size} bytes`);
                    return {
                      success: false,
                      file: file,
                      error: 'ファイルサイズが大きすぎます（最大1GB）'
                    };
                  }
                  
                  console.log(`ファイルアップロード開始: ${file.name}`);
                  const uploadResult = await uploadFileToGCS(
                    file.url_private,
                    jobId,
                    file.name
                  );
                  
                  if (uploadResult.success) {
                    console.log(`ファイルのアップロードに成功: ${file.name} -> ${uploadResult.path}`);
                    return {
                      success: true,
                      file: file,
                      gcsPath: uploadResult.path
                    };
                  } else {
                    console.error(`ファイルのアップロードに失敗: ${file.name}, エラー: ${uploadResult.error}`);
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
            console.log(`アップロード結果: 成功=${successfulUploads.length}件, 失敗=${uploadResults.length - successfulUploads.length}件`);
            
            // ジョブ情報を作成
            if (successfulUploads.length > 0) {
              // Firestoreにジョブレコードを作成
              const jobRecord: JobRecord = {
                jobId: jobId,
                status: 'pending',
                createdAt: Timestamp.now(),
                updatedAt: Timestamp.now(),
                gcsPaths: successfulUploads.map(r => (r as { success: boolean; file: any; gcsPath: string }).gcsPath),
                fileNames: successfulUploads.map(r => (r as { success: boolean; file: { name: string }; gcsPath: string }).file.name),
                slackEvent: event, // 元のSlackイベント全体を保存
              };

              try {
                await db.collection("jobs").doc(jobId).set(jobRecord);
                console.log(`[FIRESTORE_JOB_CREATED] jobId: ${jobId} status: pending`);
              } catch (dbError) {
                console.error(`[FIRESTORE_ERROR] Failed to create job record for jobId: ${jobId}`, dbError);
                // Firestoreへの書き込み失敗時のエラーハンドリング
                // 必要に応じてSlack通知や、処理を中断するなどの対応
                // ここでは処理を継続し、Pub/Sub発行は試みるが、ジョブ追跡はできなくなる
              }

              // Pub/Subへメッセージを発行
              const topicName = 'dagitorutopic';
              const messageData = {
                jobId: jobId,
                gcsPaths: successfulUploads.map(r => (r as { success: boolean; file: any; gcsPath: string }).gcsPath),
                fileNames: successfulUploads.map(r => (r as { success: boolean; file: { name: string }; gcsPath: string }).file.name),
                // 必要に応じて他の情報も追加
                slackEvent: {
                  text: event.text || '',
                  channel: event.channel,
                  ts: event.ts,
                  thread_ts: event.thread_ts,
                  user: event.user,
                }
              };

              try {
                const messageId = await pubsub.topic(topicName).publishMessage({
                  data: Buffer.from(JSON.stringify(messageData)),
                });
                console.log(`[PUBSUB_PUBLISHED] messageId: ${messageId} for jobId: ${jobId}`);
                // Slackへの通知はCloud Run側で行うか、ここで「処理を受け付けました」程度にするか検討
              } catch (err) {
                console.error(`[PUBSUB_ERROR] Failed to publish message for jobId: ${jobId}`, err);
                // エラー時のフォールバック処理 (Slack通知、リトライキューなど)
                // ここでエラーを返すとSlackにリトライされる可能性があるため注意
                // return NextResponse.json({ error: 'Failed to publish to Pub/Sub' }, { status: 500 });
              }
              
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
              
              // 処理を受け付けたことを示すレスポンス
              return NextResponse.json({ 
                ok: true, 
                status: 'processing_job_created_and_published',
                jobId: jobId,
                pubSubMessageData: messageData // デバッグ用に含めることも可能だが、本番では削除検討
              });
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