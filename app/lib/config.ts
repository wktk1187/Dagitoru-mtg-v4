// アプリ設定
export const CONFIG = {
    // Slack設定
    SLACK_TOKEN: process.env.SLACK_TOKEN || '',
    SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET || '',
  
  // Google Cloud設定
  GCP_PROJECT_ID: process.env.GCP_PROJECT_ID || '',
  GCS_BUCKET_NAME: process.env.GCS_BUCKET_NAME || '',
  PUBSUB_TOPIC: process.env.PUBSUB_TOPIC || '',
  
  // Notion設定
  NOTION_API_KEY: process.env.NOTION_API_KEY || '',
  NOTION_DATABASE_ID: process.env.NOTION_DATABASE_ID || '',
  
  // Cloud Run設定
  CLOUD_RUN_JOB_SERVICE: process.env.CLOUD_RUN_JOB_SERVICE || '',
  
  // 一般設定
  MAX_FILE_SIZE: 1024 * 1024 * 1024, // 1GB
  PROCESSING_TIMEOUT: 30 * 60 * 1000, // 30分
};

// GCSのパス生成関数
export function getGCSPath(jobId: string, filename: string): string {
  const date = new Date();
  const formattedDate = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}_${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}`;
  return `meetings/${formattedDate}/${jobId}/${filename}`;
} 