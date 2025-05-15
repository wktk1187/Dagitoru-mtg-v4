import { NextRequest, NextResponse } from 'next/server';
import { CONFIG } from '@app/lib/config';
import { ProcessingJob } from '@app/lib/types';
// import { startCloudRunJob } from '@app/lib/utils';

// 特定のジョブを再試行するためのエンドポイント
export async function POST(req: NextRequest) {
  try {
    // URLからjobIdを抽出
    const { pathname } = new URL(req.url);
    const jobId = pathname.split('/').pop();
    
    if (!jobId) {
      return NextResponse.json(
        { error: 'Job ID is required' },
        { status: 400 }
      );
    }
    
    // ジョブの詳細情報を取得（実際にはデータベースやRedisなどから取得）
    // この例では簡略化のためリクエストボディから取得
    const jobData = await req.json();
    
    // ジョブ情報を検証
    if (!jobData) {
      return NextResponse.json(
        { error: 'Job data is required' },
        { status: 400 }
      );
    }
    
    // 必須フィールドを確認
    const requiredFields = ['channel', 'ts', 'user'];
    const missingFields = requiredFields.filter(field => !jobData[field]);
    
    if (missingFields.length > 0) {
      return NextResponse.json(
        { error: `Missing required fields: ${missingFields.join(', ')}` },
        { status: 400 }
      );
    }
    
    // 再試行用のジョブを作成
    const retryJob: ProcessingJob = {
      id: jobId,
      fileIds: jobData.fileIds,
      text: jobData.text,
      channel: jobData.channel,
      ts: jobData.ts,
      thread_ts: jobData.thread_ts,
      user: jobData.user,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    // メタデータがある場合は追加
    if (jobData.metadata) {
      (retryJob as any).metadata = jobData.metadata;
    }
    
    // Cloud Run Jobを再開する代わりに成功を返す
    // const result = await startCloudRunJob(retryJob);
    const result = true; // スタブ実装
    
    if (!result) {
      return NextResponse.json(
        { error: 'Failed to start Cloud Run Job' },
        { status: 500 }
      );
    }
    
    return NextResponse.json({
      success: true,
      message: `Job ${jobId} has been restarted`
    });
  } catch (error) {
    console.error('Error retrying job:', error);
    return NextResponse.json(
      { error: `Failed to retry job: ${(error as Error).message}` },
      { status: 500 }
    );
  }
} 