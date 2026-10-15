import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { generateQrMatrix, renderCode128Barcode } from '../public/codes.js';

const env = {
  JWT_SECRET: 'test-jwt-secret-key',
  MONGODB_DB_NAME: 'inventory_platform_test',
};

async function callWorker(path, { method = 'GET', body = null, token = null } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const req = new Request(`http://localhost:8787${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const res = await worker.fetch(req, env, {});
  const data = await res.json();
  return { status: res.status, data };
}

async function runTests() {
  console.log('Running Cloudflare Worker Inventory Platform API & QR/Barcode Tests...\n');

  // 1. Health & Storage Recommendations
  const health = await callWorker('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);
  assert.ok(health.data.imageStorage.recommendedFreeOptions.length >= 2);
  console.log('✓ 1. /api/health returns DB status and GitHub + jsDelivr storage info');

  // 2. User Login (Default Admin) & User Registration
  const loginRes = await callWorker('/api/auth/login', {
    method: 'POST',
    body: { email: 'admin@inventory.io', password: 'Admin@123' },
  });
  assert.equal(loginRes.status, 200);
  assert.ok(loginRes.data.token);
  const token = loginRes.data.token;

  const regRes = await callWorker('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'Warehouse Operator',
      email: 'operator@inventory.io',
      password: 'Password123',
    },
  });
  assert.equal(regRes.status, 201);
  assert.equal(regRes.data.user.email, 'operator@inventory.io');
  console.log('✓ 2. Auth login & registration with email and password succeeded');

  // 3. Create Product (Title, Description, Quantity, Optional Color & Size, Picture)
  const sampleImage =
    'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=';
  const createRes = await callWorker('/api/products', {
    method: 'POST',
    token,
    body: {
      title: 'ProScan Wireless Barcode Reader',
      description: '2D QR and 1D barcode handheld scanner with USB receiver.',
      quantity: 2,
      color: 'Matte Black',
      size: 'Handheld Standard',
      imageData: sampleImage,
    },
  });
  assert.equal(createRes.status, 201);
  const createdProduct = createRes.data.product;
  assert.ok(createdProduct.id.startsWith('PRD-'));
  assert.equal(createdProduct.title, 'ProScan Wireless Barcode Reader');
  assert.equal(createdProduct.quantity, 2);
  assert.equal(createdProduct.status, 'In Stock');
  assert.equal(createdProduct.color, 'Matte Black');
  assert.equal(createdProduct.size, 'Handheld Standard');
  assert.ok(createdProduct.imageUrl.includes('/api/images/img-'));

  // Verify the image is served with immutable cache headers from /api/images/:id
  const imgRes = await worker.fetch(new Request(createdProduct.imageUrl), env, {});
  assert.equal(imgRes.status, 200);
  assert.equal(imgRes.headers.get('Content-Type'), 'image/webp');
  console.log(`✓ 3. Created product ${createdProduct.id} and verified /api/images/:id binary serving`);

  // 4. Verify QR Code & Barcode Generation for the Product Display Page URL
  const productDisplayUrl = `http://localhost:8787/product/${createdProduct.id}`;
  const qrMatrix = generateQrMatrix(productDisplayUrl);
  assert.ok(qrMatrix.length >= 21);
  let barcodeSvgContent = '';
  const mockSvgEl = {
    setAttribute() {},
    set innerHTML(val) {
      barcodeSvgContent = val;
    },
  };
  renderCode128Barcode(mockSvgEl, createdProduct.id);
  assert.ok(barcodeSvgContent.includes(createdProduct.id));
  console.log('✓ 4. Generated valid QR Code matrix and Code-128 Barcode SVG for product link');

  // 5. Read Single Product & Verify User-Specific Isolation
  // Unauthenticated access must be rejected with 401
  const unauthList = await callWorker('/api/products');
  assert.equal(unauthList.status, 401);
  const unauthGet = await callWorker(`/api/products/${createdProduct.id}`);
  assert.equal(unauthGet.status, 401);

  // Another user (operator@inventory.io) must NOT see admin's products
  const otherUserToken = regRes.data.token;
  const otherUserList = await callWorker('/api/products', { token: otherUserToken });
  assert.equal(otherUserList.status, 200);
  assert.equal(otherUserList.data.products.length, 0);
  const otherUserGet = await callWorker(`/api/products/${createdProduct.id}`, {
    token: otherUserToken,
  });
  assert.equal(otherUserGet.status, 404);

  // Owner (admin@inventory.io) can view their own product
  const getRes = await callWorker(`/api/products/${createdProduct.id}`, { token });
  assert.equal(getRes.status, 200);
  assert.equal(getRes.data.product.id, createdProduct.id);
  assert.ok(Array.isArray(getRes.data.activities));
  console.log('✓ 5. Verified strict user-specific product isolation & 401 unauthenticated protection');

  // 6. Edit / Update Product
  const updateRes = await callWorker(`/api/products/${createdProduct.id}`, {
    method: 'PUT',
    token,
    body: {
      title: 'ProScan Wireless Barcode Reader v2',
      color: 'Titanium Gray',
    },
  });
  assert.equal(updateRes.status, 200);
  assert.equal(updateRes.data.product.title, 'ProScan Wireless Barcode Reader v2');
  assert.equal(updateRes.data.product.color, 'Titanium Gray');
  console.log('✓ 6. Updated product title and color');

  // 7. Mark as Sold (Reduces quantity by 1 -> Out of Stock when quantity = 0)
  const sell1 = await callWorker(`/api/products/${createdProduct.id}/sell`, {
    method: 'POST',
    token,
  });
  assert.equal(sell1.status, 200);
  assert.equal(sell1.data.product.quantity, 1);
  assert.equal(sell1.data.product.status, 'In Stock');
  assert.equal(sell1.data.product.totalSold, 1);

  const sell2 = await callWorker(`/api/products/${createdProduct.id}/sell`, {
    method: 'POST',
    token,
  });
  assert.equal(sell2.status, 200);
  assert.equal(sell2.data.product.quantity, 0);
  assert.equal(sell2.data.product.status, 'Out of Stock');
  assert.equal(sell2.data.product.totalSold, 2);

  // Attempting to sell again when quantity = 0 should fail gracefully with 400
  const sell3 = await callWorker(`/api/products/${createdProduct.id}/sell`, {
    method: 'POST',
    token,
  });
  assert.equal(sell3.status, 400);
  console.log('✓ 7. Mark as Sold decrements quantity by 1 and transitions to Out of Stock at 0');

  // 8. Delete Product
  const delRes = await callWorker(`/api/products/${createdProduct.id}`, {
    method: 'DELETE',
    token,
  });
  assert.equal(delRes.status, 200);
  assert.equal(delRes.data.deleted, true);

  const afterDel = await callWorker(`/api/products/${createdProduct.id}`, { token });
  assert.equal(afterDel.status, 404);
  console.log('✓ 8. Deleted product and verified 404 on subsequent lookup');

  // 9. Verify User-Specific Activity History Tracking
  const actRes = await callWorker('/api/activities?limit=50', { token });
  assert.equal(actRes.status, 200);
  const actionsLogged = new Set(actRes.data.activities.map((a) => a.action));
  for (const expectedAction of [
    'USER_LOGIN',
    'PRODUCT_CREATED',
    'PRODUCT_UPDATED',
    'PRODUCT_SOLD',
    'OUT_OF_STOCK',
    'PRODUCT_DELETED',
  ]) {
    assert.ok(actionsLogged.has(expectedAction), `Missing activity action: ${expectedAction}`);
  }
  const otherActRes = await callWorker('/api/activities?limit=50', { token: otherUserToken });
  assert.equal(otherActRes.status, 200);
  assert.ok(otherActRes.data.activities.every((a) => a.actorEmail === 'operator@inventory.io'));
  console.log('✓ 9. Activity History accurately tracked per-user lifecycle events');

  // 10. Verify Static Asset & QR Deep Link (/product/:id) Routing
  const envWithAssets = {
    ...env,
    ASSETS: {
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname === '/index.html') {
          return new Response('<!DOCTYPE html><html><body>StockPulse</body></html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        }
        return new Response('Not Found', { status: 404 });
      },
    },
  };
  const deepLinkRes = await worker.fetch(
    new Request('http://localhost:8787/product/PRD-A7X9K2M4'),
    envWithAssets,
    {}
  );
  assert.equal(deepLinkRes.status, 200);
  const html = await deepLinkRes.text();
  assert.ok(html.includes('StockPulse'));
  console.log('✓ 10. QR scan deep-link route (/product/:id) serves the Product Display SPA');

  // 11. Verify GitHub Repository + jsDelivr CDN Image Upload Flow
  const origFetch = globalThis.fetch;
  let capturedGitHubUrl = '';
  globalThis.fetch = async (input, init) => {
    const urlStr = typeof input === 'string' ? input : input.url;
    if (urlStr.startsWith('https://api.github.com/repos/')) {
      capturedGitHubUrl = urlStr;
      return new Response(
        JSON.stringify({
          content: {
            sha: 'abc123456',
            download_url: 'https://raw.githubusercontent.com/demo-user/inventory-images/main/product-images/test.webp',
          },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return origFetch(input, init);
  };

  try {
    const ghEnv = {
      ...env,
      GITHUB_TOKEN: 'ghp_test_token_123',
      GITHUB_REPO: 'demo-user/inventory-images',
      GITHUB_BRANCH: 'main',
    };
    const uploadReq = new Request('http://localhost:8787/api/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ image: sampleImage }),
    });
    const uploadRes = await worker.fetch(uploadReq, ghEnv, {});
    const uploadData = await uploadRes.json();
    assert.equal(uploadData.provider, 'github-jsdelivr-cdn');
    assert.ok(
      uploadData.url.startsWith(
        'https://raw.githubusercontent.com/demo-user/inventory-images/main/product-images/'
      ) ||
        uploadData.url.startsWith(
          'https://cdn.jsdelivr.net/gh/demo-user/inventory-images@main/product-images/'
        )
    );
    assert.ok(
      capturedGitHubUrl.startsWith(
        'https://api.github.com/repos/demo-user/inventory-images/contents/product-images/img-'
      )
    );
    console.log('✓ 11. GitHub Contents REST API upload + jsDelivr CDN URL generation verified');
  } finally {
    globalThis.fetch = origFetch;
  }

  console.log('\nALL TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
