// ビルドした版の目印（ビルドした日時と、コミットの短い ID）。公開ページが新しい版に切り替わったかを、画面で見分けるために出す。
// 値は vite.config.ts がビルドのときに埋め込む
declare const __APP_VERSION__: string | undefined;

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
