// メモリ内キャッシュ用のマップ
const memoryStore = new Map<string, number>();

/**
 * 処理済みイベントを管理するためのクラス
 * メモリ内キャッシュを使って重複を防止します
 */
export class EventProcessor {
  // メモリキャッシュの有効期限（ミリ秒）
  private readonly MEMORY_EXPIRY_MS = 3600000; // 1時間
  
  /**
   * メモリ内キャッシュをクリーンアップ
   */
  private cleanupMemoryStore(): void {
    const now = Date.now();
    for (const [key, timestamp] of memoryStore.entries()) {
      if (now - timestamp > this.MEMORY_EXPIRY_MS) {
        memoryStore.delete(key);
      }
    }
  }
  
  /**
   * イベントが既に処理済みかどうかを確認し、未処理の場合は処理済みとしてマーク
   * @param eventHash 処理対象イベントのハッシュ値
   * @returns 処理済みの場合はtrue、未処理だった場合はfalse
   */
  async isProcessedOrMark(eventHash: string): Promise<boolean> {
    try {
      // キャッシュのクリーンアップ
      this.cleanupMemoryStore();
      
      // メモリ内キャッシュをチェック
      const key = `event:${eventHash}`;
      if (memoryStore.has(key)) {
        console.log(`メモリで重複イベント検出: ${eventHash}`);
        return true;
      }
      
      // 未処理の場合は記録
      memoryStore.set(key, Date.now());
      console.log(`メモリにイベント記録: ${eventHash}`);
      return false;
    } catch (error) {
      console.error('重複チェックエラー:', error);
      // エラー時は安全策として未処理として扱う
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
      // キャッシュのクリーンアップ
      this.cleanupMemoryStore();
      
      // メモリ内キャッシュをチェック
      const key = `message:${messageKey}`;
      if (memoryStore.has(key)) {
        console.log(`メモリで重複メッセージ検出: ${messageKey}`);
        return true;
      }
      
      // 未送信の場合は記録
      memoryStore.set(key, Date.now());
      console.log(`メモリにメッセージ記録: ${messageKey}`);
      return false;
    } catch (error) {
      console.error('メッセージ重複チェックエラー:', error);
      // エラー時は安全策として未送信として扱う
      return false;
    }
  }
  
  /**
   * メモリ内キャッシュをクリア（テスト用）
   */
  async clearAllEvents(): Promise<void> {
    try {
      memoryStore.clear();
      console.log('メモリ内キャッシュをクリアしました');
    } catch (error) {
      console.error('キャッシュクリアエラー:', error);
    }
  }
} 