import { kv } from '@vercel/kv';

/**
 * 処理済みイベントを管理するためのクラス
 * Vercel KVを使用して永続的にイベントを記録します
 */
export class EventProcessor {
  // イベントの保存期間（秒単位、デフォルト24時間）
  private readonly TTL = 60 * 60 * 24;
  
  /**
   * イベントが既に処理済みかどうかを確認し、未処理の場合は処理済みとしてマーク
   * @param eventHash 処理対象イベントのハッシュ値
   * @returns 処理済みの場合はtrue、未処理だった場合はfalse
   */
  async isProcessedOrMark(eventHash: string): Promise<boolean> {
    try {
      // KVにイベントが存在するか確認
      const exists = await kv.exists(`event:${eventHash}`);
      
      // 存在しない場合は新しく記録
      if (!exists) {
        await kv.set(`event:${eventHash}`, Date.now(), { ex: this.TTL });
        console.log(`イベント記録: ${eventHash}`);
        return false;
      }
      
      console.log(`重複イベント検出: ${eventHash}`);
      return true;
    } catch (error) {
      // KVへのアクセスに失敗した場合はエラーをログに記録
      console.error('KVアクセスエラー:', error);
      // エラー時は安全策として未処理として扱う（false）
      return false;
    }
  }
  
  /**
   * メッセージが既に送信済みかどうかを確認し、未送信の場合は送信済みとしてマーク
   * @param messageKey メッセージの一意キー
   * @returns 送信済みの場合はtrue、未送信だった場合はfalse
   */
  async isMessageSentOrMark(messageKey: string): Promise<boolean> {
    try {
      // KVにメッセージが存在するか確認
      const exists = await kv.exists(`message:${messageKey}`);
      
      // 存在しない場合は新しく記録
      if (!exists) {
        await kv.set(`message:${messageKey}`, Date.now(), { ex: this.TTL });
        console.log(`メッセージ記録: ${messageKey}`);
        return false;
      }
      
      console.log(`重複メッセージ検出: ${messageKey}`);
      return true;
    } catch (error) {
      // KVへのアクセスに失敗した場合はエラーをログに記録
      console.error('KVアクセスエラー:', error);
      // エラー時は安全策として未送信として扱う（false）
      return false;
    }
  }
  
  /**
   * KVに保存されたすべてのイベントをクリア（テスト用）
   */
  async clearAllEvents(): Promise<void> {
    try {
      // すべてのイベントキーを取得
      const keys = await kv.keys('event:*');
      
      // キーが存在する場合は削除
      if (keys.length > 0) {
        await kv.del(...keys);
        console.log(`${keys.length}件のイベントをクリアしました`);
      }
    } catch (error) {
      console.error('イベントクリアエラー:', error);
    }
  }
} 