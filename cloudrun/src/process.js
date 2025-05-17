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
const { Firestore, Timestamp } = require('@google-cloud/firestore');

// HTTPサーバー設定
const app = express();
const port = process.env.PORT || 8080;

// 定数設定
const BUCKET_NAME = process.env.GCS_BUCKET_NAME;
const PROJECT_ID = process.env.GCP_PROJECT_ID;
const CALLBACK_URL = process.env.CALLBACK_URL;
const TEMP_DIR = '/tmp';

// クライアント初期化
const storage = new Storage();
const bucket = storage.bucket(BUCKET_NAME);
const pubsub = new PubSub({ projectId: PROJECT_ID });
const speechClient = new speech.SpeechClient();

// Firestoreクライアントの初期化
const firestore = new Firestore();

// ミドルウェア設定 (既に存在することを確認)
app.use(express.json()); // bodyParser.json() の代わりに express.json() を使用

// ルート設定 - ヘルスチェック用
app.get('/', (req, res) => {
  res.status(200).send('Dagitoru Processor is running');
});

// 新しい /pubsub エンドポイント (Push型サブスクリプション用)
app.post('/pubsub', async (req, res) => {
  console.log('[PUBSUB_PUSH_RECEIVED] Request body:', JSON.stringify(req.body));
  if (!req.body || !req.body.message) {
    console.error('[PUBSUB_PUSH_ERROR] Invalid Pub/Sub message format');
    return res.status(400).send('Invalid Pub/Sub message format');
  }

  const pubSubMessage = req.body.message;
  const parsedMessageData = await parseMessage(pubSubMessage);

  if (!parsedMessageData || !parsedMessageData.jobId) {
    console.error('[PUBSUB_PUSH_ERROR] Missing jobId in parsed message data');
    return res.status(400).send('Missing jobId in message data');
  }
  const { jobId, gcsPaths, fileNames, slackEvent, textContext } = parsedMessageData;
  console.log(`[PUBSUB_PUSH_JOB_START] Starting job: ${jobId}`);
  
  try {
    const result = await processJob(jobId, gcsPaths, fileNames, slackEvent, textContext);
    if (result.success) {
      console.log(`[JOB_SUCCESS] Job ${jobId} completed successfully.`);
      // ここでのSlack通知はVercel側に任せるため、基本的には204を返す
      // Firestoreへの最終ステータス更新はprocessJob内で行われる
      res.status(204).send(); 
    } else {
      console.error(`[JOB_FAILED] Job ${jobId} failed. Error: ${result.error}`);
      // エラーの場合もPub/SubにはACKを返す（リトライはFirestoreの状態を見て別途行う設計のため）
      // Firestoreへのfailedステータス更新はprocessJob内で行われる
      res.status(204).send(); // または適切なエラーコードを返すが、Pub/Subのリトライポリシーに注意
    }
  } catch (error) {
    console.error(`[JOB_UNHANDLED_ERROR] Unhandled error processing job ${jobId}:`, error);
    // このレベルのエラーは握りつぶさず、500を返してPub/Subにリトライさせるか検討
    // ただし、リトライで解決しない問題の場合、無限ループになる可能性も
    // 安全策としてACKし、Firestoreの状態で追跡・手動介入を基本とする方が良い場合もある
    await updateJobStatus(jobId, 'failed', { errorDetails: 'Unhandled exception in /pubsub endpoint: ' + error.message });
    res.status(500).send('Internal Server Error'); // Pub/Subがリトライする
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

/**
 * ジョブを処理する関数 (内容は変更なし、呼び出し元が変わるだけ)
 */
async function processJob(jobId, gcsPaths, fileNames, slackEvent, textContext) {
  console.log(`[PROCESS_JOB_START] jobId: ${jobId}`, { gcsPaths, fileNames });
  await updateJobStatus(jobId, 'processing_audio');

  if (!gcsPaths || gcsPaths.length === 0) {
    console.error('[PROCESS_JOB_ERROR] No GCS paths provided for job:', jobId);
    await updateJobStatus(jobId, 'failed', { errorDetails: 'No GCS paths provided' });
    return { success: false, error: 'No GCS paths provided' };
  }

  // 現在は最初のファイルのみ処理する前提（後で複数ファイル対応検討）
  const gcsPath = gcsPaths[0]; 
  const originalFileName = fileNames && fileNames.length > 0 ? fileNames[0] : 'unknown_file';
  const bucketName = gcsPath.split('/')[2];
  const filePath = gcsPath.substring(gcsPath.indexOf(bucketName) + bucketName.length + 1);

  let transcript;
  let audioProcessedPath;

  try {
    // 1. GCSからファイルをダウンロード
    const tempInputPath = path.join(TEMP_DIR, `input-${jobId}-${originalFileName}`);
    console.log(`[GCS_DOWNLOAD_START] Downloading ${gcsPath} to ${tempInputPath}`);
    await storage.bucket(bucketName).file(filePath).download({ destination: tempInputPath });
    console.log(`[GCS_DOWNLOAD_SUCCESS] File downloaded to ${tempInputPath}`);

    // 2. 音声抽出 (ffmpeg)
    const tempAudioOutputPath = path.join(TEMP_DIR, `audio-${jobId}-${uuidv4()}.flac`);
    console.log(`[FFMPEG_START] Converting ${tempInputPath} to ${tempAudioOutputPath}`);
    await new Promise((resolve, reject) => {
      ffmpeg(tempInputPath)
        .toFormat('flac')
        .audioFrequency(16000)
        .audioChannels(1)
        .on('error', (err) => {
          console.error('[FFMPEG_ERROR]', err);
          reject(err);
        })
        .on('end', () => {
          console.log('[FFMPEG_SUCCESS] Audio conversion finished.');
          resolve();
        })
        .save(tempAudioOutputPath);
    });
    
    // 抽出した音声をGCSにアップロード (文字起こしAPIがGCS URIを直接扱えるなら不要な場合も)
    audioProcessedPath = `processed-audio/${jobId}/${path.basename(tempAudioOutputPath)}`;
    await storage.bucket(BUCKET_NAME).upload(tempAudioOutputPath, {
        destination: audioProcessedPath,
    });
    console.log(`[GCS_UPLOAD_AUDIO_SUCCESS] Processed audio uploaded to gs://${BUCKET_NAME}/${audioProcessedPath}`);
    await updateJobStatus(jobId, 'transcribing', { processedAudioGcsPath: `gs://${BUCKET_NAME}/${audioProcessedPath}` });

    // 3. Speech-to-Textで文字起こし
    console.log(`[STT_START] Transcribing audio from gs://${BUCKET_NAME}/${audioProcessedPath}`);
    const [operation] = await speechClient.longRunningRecognize({
      audio: { uri: `gs://${BUCKET_NAME}/${audioProcessedPath}` },
      config: {
        encoding: 'FLAC',
        sampleRateHertz: 16000,
        languageCode: 'ja-JP',
        enableAutomaticPunctuation: true,
        speechContexts: textContext ? [{ phrases: textContext.split(','), boost: 15 }] : [],
      },
    });
    const [response] = await operation.promise();
    transcript = response.results.map(result => result.alternatives[0].transcript).join('\n');
    console.log(`[STT_SUCCESS] Transcription length: ${transcript.length}`);
    const transcriptGcsPath = `transcripts/${jobId}/transcript.txt`;
    await storage.bucket(BUCKET_NAME).file(transcriptGcsPath).save(transcript);
    console.log(`[GCS_UPLOAD_TRANSCRIPT_SUCCESS] Transcript uploaded to gs://${BUCKET_NAME}/${transcriptGcsPath}`);
    await updateJobStatus(jobId, 'summarizing', { transcriptGcsPath: `gs://${BUCKET_NAME}/${transcriptGcsPath}` });

    // ここでGemini API呼び出しとNotionへの保存が入る (現状のコードでは省略されている)
    // 実際にはこの後に summarizeAndSaveToNotion(transcript, slackEvent, jobId) のような関数を呼び出す
    console.log('[GEMINI_NOTION_PLACEHOLDER] Summarization and Notion update would happen here.');
    // ダミーのNotion URLとサマリー
    const dummyNotionUrl = `https://www.notion.so/dummy/${jobId}`;
    const dummySummary = `This is a summary for job ${jobId}`;

    // 全処理完了
    await updateJobStatus(jobId, 'completed', { result: { notionUrl: dummyNotionUrl, summary: dummySummary, transcriptUrl: `gs://${BUCKET_NAME}/${transcriptGcsPath}` } });
    console.log(`[PROCESS_JOB_COMPLETE] jobId: ${jobId}`);
    return { success: true, notionUrl: dummyNotionUrl, summary: dummySummary, transcriptUrl: `gs://${BUCKET_NAME}/${transcriptGcsPath}` };

  } catch (error) {
    console.error(`[PROCESS_JOB_ERROR] Error in processJob for jobId ${jobId}:`, error);
    await updateJobStatus(jobId, 'failed', { errorDetails: error.message || 'Unknown error during processing' });
    return { success: false, error: error.message };
  } finally {
    // 一時ファイルの削除
    // try {
    //   if (tempInputPath) await fs.unlink(tempInputPath);
    //   if (tempAudioOutputPath) await fs.unlink(tempAudioOutputPath);
    // } catch (cleanupError) {
    //   console.warn('[CLEANUP_ERROR] Failed to delete temporary files:', cleanupError);
    // }
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

// ジョブステータス更新関数
async function updateJobStatus(jobId, status, extra = {}) {
  if (!jobId) {
    console.error('[FIRESTORE_ERROR] jobId is missing, cannot update status.');
    return;
  }
  const jobRef = firestore.collection('jobs').doc(jobId);
  const dataToUpdate = {
    status,
    updatedAt: Timestamp.now(),
    ...extra,
  };
  try {
    await jobRef.update(dataToUpdate);
    console.log(`[FIRESTORE_JOB_UPDATED] jobId: ${jobId} status: ${status}`, JSON.stringify(extra));
  } catch (error) {
    console.error(`[FIRESTORE_ERROR] Failed to update job ${jobId} to status ${status}:`, error);
  }
}

async function parseMessage(message) {
  // ... (既存のparseMessage関数、変更の可能性あり)
  // Base64デコードとJSONパース
  let messageDataString;
  if (message.data) {
    messageDataString = Buffer.from(message.data, 'base64').toString('utf-8');
    console.log('[PUBSUB_PUSH_DATA_STRING]', messageDataString);
  } else {
    console.error('[PUBSUB_PUSH_ERROR] No data in message');
    return null;
  }

  try {
    const parsedData = JSON.parse(messageDataString);
    console.log('[PUBSUB_PUSH_PARSED_DATA]', JSON.stringify(parsedData));
    return parsedData;
  } catch (error) {
    console.error('[PUBSUB_PUSH_PARSE_ERROR]', error, 'Raw data:', messageDataString);
    return null;
  }
} 