# Dagitoru - Slack会議録自動記録システム

SlackのビデオやオーディオをNotion議事録に自動変換するアプリケーション「Dagitoru」です。

## セットアップ方法

### 必要な環境変数

`.env`ファイルに以下の環境変数を設定してください：

```
# Notion設定
NOTION_API_KEY=your_notion_api_key
NOTION_MEETINGS_DB_ID=your_notion_database_id

# Slack設定
SLACK_TOKEN=your_slack_bot_token
SLACK_SIGNING_SECRET=your_slack_signing_secret

# GCP設定
GCS_BUCKET_NAME=your_gcs_bucket_name
GCP_PROJECT_ID=your_gcp_project_id
PUBSUB_TOPIC=dagitoru-topic
PUBSUB_SUBSCRIPTION=dagitorusubscriptions

# Gemini API設定
GEMINI_API_KEY=your_gemini_api_key

# アプリケーションURL
NEXT_PUBLIC_BASE_URL=https://your-app-url.com
CALLBACK_URL=https://your-app-url.com/api/cloudrun/callback
```

### インストールと実行

```bash
# 依存関係のインストール
npm install

# 開発サーバーの起動
npm run dev

# プロダクションビルド
npm run build

# プロダクションサーバーの起動
npm run start
```

## Notionデータベースのセットアップ

### 新しいデータベースの作成

1. 依存パッケージをインストール
   ```bash
   npm install
   ```

2. 親ページIDを取得
   - Notionで、データベースを作成したいページを開きます。
   - URLから親ページIDを取得します（例: `https://www.notion.so/yourworkspace/abcdef123456789...`の`abcdef123456789...`部分）

3. 新しいデータベースを作成
   ```bash
   npx ts-node scripts/setup-notion-db.ts create <親ページID> "デジトル面談履歴テスト開発"
   ```

4. 表示された指示に従って、`.env`ファイルにデータベースIDを追加します。

### 既存のデータベーススキーマの更新

既存のデータベースのスキーマを更新するには：

```bash
npx ts-node scripts/setup-notion-db.ts update
```

### スキーマ構成

データベースは以下の構成で設定されます：

- `会議名` (タイトル型) - データベースの主要タイトル
- その他のフィールドはすべてリッチテキスト型：
  - `日時`
  - `クライアント名`
  - `コンサルタント名`
  - `会議の基本情報`
  - `会議の目的とアジェンダ`
  - `会議の内容`
  - `今後のスケジュール`
  - `共有情報・添付`
  - `その他特記事項`
  - `ジョブID`

## 使用方法

1. Slackで会議の動画やオーディオファイルを共有します
2. Dagitoruボットが自動的にファイルを検出し、処理を開始します
3. 処理が完了すると、Notion議事録へのリンクがSlackに投稿されます

## 機能

- Slackからのメディア（動画、テキスト）受信
- 動画の音声抽出と文字起こし
- Gemini AIによる要約と議事録生成
- Notion DBへの議事録保存
- 処理状況のSlackへの通知

## 必要条件

- Node.js (v18以上)
- Slackアプリの設定
- Google Cloud Projectの設定
- Notionインテグレーションの設定

## インストール

```bash
# リポジトリのクローン
git clone <repository-url>
cd dagitoru-app

# 依存パッケージのインストール
npm install
```

## 環境変数の設定

`.env`ファイルを作成し、以下の環境変数を設定してください：

```
# アプリケーション設定
NEXT_PUBLIC_BASE_URL=http://localhost:3000

# Slack API設定
SLACK_BOT_TOKEN=xoxb-xxxxxxxxxx-xxxxxxxxxxxx-xxxxxxxxxxxxxxxx
SLACK_SIGNING_SECRET=xxxxxxxxxxxxxxxxxxxxxxx

# Google Cloud設定
GCP_PROJECT_ID=your-gcp-project-id
GCS_BUCKET_NAME=your-gcs-bucket-name
PUBSUB_TOPIC=video-processing-topic
GEMINI_API_KEY=your-gemini-api-key

# Notion設定
NOTION_API_KEY=secret_xxxxxxxxxxxxxxxx
NOTION_DATABASE_ID=xxxxxxxxxxxxxxxxxxxxxxx

# Cloud Run設定
CLOUD_RUN_JOB_SERVICE=video-processing-service
```

## 開発サーバーの起動

```bash
npm run dev
```

## APIエンドポイント

### Slack関連

- `POST /api/slack/events` - Slackイベント受信エンドポイント
- `POST /api/slack/file-handler` - ファイル処理エンドポイント
- `POST /api/slack/text-handler` - テキスト処理エンドポイント
- `POST /api/slack/combined-handler` - ファイル+テキスト処理エンドポイント

### Cloud Run関連

- `POST /api/cloudrun/callback` - Cloud Runからのコールバック受信

### Gemini AI関連

- `POST /api/gemini/summarize` - トランスクリプト要約エンドポイント
- `POST /api/gemini/analyze-text` - テキスト解析エンドポイント

### ジョブ管理

- `POST /api/jobs/retry/[jobId]` - 特定ジョブの再試行エンドポイント

## デプロイ

Vercelへのデプロイ:

```bash
vercel --prod
```

## Slack App設定

Slack Appの作成とイベント登録:

1. [Slack API](https://api.slack.com/apps)でアプリを作成
2. Event Subscriptions を有効化し、Request URLに `https://your-domain.com/api/slack/events` を設定
3. 以下のイベントをサブスクライブ:
   - `file_shared`
   - `message.channels`
   - `message.groups`
4. スコープの追加:
   - `files:read`
   - `chat:write`
   - `channels:history`
   - `groups:history`
   - `channels:read`
   - `groups:read`

## Cloud Run Job設定

Cloud Run Jobの構築とデプロイは別リポジトリを参照。

## ライセンス

MIT

## 貢献者

- Your Name
