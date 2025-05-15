#!/usr/bin/env node

/**
 * Dagitoru Cloud Run Job
 * 動画処理、音声抽出、文字起こしを行うメインスクリプト
 */

require('dotenv').config();
const { Storage } = require('@google-cloud/storage');
const { PubSub } = require('@google-cloud/pubsub');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const { execSync } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const speech = require('@google-cloud/speech').v1p1beta1;
const { v4: uuidv4 } = require('uuid');

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
const subscription = pubsub.subscription(SUBSCRIPTION_NAME);
const speechClient = new speech.SpeechClient();

/**
 * メイン処理関数
 */
async function main() {
  console.log('Cloud Run Job started');
  
  try {
    // 環境変数のチェック
    if (!BUCKET_NAME || !PROJECT_ID || !CALLBACK_URL || !SUBSCRIPTION_NAME) {
      throw new Error('必須環境変数が設定されていません');
    }

    // Pub/Subからメッセージを受信
    const message = await receiveMessage();
    
    if (!message) {
      console.log('No message received, exiting...');
      return;
    }
    
    // メッセージからジョブ情報を抽出
    const job = parseMessage(message);
    
    if (!job) {
      console.error('Invalid job data');
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
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

/**
 * Pub/Subからメッセージを受信する関数
 */
async function receiveMessage() {
  return new Promise((resolve, reject) => {
    // 1分間メッセージを待機
    const timeout = setTimeout(() => {
      subscription.removeAllListeners();
      resolve(null);
    }, 60000);
    
    subscription.on('message', (message) => {
      clearTimeout(timeout);
      subscription.removeAllListeners();
      resolve(message);
    });
    
    subscription.on('error', (error) => {
      clearTimeout(timeout);
      subscription.removeAllListeners();
      reject(error);
    });
  });
}

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
 * 音声ファイルの文字起こしを行う関数
 */
async function transcribeSpeech(audioPath) {
  console.log(`Transcribing speech from ${audioPath}`);
  
  // 音声ファイルのコンテンツを読み込み
  const audioBytes = await fs.readFile(audioPath);
  const audio = {
    content: audioBytes.toString('base64'),
  };
  
  // Speech-to-Text構成
  const config = {
    encoding: 'FLAC',
    sampleRateHertz: 16000,
    languageCode: 'ja-JP',
    enableAutomaticPunctuation: true,
    enableWordTimeOffsets: true,
    model: 'latest_long',
    useEnhanced: true,
  };
  
  const request = {
    audio: audio,
    config: config,
  };
  
  // Speech-to-Textの実行
  const [operation] = await speechClient.longRunningRecognize(request);
  const [response] = await operation.promise();
  
  // 結果の整形
  let transcript = '';
  const results = response.results;
  
  if (results && results.length > 0) {
    for (const result of results) {
      transcript += result.alternatives[0].transcript + ' ';
    }
  }
  
  console.log(`Transcription completed: ${transcript.substring(0, 100)}...`);
  return transcript;
}

/**
 * コールバックを送信する関数
 */
async function sendCallback(data) {
  try {
    console.log(`Sending callback for job ${data.jobId}, status: ${data.status}`);
    const response = await axios.post(CALLBACK_URL, data, {
      headers: {
        'Content-Type': 'application/json',
      },
    });
    
    console.log(`Callback sent, response status: ${response.status}`);
    return true;
  } catch (error) {
    console.error('Error sending callback:', error);
    return false;
  }
}

/**
 * 現在の日付を YYYYMMDD_HHMM 形式で取得する関数
 */
function getFormattedDate() {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
}

// スクリプト実行
main().catch(console.error); 