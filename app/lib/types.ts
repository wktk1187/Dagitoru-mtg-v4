// Slack Event Types
export interface SlackEventPayload {
  token: string;
  team_id: string;
  api_app_id: string;
  event: SlackEvent;
  type: string;
  event_id: string;
  event_time: number;
}

export interface SlackEvent {
  type: string;
  user: string;
  text?: string;
  ts: string;
  channel: string;
  event_ts: string;
  thread_ts?: string;
  files?: SlackFile[];
  file_id?: string;
  bot_id?: string;
}

export interface SlackFile {
  id: string;
  name: string;
  mimetype: string;
  filetype: string;
  url_private: string;
  size: number;
  user: string;
  permalink: string;
  is_public: boolean;
}

// Job Types
export interface ProcessingJob {
  id: string;
  fileIds?: string[];
  text?: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  user: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: Date;
  updatedAt: Date;
}

// Cloud Run Callback Types
export interface CloudRunCallback {
  jobId: string;
  status: 'success' | 'failure';
  transcriptUrl?: string;
  error?: string;
}

// Notion Types
export interface NotionPage {
  id: string;
  url: string;
  title: string;
} 