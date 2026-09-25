import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const port = Number(env.CODEWALK_VIEWER_PORT) || 4173;
  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port,
      // A busy port must fail loudly rather than silently moving to the next
      // one: the SSE origin allowlist is keyed on this exact port.
      strictPort: true,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:4180',
          configure(proxy) {
            proxy.on('proxyReq', (proxyRequest, request) => {
              if (request.url?.startsWith('/api/activity/') && env.CODEWALK_ACTIVITY_TOKEN) {
                proxyRequest.setHeader('X-Codewalk-Activity-Token', env.CODEWALK_ACTIVITY_TOKEN);
              }
            });
          },
        },
      },
    },
  };
});
