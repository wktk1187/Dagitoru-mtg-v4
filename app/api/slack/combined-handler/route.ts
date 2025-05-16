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
    
    // 処理結果を保存する配列
    const results: {
      success: string[];
      error: string[];
    } = {
      success: [],
      error: []
    };
    
    // 各ファイルをGCSにアップロード
    const filePromises = files.map(async (file) => {
      // ファイルサイズチェック
      if (file.size > CONFIG.MAX_FILE_SIZE) {
        console.log(`combined-handler: File size too large: ${file.name} (${file.size} bytes)`);
        results.error.push(`${file.name} (サイズ超過: ${Math.round(file.size / 1024 / 1024)}MB)`);
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
        results.error.push(`${file.name} (アップロード失敗: ${uploadResult.error})`);
        return null;
      }
      
      console.log(`combined-handler: File uploaded successfully: ${file.name} -> ${uploadResult.path}`);
      results.success.push(file.name);
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
      
      // エラーメッセージ（1回だけ送信）
      try {
        await sendSlackMessage(
          event.channel,
          `❌ ファイル処理に失敗しました:\n${results.error.join('\n')}`,
          event.thread_ts || event.ts
        );
      } catch (error) {
        console.error('Slack message sending failed:', error);
      }
      
      return NextResponse.json({ error: 'No valid files uploaded' }, { status: 400 });
    }
    
    console.log(`combined-handler: Successfully uploaded ${validFiles.length} files`);
    
    // ジョブ作成
    const job: ProcessingJob = {
      id: jobId,
      fileIds: validFiles.map(file => file?.id as string),
      text: messageText,
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
    
    // 処理結果のサマリーを作成（1回だけメッセージ送信）
    let statusMessage = `📝 処理ジョブを作成しました (ID: ${jobId})`;
    
    if (results.success.length > 0) {
      statusMessage += `\n✅ 処理対象ファイル(${results.success.length}件): ${results.success.join(', ')}`;
    }
    
    if (results.error.length > 0) {
      statusMessage += `\n❌ 処理できなかったファイル(${results.error.length}件): ${results.error.join(', ')}`;
    }
    
    statusMessage += `\n📊 処理が完了するとお知らせします。`;
    
    // Slackに最終結果を1回だけ通知
    try {
      await sendSlackMessage(
        event.channel,
        statusMessage,
        event.thread_ts || event.ts
      );
    } catch (error) {
      console.error('combined-handler: Failed to send Slack notification:', error);
    }
    
    // Cloud Run Jobを開始
    console.log('combined-handler: Starting Cloud Run job');
    await startCloudRunJob(job);
    
    return NextResponse.json({ jobId, success: true });
  } catch (error) {
    console.error('combined-handler: Error processing combined content:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
} 