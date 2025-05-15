import { logger } from '@app/lib/utils/logger';

/**
 * GCSからJSONデータを取得する汎用関数
 */
export async function fetchJsonFromUrl(url: string) {
  try {
    const response = await fetch(url);
    
    if (!response.ok) {
      logger.error(`Failed to fetch data from ${url}: ${response.statusText}`);
      return null;
    }
    
    return await response.json();
  } catch (error) {
    logger.error(`Error fetching data from ${url}: ${error}`);
    return null;
  }
}

/**
 * Cloud Storageから文字起こしデータを取得する
 */
export async function fetchTranscriptData(url: string) {
  try {
    // Public URLからJSONデータを取得
    const data = await fetchJsonFromUrl(url);
    
    if (!data || !data.transcript) {
      logger.error(`Invalid transcript data from ${url}`);
      return null;
    }
    
    return data;
  } catch (error) {
    logger.error(`Error fetching transcript data: ${error}`);
    return null;
  }
} 