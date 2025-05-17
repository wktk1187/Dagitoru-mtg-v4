#!/usr/bin/env node

/**
 * Dagitoru Cloud Run Job
 * 動画処理、音声抽出、文字起こしを行うメインスクリプト
 */

require('dotenv').config();
const express = require('express');
const { Storage } = require('@google-cloud/storage');
// const { PubSub } = require('@google-cloud/pubsub'); // Pull型では不要になるためコメントアウト
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
// const SUBSCRIPTION_NAME = process.env.PUBSUB_SUBSCRIPTION; // Pull型では不要
const TEMP_DIR = '/tmp';

// クライアント初期化
const storage = new Storage();
const bucket = storage.bucket(BUCKET_NAME);
// const pubsub = new PubSub({ projectId: PROJECT_ID }); // Pull型では不要
const speechClient = new speech.SpeechClient();

/* // Pull型サブスクリプションの初期化とメッセージ処理 - Push型では不要なためコメントアウト
let subscriptionName = SUBSCRIPTION_NAME;
if (!subscriptionName.startsWith('projects/')) {
  subscriptionName = `projects/${PROJECT_ID}/subscriptions/${SUBSCRIPTION_NAME}`;
}
console.log(`[PUBSUB_INIT] Using subscription: ${subscriptionName}`);
const subscription = pubsub.subscription(subscriptionName);
async function processMessages() { ... }
const setupMessageListener = () => { ... };
setupMessageListener();
*/

// ミドルウェア設定 (既に存在することを確認)
app.use(express.json()); // bodyParser.json() の代わりに express.json() を使用

// ルート設定 - ヘルスチェック用
app.get('/', (req, res) => {
  res.status(200).send('Dagitoru Processor is running');
});

// 新しい /pubsub エンドポイント (Push型サブスクリプション用)
app.post('/pubsub', async (req, res) => {
  try {
    console.log('[PUBSUB_PUSH_RECEIVED] Received Pub/Sub message via Push');
    if (!req.body || !req.body.message || !req.body.message.data) {
      console.error('[PUBSUB_PUSH_ERROR] Invalid Pub/Sub message format');
      return res.status(400).send('Bad Request: Invalid Pub/Sub message format');
    }

    const messageData = Buffer.from(req.body.message.data, 'base64').toString('utf8');
    console.log(`[PUBSUB_PUSH_DATA] Decoded message data: ${messageData.substring(0, 500)}`);
    
    const job = JSON.parse(messageData); // parseMessage関数は使わず直接パース
    
    if (!job || !job.id || !job.fileIds) {
      console.error('[PUBSUB_PUSH_ERROR] Invalid job data after parsing', job);
      return res.status(400).send('Bad Request: Invalid job data after parsing');
    }

    console.log(`[PUBSUB_PUSH_JOB] Processing job ID: ${job.id}`);

    // ジョブ処理を非同期で実行
    processJob(job)
      .then(result => {
        console.log(`[PUBSUB_PUSH_JOB_SUCCESS] Job ${job.id} processed successfully.`);
        // sendCallback は processJob 内で呼び出されるためここでは不要
      })
      .catch(error => {
        console.error(`[PUBSUB_PUSH_JOB_ERROR] Error processing job ${job.id}: ${error.message}`, error);
        // エラー時のコールバックも processJob 内で処理される想定
      });

    res.status(200).send('OK'); // Pub/Sub にはすぐにACKを返す
  } catch (err) {
    console.error('[PUBSUB_PUSH_FATAL_ERROR] Error handling Pub/Sub push message:', err);
    res.status(500).send('Internal Server Error');
  }
});

// 以前の /process エンドポイントはPub/Sub Push型では通常不要になるためコメントアウト
/*
app.post('/process', async (req, res) => {
  console.log('Processing request received:', req.body);
  // ... (以前のコード)
});
*/

// サーバー起動
app.listen(port, () => {
  console.log(`Dagitoru Processor listening on port ${port}`);
});

// parseMessage関数は /pubsub エンドポイント内で直接処理するため、ここでは不要になる可能性があります。
// ただし、processJob関数がまだ依存している場合は残します。
// 今回は直接JSON.parseするため、parseMessageはコメントアウトまたは削除の対象です。
/*
function parseMessage(message) {
  // ... (以前のコード)
}
*/

/**
 * ジョブを処理する関数 (内容は変更なし、呼び出し元が変わるだけ)
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
async function transcribeSpeech(audioPath, textContext) {
  console.log(`Starting speech recognition for ${audioPath}`);
  console.log(`With text context (first 100 chars): ${textContext ? textContext.substring(0,100) : 'N/A'}`);
  
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
    },
    speechContexts: textContext ? [{
      phrases: textContext.split('\\n').map(line => line.trim()).filter(line => line.length > 0),
      boost: 15
    }] : [],
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