// ダイナミックインポートで@vercel/kvを使用
// これによりビルド時の問題を回避
let kvClient: any = null;

// KVクライアントを非同期に初期化
async function initKvClient() {
  if (kvClient) return kvClient;
  
  try {
    const { kv } = await import('@vercel/kv');
    kvClient = kv;
    console.log('KVクライアント初期化成功');
    return kvClient;
  } catch (error) {
    console.error('KVクライアント初期化失敗:', error);
    return null;
  }
}

// メモリ内フォールバック用のマップ
const memoryFallbackStore = new Map<string, number>();

/**
 * 処理済みイベントを管理するためのクラス
 * Vercel KVを使用して永続的にイベントを記録します
 * KVが利用できない場合はメモリ内フォールバックを使用
 */
export class EventProcessor {
  // イベントの保存期間（秒単位、デフォルト24時間）
  private readonly TTL = 60 * 60 * 24;
  // メモリキャッシュの有効期限（ミリ秒）
  private readonly MEMORY_EXPIRY_MS = 60 * 60 * 1000; // 1時間
  
  /**
   * メモリ内フォールバックストアをクリーンアップ
   */
  private cleanupMemoryStore(): void {
    const now = Date.now();
    for (const [key, timestamp] of memoryFallbackStore.entries()) {
      if (now - timestamp > this.MEMORY_EXPIRY_MS) {
        memoryFallbackStore.delete(key);
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
      // まずKVにアクセスを試みる
      const kv = await initKvClient();
      if (kv) {
        try {
          // KVにイベントが存在するか確認
          const exists = await kv.exists(`event:${eventHash}`);
          
          // 存在しない場合は新しく記録
          if (!exists) {
            await kv.set(`event:${eventHash}`, Date.now(), { ex: this.TTL });
            console.log(`KVにイベント記録: ${eventHash}`);
            return false;
          }
          
          console.log(`KVで重複イベント検出: ${eventHash}`);
          return true;
        } catch (kvError) {
          console.error('KVアクセスエラー、メモリフォールバックを使用:', kvError);
          // KVアクセス失敗時はメモリフォールバックに移行
        }
      } else {
        console.log('KVクライアントが未定義、メモリフォールバックを使用');
      }
      
      // メモリ内フォールバックストアを使用
      this.cleanupMemoryStore();
      
      const memoryKey = `event:${eventHash}`;
      if (memoryFallbackStore.has(memoryKey)) {
        console.log(`メモリで重複イベント検出: ${eventHash}`);
        return true;
      }
      
      // メモリに記録
      memoryFallbackStore.set(memoryKey, Date.now());
      console.log(`メモリにイベント記録: ${eventHash}`);
      return false;
    } catch (error) {
      console.error('重複チェックエラー:', error);
      // エラーが発生した場合は安全策として未処理として扱う
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
      // まずKVにアクセスを試みる
      const kv = await initKvClient();
      if (kv) {
        try {
          // KVにメッセージが存在するか確認
          const exists = await kv.exists(`message:${messageKey}`);
          
          // 存在しない場合は新しく記録
          if (!exists) {
            await kv.set(`message:${messageKey}`, Date.now(), { ex: this.TTL });
            console.log(`KVにメッセージ記録: ${messageKey}`);
            return false;
          }
          
          console.log(`KVで重複メッセージ検出: ${messageKey}`);
          return true;
        } catch (kvError) {
          console.error('KVアクセスエラー、メモリフォールバックを使用:', kvError);
          // KVアクセス失敗時はメモリフォールバックに移行
        }
      } else {
        console.log('KVクライアントが未定義、メモリフォールバックを使用');
      }
      
      // メモリ内フォールバックストアを使用
      this.cleanupMemoryStore();
      
      const memoryKey = `message:${messageKey}`;
      if (memoryFallbackStore.has(memoryKey)) {
        console.log(`メモリで重複メッセージ検出: ${messageKey}`);
        return true;
      }
      
      // メモリに記録
      memoryFallbackStore.set(memoryKey, Date.now());
      console.log(`メモリにメッセージ記録: ${messageKey}`);
      return false;
    } catch (error) {
      console.error('メッセージ重複チェックエラー:', error);
      // エラーが発生した場合は安全策として未送信として扱う
      return false;
    }
  }
  
  /**
   * KVに保存されたすべてのイベントをクリア（テスト用）
   */
  async clearAllEvents(): Promise<void> {
    try {
      const kv = await initKvClient();
      if (kv) {
        // すべてのイベントキーを取得
        const keys = await kv.keys('event:*');
        
        // キーが存在する場合は削除
        if (keys.length > 0) {
          await kv.del(...keys);
          console.log(`${keys.length}件のイベントをクリアしました`);
        }
      }
      
      // メモリ内フォールバックもクリア
      memoryFallbackStore.clear();
      console.log('メモリ内フォールバックをクリアしました');
    } catch (error) {
      console.error('イベントクリアエラー:', error);
    }
  }
} 