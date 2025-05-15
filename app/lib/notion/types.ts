/**
 * 会議レコードの入力データ型
 */
export interface MeetingInput {
  // 基本情報
  jobId: string;
  title: string;
  date: string;
  transcript: string;
  summary: string;
  
  // 詳細情報
  participants: string[];
  decisions: string[];
  tasks: MeetingTask[];
  
  // メタデータ
  metadata?: {
    channel?: string;
    ts?: string;
    thread_ts?: string;
    videoUrl?: string;
    audioUrl?: string;
    [key: string]: any;
  };
}

/**
 * 会議で決定されたタスク
 */
export interface MeetingTask {
  task: string;
  assignee?: string;
  deadline?: string;
}

/**
 * 会議レコードの出力データ型（Notionに保存後）
 */
export interface MeetingRecord {
  id: string;
  url: string;
  title: string;
  date: string;
  summary: string;
}

/**
 * Notionプロパティタイプのヘルパー型
 */
export type NotionPropertyValue = {
  title?: { text: { content: string } }[];
  rich_text?: { text: { content: string } }[];
  date?: { start: string };
  multi_select?: { name: string }[];
  url?: string;
};

/**
 * Notion API テキスト型定義
 */
export type NotionText = {
  type: "text";
  text: {
    content: string;
    link?: { url: string } | null;
  };
  annotations?: {
    bold?: boolean;
    italic?: boolean;
    strikethrough?: boolean;
    underline?: boolean;
    code?: boolean;
    color?: string;
  };
  plain_text?: string;
  href?: string | null;
};

/**
 * Notion API リッチテキスト型定義
 */
export type NotionRichText = NotionText[];

/**
 * Notion APIブロック型定義
 */
export type NotionBlock = {
  object: "block";
  type: string;
  [key: string]: any;
};

/**
 * Notion API 段落ブロック型定義
 */
export type NotionParagraphBlock = {
  object: "block";
  type: "paragraph";
  paragraph: {
    rich_text: NotionRichText;
    color?: string;
  };
};

/**
 * Notion API 見出し1ブロック型定義
 */
export type NotionHeading1Block = {
  object: "block";
  type: "heading_1";
  heading_1: {
    rich_text: NotionRichText;
    color?: string;
    is_toggleable?: boolean;
  };
};

/**
 * Notion API 見出し2ブロック型定義
 */
export type NotionHeading2Block = {
  object: "block";
  type: "heading_2";
  heading_2: {
    rich_text: NotionRichText;
    color?: string;
    is_toggleable?: boolean;
  };
};

/**
 * Notion API 見出し3ブロック型定義
 */
export type NotionHeading3Block = {
  object: "block";
  type: "heading_3";
  heading_3: {
    rich_text: NotionRichText;
    color?: string;
    is_toggleable?: boolean;
  };
};

/**
 * Notion API 見出しブロック型定義の統合型
 */
export type NotionHeadingBlock = NotionHeading1Block | NotionHeading2Block | NotionHeading3Block;

/**
 * Notion API コードブロック型定義
 */
export type NotionCodeBlock = {
  object: "block";
  type: "code";
  code: {
    rich_text: NotionRichText;
    language: string;
    caption?: NotionRichText;
  };
}; 