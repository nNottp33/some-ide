import { defineConfig } from "vite";
export default defineConfig({
  build: { target: "es2022", sourcemap: false, reportCompressedSize: true },
  server: { host: true, port: 5173, strictPort: true },
});
