import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    /** Helps when `localhost` fails or you need the LAN URL on Windows. */
    host: true,
    port: 5173,
    strictPort: false,
    open: true,
  },
})
