import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    // Bind IPv4 loopback explicitly: on Windows, Node resolves localhost to
    // ::1 first, so Vite otherwise listens on IPv6 only while Electron
    // connects to 127.0.0.1 and gets ERR_CONNECTION_REFUSED.
    host: '127.0.0.1',
  },
  build: {
    sourcemap: false,
  },
});
