import { defineConfig } from 'vitest/config';

// コンテナ内では node_modules が読み取り専用なので、キャッシュの置き場を環境変数で /tmp に逃がす
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

/**
 * 画面に小さく出す版の目印。ビルドした日時（日本時間）と、コミットの短い ID（CI が渡す GITHUB_SHA。手元のビルドでは local）。
 * 公開ページが新しい版に切り替わったかを、見て分かるようにする
 */
function appVersion(): string {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString();
  const stamp = `${jst.slice(5, 7)}/${jst.slice(8, 10)} ${jst.slice(11, 16)}`;
  return `${stamp} ${(env.GITHUB_SHA ?? 'local').slice(0, 7)}`;
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  // GitHub Pages などのサブパスにそのまま置けるようにする（仕様書 1 章）
  base: './',
  cacheDir: env.VITE_CACHE_DIR,
  build: { target: 'es2022' },
  server: {
    // Windows のバインドマウントではファイル変更の通知が届かないので、コンテナ内ではポーリングする
    watch: env.VITE_POLL ? { usePolling: true, interval: 300 } : undefined,
  },
  test: { include: ['tests/**/*.test.ts'] },
});
