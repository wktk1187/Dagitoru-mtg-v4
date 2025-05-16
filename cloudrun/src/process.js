#!/usr/bin/env node

/**
 * Dagitoru Cloud Run Job
 * 動画処理、音声抽出、文字起こしを行うメインスクリプト
 */

require('dotenv').config();
const express = require('express');
const { Storage } = require('@google-cloud/storage');
const { PubSub } = require('@google-cloud/pubsub');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const { execSync } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const speech = require('@google-cloud/speech').v1p1beta1;
const { v4: uuidv4 } = require('uuid');

// HTTPサーバー設定
const app = express();
const port = process.env.PORT || 8080;

// 定数設定
const BUCKET_NAME = process.env.GCS_BUCKET_NAME;
const PROJECT_ID = process.env.GCP_PROJECT_ID;
const CALLBACK_URL = process.env.CALLBACK_URL;
const SUBSCRIPTION_NAME = process.env.PUBSUB_SUBSCRIPTION;
const TEMP_DIR = '/tmp';

// クライアント初期化
const storage = new Storage();
const bucket = storage.bucket(BUCKET_NAME);
const pubsub = new PubSub({
  projectId: PROJECT_ID
});
const speechClient = new speech.SpeechClient();

// PubSubサブスクリプションの初期化
let subscriptionName = SUBSCRIPTION_NAME;
if (!subscriptionName.startsWith('projects/')) {
  subscriptionName = `projects/${PROJECT_ID}/subscriptions/${SUBSCRIPTION_NAME}`;
}
console.log(`PubSub subscription name: ${subscriptionName}`);

const subscription = pubsub.subscription(subscriptionName);
console.log(`PubSub subscription initialized: ${SUBSCRIPTION_NAME}`);

// サブスクリプションが正しく設定されているか確認
console.log('Subscription details:', {
  name: subscription.name,
  metadata: subscription.metadata,
  projectId: pubsub.projectId
});

// ミドルウェア設定
app.use(express.json());

// ルート設定 - ヘルスチェック用
app.get('/', (req, res) => {
  res.status(200).send('Dagitoru Processor is running');
});

// 処理開始エンドポイント
app.post('/process', async (req, res) => {
  console.log('Processing request received:', req.body);
  
  try {
    // リクエストを検証
    if (!req.body || !req.body.jobId || !req.body.fileIds) {
      return res.status(400).send('Invalid request. Required: jobId, fileIds');
    }
    
    // 非同期で処理を実行（レスポンスはすぐに返す）
    const job = {
      id: req.body.jobId,
      fileIds: req.body.fileIds,
      metadata: req.body.metadata || {},
      channel: req.body.channel,
      ts: req.body.ts,
      thread_ts: req.body.thread_ts
    };
    
    // 処理を非同期で開始
    processJob(job)
      .then(result => {
        sendCallback({
          jobId: job.id,
          status: 'success',
          transcriptUrl: result.transcriptUrl
        }).catch(err => console.error('Callback error:', err));
      })
      .catch(error => {
        console.error(`Error processing job ${job.id}:`, error);
        sendCallback({
          jobId: job.id,
          status: 'failure',
          error: error.message
        }).catch(err => console.error('Callback error:', err));
      });
    
    // 即時にレスポンスを返す
    res.status(202).json({ 
      message: 'Processing started',
      jobId: job.id
    });
  } catch (error) {
    console.error('Error handling request:', error);
    res.status(500).send('Internal server error');
  }
});

// サーバー起動
app.listen(port, () => {
  console.log(`Dagitoru Processor listening on port ${port}`);
  
  // PubSubメッセージをポーリングする関数
  async function pollMessages() {
    try {
      console.log(`[PUBSUB_SETUP] Starting message listener for subscription: ${SUBSCRIPTION_NAME}`);
      
      // リスナー設定前のデバッグ情報
      console.log('[PUBSUB_SETUP] Current subscription object:', {
        exists: !!subscription,
        name: subscription.name,
        options: subscription.options
      });
      
      // メッセージ受信リスナーの設定
      // メッセージハンドラ関数の定義
      const handlePubSubMessage = async (message) => {
        console.log(`[PUBSUB_MESSAGE] Received message ${message.id}`, {
          publishTime: message.publishTime,
          received: new Date().toISOString()
        });
        
        try {
          // メッセージからジョブデータを抽出
          console.log('[PUBSUB_PROCESS] Extracting job data from message');
          const job = parseMessage(message);
          
          if (!job) {
            console.error('[PUBSUB_ERROR] Invalid job data, acknowledging message');
            message.ack();
            return;
          }
          
          console.log(`[PUBSUB_PROCESS] Processing job: ${job.id}`, {
            jobDetails: {
              id: job.id,
              fileCount: job.fileIds.length,
              timestamp: new Date().toISOString()
            }
          });
          
          // コールバック用のデータ初期化
          let callbackData = {
            jobId: job.id,
            status: 'failure',
            error: null
          };
          
          try {
            // ジョブ処理を実行
            const result = await processJob(job);
            callbackData = {
              ...callbackData,
              status: 'success',
              transcriptUrl: result.transcriptUrl
            };
          } catch (error) {
            console.error(`Error processing job ${job.id}:`, error);
            callbackData.error = error.message;
          }
          
          // コールバックを送信
          await sendCallback(callbackData);
          
          // メッセージを確認応答
          message.ack();
          
        } catch (error) {
          console.error('Error processing PubSub message:', error);
          message.ack(); // エラーが発生しても確認応答する
        }
      };
      
      // エラーハンドラ関数の定義
      const handlePubSubError = (error) => {
        console.error('[PUBSUB_ERROR] Subscription error:', error);
        console.error('[PUBSUB_ERROR] Error details:', {
          name: error.name,
          message: error.message,
          stack: error.stack,
          code: error.code,
          time: new Date().toISOString()
        });
      };
      
      // リスナーを設定
      subscription.on('message', handlePubSubMessage);
      subscription.on('error', handlePubSubError);
      
      console.log('[PUBSUB_SETUP] Message listener attached. Waiting for messages...');
      
      // バックアップとして明示的にメッセージをpullする処理も実行（1分ごと）
      setInterval(async () => {
        try {
          console.log('[PUBSUB_PULL] Explicitly checking for new messages...');
          
          // 明示的にサブスクリプションのステータスを確認するだけ
          // （メッセージは既に設定済みのリスナーで処理されるため）
          const [subscriptionExists] = await subscription.exists();
          
          if (subscriptionExists) {
            console.log('[PUBSUB_PULL] Subscription is active and listening for messages');
          } else {
            console.error('[PUBSUB_PULL_ERROR] Subscription does not exist!');
            
            // サブスクリプションが存在しない場合は作成を試みる
            console.log('[PUBSUB_RECOVERY] Attempting to recreate subscription');
            
            // トピック名の取得（サブスクリプション名から推測）
            const topicName = SUBSCRIPTION_NAME.replace('subscriptions/', '');
            const fullTopicName = `projects/${PROJECT_ID}/topics/${topicName}`;
            console.log(`[PUBSUB_RECOVERY] Using topic name: ${fullTopicName}`);
            
            try {
              // トピックが存在するか確認
              const topic = pubsub.topic(topicName);
              const [topicExists] = await topic.exists();
              
              if (!topicExists) {
                console.log(`[PUBSUB_RECOVERY] Topic does not exist, creating: ${topicName}`);
                await pubsub.createTopic(topicName);
                console.log(`[PUBSUB_RECOVERY] Topic created: ${topicName}`);
              }
              
              // サブスクリプションを作成
              await pubsub.createSubscription(topicName, SUBSCRIPTION_NAME);
              console.log(`[PUBSUB_RECOVERY] Subscription created: ${SUBSCRIPTION_NAME}`);
              
              // サブスクリプションの再初期化
              subscription = pubsub.subscription(subscriptionName);
              
              // リスナーの再設定
              subscription.on('message', handlePubSubMessage);
              subscription.on('error', handlePubSubError);
              
              console.log('[PUBSUB_RECOVERY] Recovery complete, subscription is now active');
            } catch (recoveryError) {
              console.error('[PUBSUB_RECOVERY_ERROR] Failed to recover subscription:', recoveryError);
            }
          }
        } catch (error) {
          console.error('[PUBSUB_PULL_ERROR] Error checking subscription:', error);
          console.error('[PUBSUB_PULL_ERROR] Error details:', {
            name: error.name,
            message: error.message,
            stack: error.stack,
            code: error.code,
            time: new Date().toISOString()
          });
        }
      }, 60000); // 1分ごとに実行
      
    } catch (error) {
      console.error('[PUBSUB_FATAL] Error setting up message listener:', error);
      console.error('[PUBSUB_FATAL] Fatal error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack,
        time: new Date().toISOString()
      });
      
      // 致命的なエラーの場合、一定時間後に再試行
      console.log('[PUBSUB_RECOVERY] Will retry connection in 30 seconds');
      setTimeout(pollMessages, 30000);
    }
  }
  
  // ポーリングを開始
  pollMessages();
});

/** * Pub/Subメッセージからジョブデータを抽出する関数 */

/**
 * Pub/Subメッセージからジョブデータを抽出する関数
 */
function parseMessage(message) {
  try {
    // 詳細なデバッグログを追加
    console.log('Parsing message:', message.id);
    console.log('Message attributes:', message.attributes);
    
    let data;
    if (message.data) {
      // dataがBinaryのケース（Buffer）
      if (Buffer.isBuffer(message.data)) {
        console.log('Message data is Buffer, converting from base64');
        const decodedData = message.data.toString('utf8');
        console.log('Message data (decoded):', decodedData);
        data = JSON.parse(decodedData);
      }
      // dataが既にBase64文字列の場合
      else if (typeof message.data === 'string') {
        console.log('Message data is string, parsing from base64');
        const decodedData = Buffer.from(message.data, 'base64').toString('utf8');
        console.log('Message data (decoded):', decodedData);
        data = JSON.parse(decodedData);
      }
      // dataが既にJSONオブジェクトの場合
      else if (typeof message.data === 'object') {
        console.log('Message data is already an object');
        data = message.data;
      }
    } else if (message.json) {
      // v4.7.0以降のPubSubライブラリではmessage.jsonでJSONデータを直接取得可能
      console.log('Using message.json to parse data');
      data = message.json;
    } else {
      throw new Error('No data or json property found in message');
    }
    
    // 必須フィールドの確認
    if (!data.id || !data.fileIds) {
      console.error('Missing required job fields', data);
      return null;
    }
    
    console.log('Successfully parsed message data:', data);
    return data;
  } catch (error) {
    console.error('Error parsing message:', error);
    return null;
  }
}

/**
 * ジョブを処理する関数
 */
async function processJob(job) {
  // ファイルIDがない場合はエラー
  if (!job.fileIds || job.fileIds.length === 0) {
    throw new Error('No file IDs in job');
  }
  
  // 最初のファイルIDを処理（複数ある場合は後で改善）
  const fileId = job.fileIds[0];
  
  // ジョブディレクトリ内のファイルリストを取得
  const jobPrefix = `meetings/${getFormattedDate()}/${job.id}/`;
  const [files] = await bucket.getFiles({ prefix: jobPrefix });
  
  if (files.length === 0) {
    throw new Error('No files found in job directory');
  }
  
  // 動画/音声ファイルの検索
  const mediaFile = files.find(file => {
    const filename = path.basename(file.name);
    return /\.(mp4|mov|avi|wav|mp3|flac|ogg)$/i.test(filename);
  });
  
  if (!mediaFile) {
    throw new Error('No media file found');
  }
  
  // ローカルのファイルパス
  const localMediaPath = path.join(TEMP_DIR, path.basename(mediaFile.name));
  const localAudioPath = path.join(TEMP_DIR, 'audio.flac');
  
  try {
    // ファイルをダウンロード
    await mediaFile.download({ destination: localMediaPath });
    console.log(`Downloaded ${mediaFile.name} to ${localMediaPath}`);
    
    // メディアの種類を判定
    const isAudio = /\.(wav|mp3|flac|ogg)$/i.test(localMediaPath);
    
    if (isAudio) {
      // すでに音声ファイルの場合はコピー
      await fs.copyFile(localMediaPath, localAudioPath);
    } else {
      // 動画から音声を抽出
      await extractAudio(localMediaPath, localAudioPath);
    }
    
    // 音声ファイルをGCSにアップロード
    const audioGcsPath = `${jobPrefix}audio.flac`;
    await bucket.upload(localAudioPath, { destination: audioGcsPath });
    console.log(`Uploaded audio to ${audioGcsPath}`);
    
    // 音声ファイルの文字起こし
    const transcript = await transcribeSpeech(localAudioPath);
    
    // 文字起こし結果をJSONとしてGCSに保存
    const transcriptData = {
      jobId: job.id,
      transcript,
      timestamp: new Date().toISOString(),
      metadata: {
        ...job.metadata,
        videoUrl: `gs://${BUCKET_NAME}/${mediaFile.name}`,
        audioUrl: `gs://${BUCKET_NAME}/${audioGcsPath}`,
        channel: job.channel,
        ts: job.ts,
        thread_ts: job.thread_ts
      }
    };
    
    // 文字起こし結果をGCSにアップロード
    const transcriptGcsPath = `${jobPrefix}transcript.json`;
    const transcriptLocalPath = path.join(TEMP_DIR, 'transcript.json');
    await fs.writeFile(transcriptLocalPath, JSON.stringify(transcriptData, null, 2));
    await bucket.upload(transcriptLocalPath, { destination: transcriptGcsPath });
    
    // 一時ファイルを削除
    await fs.unlink(localMediaPath).catch(() => {});
    await fs.unlink(localAudioPath).catch(() => {});
    await fs.unlink(transcriptLocalPath).catch(() => {});
    
    console.log(`[PROCESS_JOB] Job ${job.id} completed successfully`);
    
    // 処理結果を返す
    return {
      jobId: job.id,
      transcriptUrl: `https://storage.googleapis.com/${BUCKET_NAME}/${transcriptGcsPath}`,
      metadata: transcriptData.metadata
    };
  } catch (error) {
    console.error('Error in job processing:', error);
    throw error;
  }
}

/**
 * 動画から音声を抽出する関数
 */
async function extractAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    console.log(`Extracting audio from ${videoPath} to ${audioPath}`);
    
    ffmpeg(videoPath)
      .output(audioPath)
      .audioCodec('flac')
      .audioChannels(1)
      .audioFrequency(16000)
      .on('end', () => {
        console.log('Audio extraction completed');
        resolve();
      })
      .on('error', (err) => {
        console.error('Error during audio extraction:', err);
        reject(err);
      })
      .run();
  });
}

/**
 * 音声ファイルを文字起こしする関数
 */
async function transcribeSpeech(audioPath) {
  console.log(`Starting speech recognition for ${audioPath}`);
  
  // ファイルを読み込み
  const audioBytes = await fs.readFile(audioPath);
  const audio = {
    content: audioBytes.toString('base64')
  };
  
  // 音声認識リクエストの設定
  const config = {
    encoding: 'FLAC',
    sampleRateHertz: 16000,
    languageCode: 'ja-JP',
    enableAutomaticPunctuation: true,
    enableWordTimeOffsets: true,
    model: 'latest_long',
    useEnhanced: true,
    metadata: {
      interactionType: 'DISCUSSION',
      industryNaicsCodeOfAudio: 541990, // Professional Services
      microphoneDistance: 'NEARFIELD',
      originalMediaType: 'AUDIO'
    }
  };
  
  const request = {
    audio: audio,
    config: config
  };
  
  try {
    // 長時間音声の場合、非同期認識を使用
    const [operation] = await speechClient.longRunningRecognize(request);
    console.log('Waiting for speech recognition to complete...');
    
    // 非同期処理が完了するまで待機
    const [response] = await operation.promise();
    
    // 結果を文字列に連結
    let transcript = '';
    const results = response.results;
    
    if (results && results.length > 0) {
      for (const result of results) {
        if (result.alternatives && result.alternatives.length > 0) {
          transcript += result.alternatives[0].transcript + ' ';
        }
      }
    }
    
    console.log(`Transcription completed: ${transcript.length} characters`);
    return transcript.trim();
  } catch (error) {
    console.error('Error in speech recognition:', error);
    throw new Error(`Speech recognition failed: ${error.message}`);
  }
}

/**
 * コールバックを送信する関数
 */
async function sendCallback(data) {
  if (!CALLBACK_URL) {
    throw new Error('CALLBACK_URL environment variable not set');
  }
  
  console.log(`Sending callback to ${CALLBACK_URL} with data:`, JSON.stringify(data));
  
  try {
    const response = await axios.post(CALLBACK_URL, data, {
      headers: {
        'Content-Type': 'application/json'
      },
      // タイムアウトを増やす
      timeout: 30000
    });
    
    console.log(`Callback sent successfully, status: ${response.status}`);
    return response.data;
  } catch (error) {
    console.error('Error sending callback:', error.message);
    // コールバック送信失敗はジョブ全体を失敗させない
    // エラーログを残して処理を続行
    console.error('Callback request failed, but job is marked as complete');
  }
}

/**
 * 日付を整形して返す関数（yyyyMMdd_HHmm形式）
 */
function getFormattedDate() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  
  return `${year}${month}${day}_${hours}${minutes}`;
} 