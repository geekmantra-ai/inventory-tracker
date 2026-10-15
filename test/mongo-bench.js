import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_VARS_PATH = path.resolve(__dirname, '../.dev.vars');

async function loadEnv() {
  const env = {};
  const content = await fs.readFile(DEV_VARS_PATH, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
  }
  return env;
}

async function runBenchmark() {
  const env = await loadEnv();
  console.log('--- MONGO BENCHMARK ---');
  console.log('Target URI:', env.MONGODB_URI.replace(/:([^:@]+)@/, ':****@'));
  console.log('Database:', env.MONGODB_DB_NAME || 'inventory_platform');

  const startConnect = performance.now();
  const client = new MongoClient(env.MONGODB_URI, {
    maxPoolSize: 5,
    minPoolSize: 0,
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 10000,
  });

  try {
    await client.connect();
    const connectDuration = (performance.now() - startConnect).toFixed(2);
    console.log(`✓ Connected successfully in ${connectDuration}ms`);

    const db = client.db(env.MONGODB_DB_NAME || 'inventory_platform');

    // 1. Ping
    const t0 = performance.now();
    await db.command({ ping: 1 });
    console.log(`✓ db.ping took ${(performance.now() - t0).toFixed(2)}ms`);

    // 2. Query products collection
    const t1 = performance.now();
    const products = await db.collection('products').find({}).limit(50).toArray();
    console.log(`✓ Loaded ${products.length} products in ${(performance.now() - t1).toFixed(2)}ms`);
    if (products.length > 0) {
      console.log('Sample product ID:', products[0].id, 'title:', products[0].title, 'createdBy:', products[0].createdBy);
    }

    // 3. Concurrent Queries test (simulating UI loading products, activities, stats simultaneously)
    console.log('\n--- CONCURRENT BURST TEST (5 simultaneous queries) ---');
    const t2 = performance.now();
    const results = await Promise.all([
      db.collection('products').find({}).limit(20).toArray(),
      db.collection('activities').find({}).limit(20).toArray(),
      db.collection('users').findOne({}),
      db.collection('products').countDocuments(),
      db.collection('activities').countDocuments(),
    ]);
    console.log(`✓ 5 concurrent queries completed in ${(performance.now() - t2).toFixed(2)}ms`);

    // 4. Test individual product lookup by ID
    if (products.length > 0) {
      const testId = products[0].id;
      const t3 = performance.now();
      const p = await db.collection('products').findOne({ id: testId });
      console.log(`✓ getProductById("${testId}") took ${(performance.now() - t3).toFixed(2)}ms`);
    }

  } catch (err) {
    console.error('✗ MongoDB benchmark failed:', err.message);
  } finally {
    await client.close();
    console.log('✓ Client connection closed cleanly');
  }
}

runBenchmark();
