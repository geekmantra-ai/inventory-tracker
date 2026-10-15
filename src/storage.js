// GitHub Repository + jsDelivr CDN Product Image Storage for Cloudflare Workers
//
// Primary Storage: GitHub Contents REST API + jsDelivr Global CDN (`GITHUB_TOKEN` + `GITHUB_REPO`)
// - 100% Free, No Credit Card Required
// - Uploads compressed WebP product photos directly to your GitHub repo (`product-images/<id>.webp`)
// - Delivers images globally via `https://cdn.jsdelivr.net/gh/<owner>/<repo>@<branch>/product-images/<id>.webp`
// - Also supports private GitHub repos via `/api/images/gh-<id>` Worker proxy
// - Automatic fallback to Cloud MongoDB `product_images` collection when `GITHUB_TOKEN` is not yet configured

import { saveImageRecord, getImageRecord } from './db.js';

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToUint8Array(base64) {
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes;
}

export function getActiveStorageProvider(env = {}) {
  if (env.GITHUB_TOKEN && env.GITHUB_REPO) {
    return 'github-jsdelivr-cdn';
  }
  return 'mongodb-edge-cached';
}

async function uploadToGitHubRepo({ imageId, base64Data }, env, originUrl) {
  const repo = String(env.GITHUB_REPO).trim().replace(/^\/+|\/+$/g, '');
  const branch = String(env.GITHUB_BRANCH || 'main').trim();
  const folder = String(env.GITHUB_IMAGE_PATH || 'product-images').trim().replace(/^\/+|\/+$/g, '');
  const filePath = `${folder}/${imageId}`;

  const apiUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`;
  const ghRes = await fetch(apiUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN.trim()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'StockPulse-Cloudflare-Worker',
    },
    body: JSON.stringify({
      message: `chore(inventory): upload product image ${imageId}`,
      content: base64Data,
      branch,
    }),
  });

  if (!ghRes.ok) {
    const errText = await ghRes.text();
    throw new Error(`GitHub API upload failed (${ghRes.status}): ${errText}`);
  }

  const ghData = await ghRes.json();
  const isPrivateProxy = String(env.GITHUB_REPO_PRIVATE || '').toLowerCase() === 'true';

  const rawUrl =
    ghData?.content?.download_url ||
    `https://raw.githubusercontent.com/${repo}/${branch}/${filePath}`;

  // For public repos, raw.githubusercontent.com works instantly without jsDelivr sync lag.
  // We also trigger jsDelivr cache purge in the background so both URLs work.
  const cdnUrl = isPrivateProxy
    ? `${originUrl ? originUrl : ''}/api/images/gh-${imageId}`
    : rawUrl;

  if (!isPrivateProxy) {
    try {
      fetch(`https://purge.jsdelivr.net/gh/${repo}@${branch}/${filePath}`).catch(() => {});
    } catch {}
  }

  return {
    url: cdnUrl,
    rawUrl,
    sha: ghData?.content?.sha || null,
    provider: 'github-jsdelivr-cdn',
    key: filePath,
  };
}

export async function uploadProductImage(fileOrDataUrl, env = {}, originUrl = '') {
  const provider = getActiveStorageProvider(env);

  // Pass through external HTTP(S) URLs directly
  if (
    typeof fileOrDataUrl === 'string' &&
    (fileOrDataUrl.startsWith('http://') || fileOrDataUrl.startsWith('https://'))
  ) {
    return {
      url: fileOrDataUrl.trim(),
      provider: 'external-url',
    };
  }

  let contentType = 'image/webp';
  let base64Data = '';

  if (typeof fileOrDataUrl === 'string' && fileOrDataUrl.startsWith('data:image/')) {
    const matches = fileOrDataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (matches) {
      contentType = matches[1];
      base64Data = matches[2];
    }
  } else if (fileOrDataUrl && typeof fileOrDataUrl.arrayBuffer === 'function') {
    const buffer = await fileOrDataUrl.arrayBuffer();
    contentType = fileOrDataUrl.type || 'image/webp';
    base64Data = arrayBufferToBase64(buffer);
  }

  if (!base64Data) {
    return { url: '', provider: 'none' };
  }

  const ext = (contentType.split('/')[1] || 'webp').replace(/[^a-z0-9]/gi, '');
  const imageId = `img-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;

  // 1. Primary: GitHub Repository + jsDelivr CDN (`GITHUB_TOKEN` + `GITHUB_REPO`)
  if (provider === 'github-jsdelivr-cdn') {
    return await uploadToGitHubRepo({ imageId, base64Data }, env, originUrl);
  }

  // 2. Fallback when GITHUB_TOKEN / GITHUB_REPO is not yet configured:
  // Store in Cloud MongoDB `product_images` collection and serve via `/api/images/:id`
  await saveImageRecord(env, {
    id: imageId,
    contentType,
    base64Data,
  });

  return {
    url: `${originUrl ? `${originUrl}` : ''}/api/images/${imageId}`,
    provider: 'mongodb-edge-cached',
    key: imageId,
  };
}

export async function serveStoredImage(imageId, env = {}) {
  // 1. Serve from GitHub repo if requested via `/api/images/gh-<imageId>` (e.g. for private repos)
  if (imageId.startsWith('gh-') && env.GITHUB_TOKEN && env.GITHUB_REPO) {
    const rawFile = imageId.slice(3);
    const repo = String(env.GITHUB_REPO).trim().replace(/^\/+|\/+$/g, '');
    const branch = String(env.GITHUB_BRANCH || 'main').trim();
    const folder = String(env.GITHUB_IMAGE_PATH || 'product-images').trim().replace(/^\/+|\/+$/g, '');
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${folder}/${rawFile}?ref=${encodeURIComponent(branch)}`;

    const ghRes = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN.trim()}`,
        Accept: 'application/vnd.github.raw+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'StockPulse-Cloudflare-Worker',
      },
    });

    if (ghRes.ok) {
      return new Response(ghRes.body, {
        status: 200,
        headers: {
          'Content-Type': rawFile.endsWith('.png')
            ? 'image/png'
            : rawFile.endsWith('.jpg') || rawFile.endsWith('.jpeg')
            ? 'image/jpeg'
            : 'image/webp',
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    }
    return new Response('GitHub image not found', { status: 404 });
  }

  // 2. Serve from Cloud MongoDB `product_images` fallback collection
  const record = await getImageRecord(env, imageId);
  if (!record || !record.base64Data) {
    return new Response('Image not found', { status: 404 });
  }

  const bytes = base64ToUint8Array(record.base64Data);
  return new Response(bytes.buffer, {
    status: 200,
    headers: {
      'Content-Type': record.contentType || 'image/webp',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
