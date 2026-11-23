import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 開発中は /ws をサーバー（pnpm dev:server、ポート8787）へ中継する
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
  },
});
