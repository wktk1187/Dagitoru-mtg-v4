// app/lib/types/job.ts
import { Timestamp } from 'firebase-admin/firestore'; // Timestampを直接インポート

export type JobStatus =
  | "pending" // VercelでPub/Sub発行直後
  | "processing_audio" // Cloud Run: 音声処理開始
  | "transcribing" // Cloud Run: 文字起こし開始
  | "summarizing" // Cloud Run: 要約処理開始
  | "completed" // Cloud Run: 全処理成功
  | "failed"; // Cloud Run: 何らかのエラー発生

export interface JobRecord {
  jobId: string;
  status: JobStatus;
  createdAt: Timestamp; // インポートしたTimestamp型を使用
  updatedAt: Timestamp; // インポートしたTimestamp型を使用
  gcsPaths?: string[];
  fileNames?: string[];
  slackEvent?: Record<string, any>; // 元のSlackイベント情報
  errorDetails?: string; // エラー発生時の詳細
  result?: {
    notionUrl?: string;
    transcriptUrl?: string; // 文字起こし結果のGCSパスなど
    summary?: string; // 要約結果のテキストなど
  };
  // 必要に応じて他のメタデータを追加
} 