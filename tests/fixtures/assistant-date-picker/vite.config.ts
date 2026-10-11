import { fileURLToPath } from "node:url";

const config = {
  root: fileURLToPath(new URL(".", import.meta.url)),
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: { "@": fileURLToPath(new URL("../../../src", import.meta.url)) },
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL("../../../", import.meta.url))] },
  },
};

export default config;
