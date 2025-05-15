/**
 * シンプルなロガーユーティリティ
 */
export const logger = {
  info: (message: string) => {
    console.log(`[INFO] ${new Date().toISOString()}: ${message}`);
  },
  
  warn: (message: string) => {
    console.warn(`[WARN] ${new Date().toISOString()}: ${message}`);
  },
  
  error: (message: string | Error) => {
    const errorMessage = message instanceof Error ? message.stack || message.message : message;
    console.error(`[ERROR] ${new Date().toISOString()}: ${errorMessage}`);
  },
  
  debug: (message: string, data?: any) => {
    if (process.env.NODE_ENV !== 'production') {
      console.debug(`[DEBUG] ${new Date().toISOString()}: ${message}`);
      if (data) {
        console.debug(data);
      }
    }
  }
}; 