import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(moduleId) {
          if (moduleId.includes("/node_modules/three/")) {
            return "three";
          }

          return undefined;
        },
      },
    },
  },
});
