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
  projectId: PROJECT_ID,
});
const speechClient = new speech.SpeechClient();

// PubSubサブスクリプションの初期化
let subscriptionName = SUBSCRIPTION_NAME;
if (!subscriptionName.startsWith('projects/')) {
  subscriptionName = `projects/${PROJECT_ID}/subscriptions/${SUBSCRIPTION_NAME}`;
}
console.log(`[PUBSUB_INIT] Using subscription: ${subscriptionName}`);

const subscription = pubsub.subscription(subscriptionName);

// 明示的にメッセージを処理する関数
async function processMessages() {
  try {
    console.log('[PUBSUB_EXPLICIT_PULL] Explicitly pulling messages...');
    
    // 明示的にメッセージを取得（タイムアウト設定を追加）
    const options = {
      maxMessages: 10,
      timeout: 60 // タイムアウトを60秒に設定
    };
    
    // タイムアウト処理を制御するPromiseラッパー
    const pullWithTimeout = new Promise(async (resolve, reject) => {
      try {
        // タイムアウト用タイマー
        const timer = setTimeout(() => {
          reject(new Error('Pull operation timed out after 30 seconds'));
        }, 30000); // 30秒のタイムアウト
        
        // pull操作を実行
        const result = await subscription.pull(options);
        
        // タイマーをクリア
        clearTimeout(timer);
        
        // 結果を返す
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
    
    // タイムアウト制御付きでpull操作を実行
    const [messages] = await pullWithTimeout;
    
    console.log(`[PUBSUB_EXPLICIT_PULL] Received ${messages ? messages.length : 0} messages`);
    
    // メッセージがあれば処理
    if (messages && messages.length > 0) {
      for (const message of messages) {
        try {
          console.log(`[PUBSUB_PROCESS] Processing message ID: ${message.id}`);
          
          // メッセージからジョブデータを抽出
          const job = parseMessage(message);
          
          if (!job) {
            console.error('[PUBSUB_ERROR] Invalid job data, acknowledging message');
            await message.ack();
            continue;
          }
          
          console.log(`[PUBSUB_PROCESS] Processing job: ${job.id}`, {
            fileCount: job.fileIds.length,
            timestamp: new Date().toISOString()
          });
          
          // ジョブを処理
          const result = await processJob(job);
          
          // 処理が完了したらメッセージを確認応答
          await message.ack();
          
          console.log(`[PUBSUB_PROCESS] Job completed: ${job.id}`, {
            result: result ? 'success' : 'error'
          });
        } catch (error) {
          console.error(`[PUBSUB_PROCESS_ERROR] Error processing message: ${error.message}`, error);
          // エラーの場合でもメッセージを確認応答（再処理を防ぐため）
          try {
            await message.ack();
          } catch (ackError) {
            console.error(`[PUBSUB_ACK_ERROR] Failed to acknowledge message: ${ackError.message}`);
          }
        }
      }
    } else {
      console.log('[PUBSUB_EXPLICIT_PULL] No messages to process');
    }
  } catch (error) {
    console.error(`[PUBSUB_EXPLICIT_PULL_ERROR] Error pulling messages: ${error.message}`, error);
    console.error('[PUBSUB_ERROR_DETAILS]', {
      name: error.name,
      message: error.message,
      code: error.code,
      time: new Date().toISOString()
    });
  }
}

// メッセージリスナーを設定
const setupMessageListener = () => {
  console.log('[PUBSUB_SETUP] Setting up message listener...');
  
  // リスナー関数を定義
  const messageHandler = async (message) => {
    console.log(`[PUBSUB_MESSAGE] Received message ${message.id}`, {
      publishTime: message.publishTime,
      received: new Date().toISOString()
    });
    
    try {
      // メッセージからジョブデータを抽出
      const job = parseMessage(message);
      
      if (!job) {
        console.error('[PUBSUB_ERROR] Invalid job data, acknowledging message');
        message.ack();
        return;
      }
      
      console.log(`[PUBSUB_PROCESS] Processing job: ${job.id}`, {
        fileCount: job.fileIds.length,
        timestamp: new Date().toISOString()
      });
      
      // ジョブを処理
      const result = await processJob(job);
      
      // 処理が完了したらメッセージを確認応答
      message.ack();
      
      console.log(`[PUBSUB_PROCESS] Job completed: ${job.id}`, {
        result: result ? 'success' : 'error'
      });
    } catch (error) {
      console.error(`[PUBSUB_ERROR] Error processing message: ${error.message}`, error);
      // エラーの場合でもメッセージを確認応答（再処理を防ぐため）
      try {
        message.ack();
      } catch (ackError) {
        console.error(`[PUBSUB_ACK_ERROR] Failed to acknowledge message: ${ackError.message}`);
      }
    }
  };
  
  // イベントリスナーによるメッセージ受信
  subscription.on('message', messageHandler);
  
  console.log('[PUBSUB_SETUP] Message listener attached. Waiting for messages...');
  
  // 定期的に明示的にメッセージを取得・処理（バックアップメカニズム）
  // 30秒ごとに実行
  setInterval(processMessages, 30000);
  
  // 起動直後にも一度明示的に実行
  processMessages();
};

// 起動時に処理を開始
setupMessageListener();

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
});

/** * Pub/Subメッセージからジョブデータを抽出する関数 */

/**
 * Pub/Subメッセージからジョブデータを抽出する関数
 */
function parseMessage(message) {
  try {
    console.log(`[PARSE_MESSAGE] Parsing message ID: ${message.id}`);
    
    let decodedData;
    
    // メッセージが存在するかチェック
    if (!message || !message.data) {
      console.error('[PARSE_MESSAGE_ERROR] No message data found');
      return null;
    }
    
    // データの形式によって変換方法を変える
    if (Buffer.isBuffer(message.data)) {
      // Bufferの場合、UTF-8に変換
      decodedData = message.data.toString('utf8');
    } else if (typeof message.data === 'string') {
      // Base64エンコードされた文字列の場合、デコード
      decodedData = Buffer.from(message.data, 'base64').toString('utf8');
    } else if (typeof message.data === 'object') {
      // すでにオブジェクトの場合はそのまま使用
      decodedData = JSON.stringify(message.data);
    } else {
      // その他の場合は文字列に変換
      decodedData = String(message.data);
    }
    
    console.log(`[PARSE_MESSAGE] Decoded data: ${decodedData.substring(0, 200)}${decodedData.length > 200 ? '...' : ''}`);
    
    // JSONパース
    let jobData;
    try {
      jobData = JSON.parse(decodedData);
    } catch (parseError) {
      console.error(`[PARSE_MESSAGE_ERROR] Failed to parse JSON: ${parseError.message}`);
      return null;
    }
    
    // ジョブデータの検証
    if (!jobData.id || !jobData.fileIds || !Array.isArray(jobData.fileIds)) {
      console.error('[PARSE_MESSAGE_ERROR] Invalid job data structure:', {
        hasId: !!jobData.id,
        hasFileIds: !!jobData.fileIds,
        fileIdsIsArray: Array.isArray(jobData.fileIds)
      });
      return null;
    }
    
    console.log(`[PARSE_MESSAGE] Successfully parsed job ID: ${jobData.id}`);
    return jobData;
  } catch (error) {
    console.error(`[PARSE_MESSAGE_ERROR] Error parsing message: ${error.message}`, error);
    return null;
  }
}

/**
 * ジョブを処理する関数
 */
async function processJob(job) {
  console.log(`[PROCESS_JOB] Processing job: ${job.id}`);
  
  try {
    // ジョブプレフィックス（GCSのパス）
    const jobPrefix = `meetings/${getFormattedDate()}/${job.id}/`;
    
    // 各ファイルIDに対応するファイルをダウンロードして処理
    const fileCount = job.fileIds.length;
    console.log(`[PROCESS_JOB] Processing ${fileCount} files for job ${job.id}`);
    
    if (fileCount === 0) {
      throw new Error('No files to process');
    }
    
    // 最初のファイルを取得（現在は単一ファイル対応）
    const fileId = job.fileIds[0];
    console.log(`[PROCESS_JOB] Processing file ID: ${fileId}`);
    
    // GCSからメディアファイルを取得
    let mediaFilePath;
    try {
      const files = await bucket.getFiles({ prefix: jobPrefix });
      for (const file of files[0]) {
        if (file.name.match(/\.(mp4|mp3|wav|m4a|webm)$/i)) {
          mediaFilePath = file.name;
          break;
        }
      }
      
      if (!mediaFilePath) {
        throw new Error('Media file not found in GCS bucket');
      }
      
      console.log(`[PROCESS_JOB] Found media file: ${mediaFilePath}`);
    } catch (error) {
      console.error(`[PROCESS_JOB_ERROR] Error finding media file: ${error.message}`);
      throw error;
    }
    
    // 作業ディレクトリを作成
    await fs.mkdir(TEMP_DIR, { recursive: true });
    
    // GCSからメディアファイルをダウンロード
    const localMediaPath = path.join(TEMP_DIR, path.basename(mediaFilePath));
    console.log(`[PROCESS_JOB] Downloading media file to: ${localMediaPath}`);
    
    try {
      await bucket.file(mediaFilePath).download({ destination: localMediaPath });
      console.log(`[PROCESS_JOB] Downloaded media file (${fs.statSync(localMediaPath).size} bytes)`);
    } catch (error) {
      console.error(`[PROCESS_JOB_ERROR] Error downloading media file: ${error.message}`);
      throw error;
    }
    
    // メディアファイルからオーディオを抽出
    const localAudioPath = path.join(TEMP_DIR, `${job.id}.wav`);
    console.log(`[PROCESS_JOB] Extracting audio to: ${localAudioPath}`);
    
    try {
      await extractAudio(localMediaPath, localAudioPath);
      console.log(`[PROCESS_JOB] Audio extraction complete (${fs.statSync(localAudioPath).size} bytes)`);
    } catch (error) {
      console.error(`[PROCESS_JOB_ERROR] Error extracting audio: ${error.message}`);
      throw error;
    }
    
    // 音声認識を実行
    console.log(`[PROCESS_JOB] Starting speech recognition`);
    let transcriptData;
    
    try {
      transcriptData = await transcribeAudio(localAudioPath, job.text || '');
      console.log(`[PROCESS_JOB] Transcription complete: ${transcriptData.transcript.substring(0, 100)}...`);
    } catch (error) {
      console.error(`[PROCESS_JOB_ERROR] Error in speech recognition: ${error.message}`);
      throw error;
    }
    
    // 文字起こし結果をGCSにアップロード
    const transcriptGcsPath = `${jobPrefix}transcript.json`;
    const transcriptLocalPath = path.join(TEMP_DIR, 'transcript.json');
    
    try {
      await fs.writeFile(transcriptLocalPath, JSON.stringify(transcriptData, null, 2));
      await bucket.upload(transcriptLocalPath, { destination: transcriptGcsPath });
      console.log(`[PROCESS_JOB] Uploaded transcript to: ${transcriptGcsPath}`);
    } catch (error) {
      console.error(`[PROCESS_JOB_ERROR] Error uploading transcript: ${error.message}`);
      throw error;
    }
    
    // 一時ファイルを削除
    try {
      await fs.unlink(localMediaPath).catch(() => {});
      await fs.unlink(localAudioPath).catch(() => {});
      await fs.unlink(transcriptLocalPath).catch(() => {});
      console.log(`[PROCESS_JOB] Cleaned up temporary files`);
    } catch (error) {
      console.log(`[PROCESS_JOB_WARNING] Error cleaning up temporary files: ${error.message}`);
      // クリーンアップエラーは致命的ではないので続行
    }
    
    console.log(`[PROCESS_JOB] Job ${job.id} completed successfully`);
    
    // コールバック送信
    const callbackData = {
      jobId: job.id,
      status: 'success',
      transcriptUrl: `https://storage.googleapis.com/${BUCKET_NAME}/${transcriptGcsPath}`,
      metadata: transcriptData.metadata || {}
    };
    
    await sendCallback(callbackData);
    
    // 処理結果を返す
    return callbackData;
  } catch (error) {
    console.error(`[PROCESS_JOB_ERROR] Error processing job ${job.id}: ${error.message}`, error);
    
    // エラー情報をコールバック
    const callbackData = {
      jobId: job.id,
      status: 'failure',
      error: error.message
    };
    
    try {
      await sendCallback(callbackData);
    } catch (callbackError) {
      console.error(`[CALLBACK_ERROR] Failed to send error callback: ${callbackError.message}`);
    }
    
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
 * 処理結果をコールバックURLに送信する関数
 */
async function sendCallback(data) {
  if (!CALLBACK_URL) {
    console.log('[CALLBACK] No callback URL configured, skipping callback');
    return;
  }
  
  try {
    console.log(`[CALLBACK] Sending callback for job ${data.jobId}`);
    console.log(`[CALLBACK] Callback URL: ${CALLBACK_URL}`);
    console.log(`[CALLBACK] Callback data: ${JSON.stringify(data)}`);
    
    const response = await axios.post(CALLBACK_URL, data, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 10000 // 10秒でタイムアウト
    });
    
    console.log(`[CALLBACK] Callback sent successfully, response: ${response.status} ${response.statusText}`);
    return true;
  } catch (error) {
    console.error(`[CALLBACK_ERROR] Error sending callback: ${error.message}`, error);
    
    // エラーの詳細ログ
    const errorDetails = {
      message: error.message,
      code: error.code,
      response: error.response ? {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data
      } : null
    };
    
    console.error(`[CALLBACK_ERROR] Detailed error: ${JSON.stringify(errorDetails)}`);
    return false;
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