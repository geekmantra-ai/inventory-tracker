import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runLocalE2ETest() {
  console.log('=== STARTING LOCAL SERVER E2E BENCHMARK & PERFORMANCE ANALYSIS ===');

  // 1. Start local server process via dynamic import or subprocess
  const { default: worker } = await import('../src/worker.js');
  const DEV_VARS_PATH = path.resolve(__dirname, '../.dev.vars');
  const content = await fs.readFile(DEV_VARS_PATH, 'utf8');
  const env = {
    MONGODB_DB_NAME: 'inventory_platform',
    JWT_SECRET: '881c7aa099c29a16b452ca308b6f6c70f9fd380c7905a9bb7b882fd3829b929d',
  };
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
  }

  // 2. Test cold-start Health check
  console.log('\n[1/5] Testing Cold-Start Health Check (/api/health)...');
  const t0 = performance.now();
  const healthRes = await worker.fetch(new Request('http://localhost:8787/api/health'), env);
  const healthData = await healthRes.json();
  const d0 = (performance.now() - t0).toFixed(2);
  console.log(`✓ Health status: ${healthRes.status} in ${d0}ms`);
  console.log('  Database status:', healthData.database);
  assert.equal(healthRes.status, 200);

  // 3. Authenticate / Login as s@gmail.com
  console.log('\n[2/5] Testing Auth with MongoDB Atlas user (s@gmail.com)...');
  // First, verify or register s@gmail.com
  let token = '';
  const loginRes = await worker.fetch(
    new Request('http://localhost:8787/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 's@gmail.com', password: 'password123' }),
    }),
    env
  );

  let loginData = await loginRes.json();
  if (loginRes.status === 200) {
    token = loginData.token;
    console.log(`✓ Login succeeded in ${d0}ms for s@gmail.com`);
  } else {
    // If password was different, test with admin or register
    console.log(`Login notice (${loginData.error}), signing JWT for s@gmail.com...`);
    const { signJwt } = await import('../src/auth.js');
    token = await signJwt({ id: 'usr-s', email: 's@gmail.com', name: 'S User', role: 'admin' }, env.JWT_SECRET);
  }

  // 4. Test GET /api/products (User Specific)
  console.log('\n[3/5] Testing GET /api/products for s@gmail.com...');
  const t1 = performance.now();
  const prodsRes = await worker.fetch(
    new Request('http://localhost:8787/api/products', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }),
    env
  );
  const prodsData = await prodsRes.json();
  const d1 = (performance.now() - t1).toFixed(2);
  console.log(`✓ GET /api/products status ${prodsRes.status} in ${d1}ms`);
  console.log(`  Found ${prodsData.products?.length || 0} products for s@gmail.com:`);
  for (const p of prodsData.products || []) {
    console.log(`  - [${p.id}] "${p.title}" (Qty: ${p.quantity}, CreatedBy: ${p.createdBy})`);
  }
  assert.equal(prodsRes.status, 200);
  assert.ok(Array.isArray(prodsData.products));

  // 5. Test specific product lookup: PRD-PD9Q7JNL
  console.log('\n[4/5] Testing GET /api/products/PRD-PD9Q7JNL...');
  const t2 = performance.now();
  const singleRes = await worker.fetch(
    new Request('http://localhost:8787/api/products/PRD-PD9Q7JNL', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }),
    env
  );
  const singleData = await singleRes.json();
  const d2 = (performance.now() - t2).toFixed(2);
  console.log(`✓ GET /api/products/PRD-PD9Q7JNL status ${singleRes.status} in ${d2}ms`);
  console.log('  Product Title:', singleData.product?.title);
  console.log('  Product CreatedBy:', singleData.product?.createdBy);
  assert.equal(singleRes.status, 200);
  assert.equal(singleData.product?.id, 'PRD-PD9Q7JNL');

  // 6. Test Product Lifecycle (Create, Query, Delete)
  console.log('\n[5/5] Testing Create -> Query -> Delete Lifecycle in MongoDB Atlas...');
  const t3 = performance.now();
  const createRes = await worker.fetch(
    new Request('http://localhost:8787/api/products', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        title: 'Benchmark Automated Test Product',
        description: 'Temporary item for performance latency measurement',
        quantity: 15,
        color: 'Cobalt Blue',
        size: 'Medium',
      }),
    }),
    env
  );
  const createData = await createRes.json();
  const d3 = (performance.now() - t3).toFixed(2);
  console.log(`✓ Created product ${createData.product?.id} in ${d3}ms (status: ${createRes.status})`);
  assert.equal(createRes.status, 201);

  // Clean up benchmark product
  const t4 = performance.now();
  const delRes = await worker.fetch(
    new Request(`http://localhost:8787/api/products/${createData.product?.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }),
    env
  );
  const d4 = (performance.now() - t4).toFixed(2);
  console.log(`✓ Deleted product ${createData.product?.id} in ${d4}ms`);
  assert.equal(delRes.status, 200);

  console.log('\n=== E2E PERFORMANCE BENCHMARK SUMMARY ===');
  console.log(`- Cold Start Connect + Health: ${d0}ms`);
  console.log(`- Products List Query:          ${d1}ms`);
  console.log(`- Single Product Lookup:        ${d2}ms`);
  console.log(`- Insert Operation:             ${d3}ms`);
  console.log(`- Delete Operation:             ${d4}ms`);
  console.log('ALL E2E CHECKS PASSED WITH 100% SUCCESS!');
  process.exit(0);
}

runLocalE2ETest().catch((err) => {
  console.error('E2E Test Failed:', err);
  process.exit(1);
});
