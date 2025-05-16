import { NextRequest, NextResponse } from 'next/server';
import { WebClient } from '@slack/web-api';
import { v4 as uuidv4 } from 'uuid';
import { CONFIG } from '@/app/lib/config';
import { SlackEventPayload, ProcessingJob, SlackFile } from '@/app/lib/types';
import { uploadFileToGCS, sendSlackMessage, startCloudRunJob, getFileType, extractDateFromText, extractNamesFromText } from '@/app/lib/utils';

// Slackクライアント初期化
const slackClient = new WebClient(CONFIG.SLACK_TOKEN);

// 複合コンテンツ（テキスト+ファイル）処理エンドポイント
export async function POST(req: NextRequest) {
  try {
    console.log('combined-handler: Received request');
    const payload = await req.json() as SlackEventPayload;
    const { event } = payload;
    
    console.log('combined-handler: Processing message with files');
    
    // ファイル情報を取得
    let files: SlackFile[] = [];
    
    if (event.files) {
      files = event.files;
      console.log(`combined-handler: Found ${files.length} files in the message`);
    } else {
      console.log('combined-handler: No files found in the message');
      return NextResponse.json({ error: 'No files found' }, { status: 400 });
    }
    
    // テキスト内容を取得
    const messageText = event.text || '';
    console.log('combined-handler: Message text:', messageText);
    
    // テキスト内容から日付やクライアント情報などを抽出
    const dateStr = extractDateFromText(messageText);
    const { client, consultant } = extractNamesFromText(messageText);
    
    // ジョブID生成
    const jobId = uuidv4();
    console.log('combined-handler: Generated job ID:', jobId);
    
    // 各ファイルをGCSにアップロード
    const filePromises = files.map(async (file) => {
      // ファイルサイズチェック
      if (file.size > CONFIG.MAX_FILE_SIZE) {
        console.log(`combined-handler: File size too large: ${file.name} (${file.size} bytes)`);
        await sendSlackMessage(
          event.channel,
          `ファイルサイズが大きすぎます（最大1GB）: ${file.name}`,
          event.thread_ts || event.ts
        );
        return null;
      }
      
      // ファイルタイプの判別
      const fileType = getFileType(file);
      console.log(`combined-handler: File type: ${fileType} for file ${file.name}`);
      
      // GCSにアップロード
      console.log(`combined-handler: Uploading file to GCS: ${file.name}`);
      const uploadResult = await uploadFileToGCS(
        file.url_private,
        jobId,
        file.name
      );
      
      if (!uploadResult.success) {
        console.error(`combined-handler: Failed to upload file: ${file.name}`, uploadResult.error);
        await sendSlackMessage(
          event.channel,
          `ファイルのアップロードに失敗しました: ${file.name}`,
          event.thread_ts || event.ts
        );
        return null;
      }
      
      console.log(`combined-handler: File uploaded successfully: ${file.name} -> ${uploadResult.path}`);
      return {
        id: file.id,
        name: file.name,
        type: fileType,
        gcsPath: uploadResult.path,
        gcsUrl: uploadResult.url
      };
    });
    
    // すべてのファイルのアップロード結果を待機
    const fileResults = await Promise.all(filePromises);
    const validFiles = fileResults.filter(Boolean);
    
    if (validFiles.length === 0) {
      console.error('combined-handler: No valid files were uploaded');
      return NextResponse.json({ error: 'No valid files uploaded' }, { status: 400 });
    }
    
    console.log(`combined-handler: Successfully uploaded ${validFiles.length} files`);
    
    // ジョブ作成
    const job: ProcessingJob = {
      id: jobId,
      fileIds: validFiles.map(file => file?.id as string),
      text: messageText, // テキストメッセージを追加
      channel: event.channel,
      ts: event.ts,
      thread_ts: event.thread_ts,
      user: event.user,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    console.log('combined-handler: Created processing job:', job);
    
    // メタデータ情報を追加
    const metadata = {
      date: dateStr,
      client,
      consultant
    };
    
    // Slackにアップロード完了通知
    await sendSlackMessage(
      event.channel,
      `📝 メッセージとファイルを受け取りました。処理を開始します。\n🎥 動画ファイル数: ${validFiles.length}`,
      event.thread_ts || event.ts
    );
    
    // Cloud Run Jobを開始
    console.log('combined-handler: Starting Cloud Run job');
    await startCloudRunJob(job);
    
    return NextResponse.json({ jobId, success: true });
  } catch (error) {
    console.error('combined-handler: Error processing combined content:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
} 