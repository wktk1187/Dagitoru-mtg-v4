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
const pubsub = new PubSub();
const speechClient = new speech.SpeechClient();

// PubSubサブスクリプションの初期化
const subscription = pubsub.subscription(SUBSCRIPTION_NAME);

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
      console.log(`Polling messages from subscription: ${SUBSCRIPTION_NAME}`);
      
      // メッセージを最大10件取得（正しいAPIメソッドを使用）
      subscription.on('message', async (message) => {
        console.log(`Processing message ${message.id}:`, message.data.toString());
        
        try {
          // メッセージからジョブデータを抽出
          const job = parseMessage({ data: message.data });
          
          if (!job) {
            console.error('Invalid job data, acknowledging message');
            message.ack();
            return;
          }
          
          console.log(`Processing job: ${job.id}`);
          
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
      });
      
      // エラーハンドリング
      subscription.on('error', (error) => {
        console.error('Subscription error:', error);
      });
      
      console.log('Message listener attached. Waiting for messages...');
      
    } catch (error) {
      console.error('Error setting up message listener:', error);
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
    const data = JSON.parse(Buffer.from(message.data, 'base64').toString());
    
    // 必須フィールドの確認
    if (!data.id || !data.fileIds) {
      console.error('Missing required job fields');
      return null;
    }
    
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
    
    // 結果を返す
    return {
      transcriptUrl: `https://storage.googleapis.com/${BUCKET_NAME}/${transcriptGcsPath}`
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