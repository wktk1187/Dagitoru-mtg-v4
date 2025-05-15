import { NextRequest, NextResponse } from 'next/server';
import { WebClient } from '@slack/web-api';
import { v4 as uuidv4 } from 'uuid';
import { CONFIG } from '@/app/lib/config';
import { SlackEventPayload, ProcessingJob, SlackFile } from '@/app/lib/types';
import { uploadFileToGCS, sendSlackMessage, startCloudRunJob, getFileType } from '@/app/lib/utils';

// Slackクライアント初期化
const slackClient = new WebClient(CONFIG.SLACK_TOKEN);

// ファイル処理エンドポイント
export async function POST(req: NextRequest) {
  try {
    const payload = await req.json() as SlackEventPayload;
    const { event } = payload;
    
    // ファイル情報を取得
    let files: SlackFile[] = [];
    
    if (event.files) {
      files = event.files;
    } else {
      // file_sharedイベントの場合、追加でファイル情報を取得
      try {
        const fileInfoResponse = await slackClient.files.info({
          file: event.file_id || '',
        });
        
        if (fileInfoResponse.file) {
          files = [fileInfoResponse.file as unknown as SlackFile];
        }
      } catch (error) {
        console.error('Failed to fetch file info:', error);
        return NextResponse.json({ error: 'Failed to fetch file info' }, { status: 500 });
      }
    }
    
    if (files.length === 0) {
      return NextResponse.json({ error: 'No files found' }, { status: 400 });
    }
    
    // ジョブID生成
    const jobId = uuidv4();
    
    // 各ファイルをGCSにアップロード
    const filePromises = files.map(async (file) => {
      // ファイルサイズチェック
      if (file.size > CONFIG.MAX_FILE_SIZE) {
        await sendSlackMessage(
          event.channel,
          `ファイルサイズが大きすぎます（最大1GB）: ${file.name}`,
          event.thread_ts || event.ts
        );
        return null;
      }
      
      // ファイルタイプの判別
      const fileType = getFileType(file);
      
      // GCSにアップロード
      const uploadResult = await uploadFileToGCS(
        file.url_private,
        jobId,
        file.name
      );
      
      if (!uploadResult.success) {
        await sendSlackMessage(
          event.channel,
          `ファイルのアップロードに失敗しました: ${file.name}`,
          event.thread_ts || event.ts
        );
        return null;
      }
      
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
      return NextResponse.json({ error: 'No valid files uploaded' }, { status: 400 });
    }
    
    // ジョブ作成
    const job: ProcessingJob = {
      id: jobId,
      fileIds: validFiles.map(file => file?.id as string),
      channel: event.channel,
      ts: event.ts,
      thread_ts: event.thread_ts,
      user: event.user,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    // Slackにアップロード完了通知
    await sendSlackMessage(
      event.channel,
      `Upload OK: ${validFiles.length}個のファイルを処理中です`,
      event.thread_ts || event.ts
    );
    
    // Cloud Run Jobを開始
    await startCloudRunJob(job);
    
    return NextResponse.json({ jobId, success: true });
  } catch (error) {
    console.error('Error processing file:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
} 