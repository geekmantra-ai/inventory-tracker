// Local Node 20+ HTTP adapter for the Cloudflare Worker (`src/worker.js`)
// Allows running locally via `npm start` (`node src/local-server.js`) or `npx wrangler dev`
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import worker from './worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const DEV_VARS_PATH = path.resolve(__dirname, '../.dev.vars');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

async function loadDevVars() {
  const env = {
    MONGODB_URI: process.env.MONGODB_URI || '',
    MONGODB_DB_NAME: process.env.MONGODB_DB_NAME || 'inventory_platform',
    JWT_SECRET: process.env.JWT_SECRET || 'super-secret-inventory-jwt-key-2026',
    GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
    GITHUB_REPO: process.env.GITHUB_REPO || '',
    GITHUB_BRANCH: process.env.GITHUB_BRANCH || 'main',
    GITHUB_IMAGE_PATH: process.env.GITHUB_IMAGE_PATH || 'product-images',
    GITHUB_REPO_PRIVATE: process.env.GITHUB_REPO_PRIVATE || 'false',
  };

  try {
    const content = await fs.readFile(DEV_VARS_PATH, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (val) env[key] = val;
      }
    }
  } catch {
    // .dev.vars is optional
  }

  // Provide Cloudflare Workers ASSETS binding emulation for static files in ./public
  env.ASSETS = {
    async fetch(request) {
      const url = new URL(request.url);
      let reqPath = decodeURIComponent(url.pathname);
      if (reqPath === '/' || reqPath.startsWith('/product/')) {
        reqPath = '/index.html';
      }
      const safePath = path.normalize(reqPath).replace(/^(\.\.(\/|\\|$))+/, '');
      const fullPath = path.join(PUBLIC_DIR, safePath);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory()) {
          const indexContent = await fs.readFile(path.join(fullPath, 'index.html'));
          return new Response(indexContent, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
        const data = await fs.readFile(fullPath);
        const ext = path.extname(fullPath).toLowerCase();
        return new Response(data, {
          status: 200,
          headers: { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' },
        });
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    },
  };

  return env;
}

export async function startServer(port = Number(process.env.PORT) || 8787) {
  const env = await loadDevVars();

  const server = http.createServer(async (req, res) => {
    try {
      const protocol = req.headers['x-forwarded-proto'] || 'http';
      const host = req.headers.host || `localhost:${port}`;
      const fullUrl = `${protocol}://${host}${req.url}`;

      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const bodyBuffer = Buffer.concat(chunks);

      const webReq = new Request(fullUrl, {
        method: req.method,
        headers: req.headers,
        body:
          req.method !== 'GET' && req.method !== 'HEAD' && bodyBuffer.length > 0
            ? bodyBuffer
            : undefined,
      });

      const webRes = await worker.fetch(webReq, env, {});

      res.statusCode = webRes.status;
      webRes.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });

      const arrayBuffer = await webRes.arrayBuffer();
      res.end(Buffer.from(arrayBuffer));
    } catch (err) {
      console.error('Server error:', err);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`Inventory Management Worker running at http://localhost:${port}`);
      resolve(server);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}

