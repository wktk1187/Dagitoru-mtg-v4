import { App } from 'firebase-admin/app';

declare global {
  // eslint-disable-next-line no-var
  var _firebaseApp: App | undefined;
}

// このファイルはTypeScriptにグローバル変数の型を教えるためのものです。
// export {} は不要、またはつける場合はモジュールとして扱われますが、
// グローバル型拡張の場合は通常つけません。 