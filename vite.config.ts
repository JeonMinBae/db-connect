/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import process from "node:process";
import { fileURLToPath } from "node:url";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(() => ({
  plugins: [react()],
  resolve: {
    // 쓰지 않는 Glide 셀 종류의 의존성을 빈 구현으로 바꿔 번들을 줄인다
    alias: {
      marked: fileURLToPath(new URL("./src/stubs/glide-unused.ts", import.meta.url)),
      "react-responsive-carousel": fileURLToPath(new URL("./src/stubs/glide-unused.ts", import.meta.url)),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  // 테스트도 위 alias를 쓰도록 Glide를 번들에 포함해 처리한다
  test: { include: ["src/**/*.test.ts"], server: { deps: { inline: [/glide-data-grid/] } } },
}));
