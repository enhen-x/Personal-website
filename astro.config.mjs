import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import sitemap from '@astrojs/sitemap';
import { loadEnv } from 'vite';
import { GET as quantProxyGet } from './api/quant.js';

function quantApiDevProxy() {
  return {
    name: 'quant-api-dev-proxy',
    configureServer(server) {
      const initialShellBase = process.env.QUANT_API_BASE;
      const initialShellToken = process.env.QUANT_API_TOKEN;

      server.middlewares.use(async (req, res, next) => {
        const rawUrl = req.url || '';
        const reqUrl = new URL(rawUrl, 'http://127.0.0.1');
        if (reqUrl.pathname !== '/api/quant') {
          return next();
        }

        if ((req.method || 'GET').toUpperCase() !== 'GET') {
          res.statusCode = 405;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'Method Not Allowed', code: 'METHOD_NOT_ALLOWED' }));
          return;
        }

        try {
          const fileEnv = loadEnv('', process.cwd(), '');
          process.env.QUANT_API_BASE = (initialShellBase ?? fileEnv.QUANT_API_BASE ?? 'http://127.0.0.1:8000').trim();
          process.env.QUANT_API_TOKEN = (initialShellToken ?? fileEnv.QUANT_API_TOKEN ?? '').trim();

          const webRequest = new Request(reqUrl.toString(), { method: 'GET' });
          const webResponse = await quantProxyGet(webRequest);

          res.statusCode = webResponse.status;
          webResponse.headers.forEach((value, key) => {
            res.setHeader(key, value);
          });
          const bodyBuffer = Buffer.from(await webResponse.arrayBuffer());
          res.end(bodyBuffer);
        } catch (err) {
          console.error('[dev-proxy /api/quant] unexpected error:', err);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: '本地开发代理异常', code: 'DEV_PROXY_ERROR' }));
        }
      });
    },
  };
}

export default defineConfig({
  site: 'https://schelling.org.cn',
  integrations: [tailwind(), sitemap()],
  build: {
    inlineStylesheets: 'always',
  },
  vite: {
    plugins: [quantApiDevProxy()],
  },
});
