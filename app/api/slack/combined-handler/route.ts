import { NextRequest, NextResponse } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { CONFIG } from '@/app/lib/config';
import { SlackEventPayload, ProcessingJob, SlackFile } from '@/app/lib/types';
import { uploadFileToGCS, sendSlackMessage, startCloudRunJob, getFileType, extractDateFromText, extractNamesFromText } from '@/app/lib/utils';

// 複合コンテンツ（テキスト+ファイル）処理エンドポイント
export async function POST(req: NextRequest) {
  try {
    const payload = await req.json() as SlackEventPayload;
    const { event } = payload;
    
    // ファイルとテキストの両方が必要
    if (!event.files || event.files.length === 0) {
      return NextResponse.json({ error: 'No files found' }, { status: 400 });
    }
    
    if (!event.text || event.text.trim() === '') {
      return NextResponse.json({ error: 'No text content' }, { status: 400 });
    }
    
    // ボットからのメッセージは処理しない（無限ループ防止）
    if (event.bot_id) {
      return NextResponse.json({ ignored: 'Bot message' });
    }
    
    // テキスト内容から日付やクライアント情報などを抽出
    const dateStr = extractDateFromText(event.text);
    const { client, consultant } = extractNamesFromText(event.text);
    
    // ジョブID生成
    const jobId = uuidv4();
    
    // 各ファイルをGCSにアップロード
    const filePromises = event.files.map(async (file: SlackFile) => {
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
    
    // ジョブ作成 - テキストとファイル情報の両方を含む
    const job: ProcessingJob = {
      id: jobId,
      fileIds: validFiles.map(file => file?.id as string),
      text: event.text, // テキスト内容も含める
      channel: event.channel,
      ts: event.ts,
      thread_ts: event.thread_ts,
      user: event.user,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    // メタデータ情報を追加（Cloud Runに渡すための追加情報）
    const metadata = {
      date: dateStr,
      client,
      consultant,
      fileCount: validFiles.length,
      fileTypes: validFiles.map(file => file?.type)
    };
    
    // Slackにアップロード完了通知
    await sendSlackMessage(
      event.channel,
      `Upload OK: ${validFiles.length}個のファイルとテキスト情報を処理中です`,
      event.thread_ts || event.ts
    );
    
    // Cloud Run Jobを開始 - メタデータを追加
    const jobWithMetadata = {
      ...job,
      metadata
    };
    
    await startCloudRunJob(jobWithMetadata);
    
    return NextResponse.json({ 
      jobId, 
      success: true,
      fileCount: validFiles.length,
      hasMetadata: Boolean(dateStr || client || consultant)
    });
  } catch (error) {
    console.error('Error processing combined content:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
} 