// Cloud MongoDB (MongoDB Atlas) Data Layer for Cloudflare Workers
// Uses the official `mongodb` driver when `MONGODB_URI` is configured,
// with an automatic fallback store so local development works out-of-the-box.

import { hashPassword } from './auth.js';

let cachedMongoClient = null;
let cachedMongoDb = null;
let cachedUri = null;

// Fallback store when MONGODB_URI is not yet set
const memoryStore = {
  initialized: false,
  users: [],
  products: [],
  activities: [],
  images: [],
};

function generateProductId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const randomBytes = crypto.getRandomValues(new Uint8Array(8));
  for (let i = 0; i < 8; i++) {
    code += chars[randomBytes[i] % chars.length];
  }
  return `PRD-${code}`;
}

function computeStatus(quantity) {
  const qty = Math.max(0, Number(quantity) || 0);
  return qty === 0 ? 'Out of Stock' : 'In Stock';
}

async function ensureFallbackSeeded() {
  if (memoryStore.initialized) return;
  memoryStore.initialized = true;

  const adminPasswordHash = await hashPassword('Admin@123', 'demo_admin_salt');
  const now = new Date().toISOString();

  memoryStore.users.push({
    id: 'usr-admin-01',
    name: 'Admin Manager',
    email: 'admin@inventory.io',
    role: 'admin',
    passwordHash: adminPasswordHash,
    createdAt: now,
  });

  const sampleProducts = [
    {
      id: 'PRD-A7X9K2M4',
      sku: 'PRD-A7X9K2M4',
      title: 'AeroMesh Ergonomic Studio Chair',
      description:
        'Breathable lumbar-support office chair with 4D adjustable armrests and synchronized tilt mechanism.',
      quantity: 12,
      status: 'In Stock',
      color: 'Obsidian Black',
      size: 'Standard / Adjustable',
      imageUrl:
        'https://images.unsplash.com/photo-1580480055273-228ff5388ef8?auto=format&fit=crop&w=700&q=80',
      imageProvider: 'external-url',
      totalSold: 5,
      createdBy: 'admin@inventory.io',
      createdAt: new Date(Date.now() - 86400000 * 3).toISOString(),
      updatedAt: new Date(Date.now() - 3600000 * 5).toISOString(),
    },
    {
      id: 'PRD-B3N8Q5L1',
      sku: 'PRD-B3N8Q5L1',
      title: 'Chronos Mechanical Wireless Keyboard',
      description:
        'Hot-swappable tactile mechanical keyboard with CNC aluminum frame, dual-mode Bluetooth 5.1 & USB-C.',
      quantity: 2,
      status: 'In Stock',
      color: 'Space Gray',
      size: '75% Compact',
      imageUrl:
        'https://images.unsplash.com/photo-1595225476474-87563907a212?auto=format&fit=crop&w=700&q=80',
      imageProvider: 'external-url',
      totalSold: 18,
      createdBy: 'admin@inventory.io',
      createdAt: new Date(Date.now() - 86400000 * 2).toISOString(),
      updatedAt: new Date(Date.now() - 3600000 * 2).toISOString(),
    },
    {
      id: 'PRD-C9P4W6Z8',
      sku: 'PRD-C9P4W6Z8',
      title: 'Luminary 4K USB-C Studio Monitor',
      description:
        '27-inch IPS 4K UHD display with 99% DCI-P3 color gamut, 90W USB-C Power Delivery, and height-adjustable stand.',
      quantity: 0,
      status: 'Out of Stock',
      color: 'Silver',
      size: '27 inch',
      imageUrl:
        'https://images.unsplash.com/photo-1527443224154-c4a3942d3acf?auto=format&fit=crop&w=700&q=80',
      imageProvider: 'external-url',
      totalSold: 10,
      createdBy: 'admin@inventory.io',
      createdAt: new Date(Date.now() - 86400000 * 4).toISOString(),
      updatedAt: new Date(Date.now() - 1800000).toISOString(),
    },
  ];

  memoryStore.products.push(...sampleProducts);

  memoryStore.activities.push(
    {
      id: crypto.randomUUID(),
      action: 'OUT_OF_STOCK',
      productId: 'PRD-C9P4W6Z8',
      productTitle: 'Luminary 4K USB-C Studio Monitor',
      quantityBefore: 1,
      quantityAfter: 0,
      actorEmail: 'admin@inventory.io',
      actorName: 'Admin Manager',
      details:
        'Marked 1 unit of "Luminary 4K USB-C Studio Monitor" as sold (1 -> 0). Product is now Out of Stock!',
      timestamp: new Date(Date.now() - 1800000).toISOString(),
    },
    {
      id: crypto.randomUUID(),
      action: 'PRODUCT_SOLD',
      productId: 'PRD-B3N8Q5L1',
      productTitle: 'Chronos Mechanical Wireless Keyboard',
      quantityBefore: 3,
      quantityAfter: 2,
      actorEmail: 'admin@inventory.io',
      actorName: 'Admin Manager',
      details: 'Marked 1 unit of "Chronos Mechanical Wireless Keyboard" as sold (3 -> 2).',
      timestamp: new Date(Date.now() - 3600000 * 2).toISOString(),
    },
    {
      id: crypto.randomUUID(),
      action: 'PRODUCT_CREATED',
      productId: 'PRD-A7X9K2M4',
      productTitle: 'AeroMesh Ergonomic Studio Chair',
      quantityBefore: 0,
      quantityAfter: 12,
      actorEmail: 'admin@inventory.io',
      actorName: 'Admin Manager',
      details: 'Created product "AeroMesh Ergonomic Studio Chair" with initial quantity 12.',
      timestamp: new Date(Date.now() - 86400000 * 3).toISOString(),
    }
  );
}

function sanitizeMongoUri(rawUri) {
  const trimmed = String(rawUri || '').trim();
  const schemeMatch = trimmed.match(/^(mongodb(?:\+srv)?:\/\/)(.+)$/);
  if (!schemeMatch) return trimmed;
  const scheme = schemeMatch[1];
  const rest = schemeMatch[2];
  const slashIdx = rest.indexOf('/');
  const authority = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
  const pathAndQuery = slashIdx === -1 ? '' : rest.slice(slashIdx);

  const lastAtIdx = authority.lastIndexOf('@');
  if (lastAtIdx === -1) return trimmed;

  const userInfo = authority.slice(0, lastAtIdx);
  const hostPart = authority.slice(lastAtIdx + 1);
  const colonIdx = userInfo.indexOf(':');
  if (colonIdx === -1) return trimmed;

  const rawUser = decodeURIComponent(userInfo.slice(0, colonIdx));
  const rawPass = decodeURIComponent(userInfo.slice(colonIdx + 1));
  return `${scheme}${encodeURIComponent(rawUser)}:${encodeURIComponent(rawPass)}@${hostPart}${pathAndQuery}`;
}

let lastFailedAt = 0;
let lastMongoError = null;
let lastActivityAt = 0;
const ISOLATE_IDLE_TIMEOUT_MS = 20000;

function withTimeout(promise, ms = 10000, name = 'Database Operation') {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${name} timed out after ${ms}ms`);
      err.name = 'TimeoutError';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timer);
  });
}

async function getMongoDatabase(env = {}) {
  const uri = sanitizeMongoUri(env.MONGODB_URI || '');
  if (!uri) return null;

  // If isolate was frozen/idle for > 20s, TCP sockets are frequently severed by edge firewalls.
  // Proactively close the stale socket so queries don't hang.
  if (cachedMongoDb && cachedUri === uri) {
    if (Date.now() - lastActivityAt < ISOLATE_IDLE_TIMEOUT_MS) {
      return cachedMongoDb;
    }
    try {
      cachedMongoClient?.close()?.catch?.(() => {});
    } catch {}
    cachedMongoClient = null;
    cachedMongoDb = null;
  }

  try {
    const { MongoClient } = await import('mongodb');
    if (cachedMongoClient) {
      try {
        await cachedMongoClient.close();
      } catch {}
    }
    const client = new MongoClient(uri, {
      maxPoolSize: 5,
      minPoolSize: 0,
      maxIdleTimeMS: 20000,
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 8000,
      family: 4,
    });
    if (typeof client.on === 'function') {
      client.on('error', (e) => {
        console.warn('MongoClient background socket notice:', e?.message || e);
      });
    }

    await withTimeout(client.connect(), 10000, 'MongoClient.connect');
    const dbName = env.MONGODB_DB_NAME || 'inventory_platform';
    cachedMongoClient = client;
    cachedMongoDb = client.db(dbName);
    cachedUri = uri;
    lastFailedAt = 0;
    lastMongoError = null;
    lastActivityAt = Date.now();

    return cachedMongoDb;
  } catch (err) {
    cachedUri = uri;
    lastFailedAt = Date.now();
    lastMongoError = err.message;
    console.warn('MongoDB connection notice (using fallback store):', err.message);
    return null;
  }
}

export async function getDbStatus(env = {}) {
  const db = await getMongoDatabase(env);
  if (db) {
    return {
      mode: 'mongodb-atlas',
      connected: true,
      database: env.MONGODB_DB_NAME || 'inventory_platform',
    };
  }
  await ensureFallbackSeeded();
  return {
    mode: 'edge-fallback-store',
    connected: true,
    database: lastMongoError
      ? `local_memory_fallback (MongoDB note: ${lastMongoError})`
      : 'local_memory_fallback (set MONGODB_URI for Cloud MongoDB Atlas)',
  };
}

async function executeMongo(env, operation, fallbackFn) {
  const hasMongo = Boolean(env.MONGODB_URI);
  let db = null;
  try {
    db = await withTimeout(getMongoDatabase(env), 10000, 'getMongoDatabase');
  } catch (connErr) {
    console.warn('MongoDB getMongoDatabase warning:', connErr?.message || connErr);
  }

  if (db) {
    try {
      const res = await withTimeout(operation(db), 8000, 'MongoDB query');
      lastActivityAt = Date.now();
      return res;
    } catch (err) {
      console.warn('MongoDB query failed or timed out, resetting connection and retrying once:', err?.message || err);
      try {
        cachedMongoClient?.close()?.catch?.(() => {});
      } catch {}
      cachedMongoClient = null;
      cachedMongoDb = null;
      lastFailedAt = Date.now();
      lastMongoError = err?.message || String(err);

      // Auto-retry once on a fresh connection if MongoDB is configured
      if (hasMongo) {
        try {
          const retryDb = await withTimeout(getMongoDatabase(env), 10000, 'retryConnect');
          if (retryDb) {
            const res = await withTimeout(operation(retryDb), 8000, 'retryQuery');
            lastActivityAt = Date.now();
            return res;
          }
        } catch (retryErr) {
          console.warn('MongoDB retry attempt failed:', retryErr?.message || retryErr);
        }
      }
    }
  }

  // Only fall back to memoryStore if MONGODB_URI is not provided
  if (!hasMongo) {
    return await fallbackFn();
  }

  // If MONGODB_URI was configured, don't return false "not found" data from empty memoryStore
  const err = new Error(
    `Database connection is establishing (${lastMongoError || 'connecting...'}). Please retry.`
  );
  err.status = 503;
  throw err;
}

export async function recordActivity(env, event) {
  const entry = {
    id: crypto.randomUUID(),
    action: event.action,
    productId: event.productId || null,
    productTitle: event.productTitle || null,
    quantityBefore: event.quantityBefore ?? null,
    quantityAfter: event.quantityAfter ?? null,
    actorEmail: event.actorEmail || 'system',
    actorName: event.actorName || 'System',
    details: event.details || '',
    timestamp: new Date().toISOString(),
  };

  await executeMongo(
    env,
    (db) => db.collection('activities').insertOne({ ...entry }),
    async () => {
      await ensureFallbackSeeded();
      memoryStore.activities.unshift(entry);
      if (memoryStore.activities.length > 500) {
        memoryStore.activities.length = 500;
      }
    }
  );

  return entry;
}

export async function listActivities(
  env,
  { ownerEmail = '', productId = null, limit = 100 } = {}
) {
  const normalizedOwner = String(ownerEmail || '').trim().toLowerCase();
  if (!normalizedOwner) return [];

  const query = { actorEmail: normalizedOwner };
  if (productId) query.productId = productId;

  const rawDocs = await executeMongo(
    env,
    (db) =>
      db
        .collection('activities')
        .find(query, { projection: { _id: 0 } })
        .sort({ timestamp: -1 })
        .limit(Number(limit) || 100)
        .toArray(),
    async () => {
      await ensureFallbackSeeded();
      let items = memoryStore.activities.filter(
        (a) => String(a.actorEmail || '').toLowerCase() === normalizedOwner
      );
      if (productId) {
        items = items.filter((a) => a.productId === productId);
      }
      return items.slice(0, Number(limit) || 100);
    }
  );

  return Array.isArray(rawDocs) ? rawDocs : [];
}

export async function findUserByEmail(env, email) {
  const normalized = String(email || '').trim().toLowerCase();
  return executeMongo(
    env,
    (db) => db.collection('users').findOne({ email: normalized }, { projection: { _id: 0 } }),
    async () => {
      await ensureFallbackSeeded();
      return memoryStore.users.find((u) => u.email === normalized) || null;
    }
  );
}

export async function createUser(env, { name, email, passwordHash, role = 'admin' }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const user = {
    id: `usr-${crypto.randomUUID().slice(0, 8)}`,
    name: String(name || normalizedEmail.split('@')[0]).trim(),
    email: normalizedEmail,
    role,
    passwordHash,
    createdAt: new Date().toISOString(),
  };

  await executeMongo(
    env,
    (db) => db.collection('users').insertOne({ ...user }),
    async () => {
      await ensureFallbackSeeded();
      memoryStore.users.push(user);
    }
  );
  return user;
}

export async function listProducts(
  env,
  { ownerEmail = '', search = '', status = '', color = '', size = '' } = {}
) {
  const normalizedOwner = String(ownerEmail || '').trim().toLowerCase();
  if (!normalizedOwner) return [];

  const rawProducts = await executeMongo(
    env,
    (db) =>
      db
        .collection('products')
        .find({ createdBy: normalizedOwner }, { projection: { _id: 0 } })
        .sort({ createdAt: -1 })
        .toArray(),
    async () => {
      await ensureFallbackSeeded();
      return memoryStore.products
        .filter((p) => String(p.createdBy || '').toLowerCase() === normalizedOwner)
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    }
  );

  const products = Array.isArray(rawProducts) ? rawProducts : [];

  return products.filter((p) => {
    if (search) {
      const q = search.toLowerCase();
      const matchTitle = (p.title || '').toLowerCase().includes(q);
      const matchDesc = (p.description || '').toLowerCase().includes(q);
      const matchId = (p.id || '').toLowerCase().includes(q);
      const matchColor = (p.color || '').toLowerCase().includes(q);
      const matchSize = (p.size || '').toLowerCase().includes(q);
      if (!matchTitle && !matchDesc && !matchId && !matchColor && !matchSize) return false;
    }
    if (status) {
      if (status === 'out_of_stock' && p.quantity > 0) return false;
      if (status === 'in_stock' && p.quantity === 0) return false;
      if (status === 'low_stock' && (p.quantity === 0 || p.quantity > 5)) return false;
    }
    if (color && (p.color || '').toLowerCase() !== color.toLowerCase()) return false;
    if (size && (p.size || '').toLowerCase() !== size.toLowerCase()) return false;
    return true;
  });
}

export async function getProductById(env, id, ownerEmail = '') {
  const cleanId = String(id || '').trim();
  const normalizedOwner = String(ownerEmail || '').trim().toLowerCase();
  if (!cleanId || !normalizedOwner) return null;

  return executeMongo(
    env,
    (db) =>
      db
        .collection('products')
        .findOne({ id: cleanId, createdBy: normalizedOwner }, { projection: { _id: 0 } }),
    async () => {
      await ensureFallbackSeeded();
      return (
        memoryStore.products.find(
          (p) => p.id === cleanId && String(p.createdBy || '').toLowerCase() === normalizedOwner
        ) || null
      );
    }
  );
}

export async function createProduct(env, data, actor = {}) {
  const id = data.id || generateProductId();
  const quantity = Math.max(0, Math.floor(Number(data.quantity) || 0));
  const now = new Date().toISOString();
  const ownerEmail = String(actor.email || 'admin@inventory.io').trim().toLowerCase();

  const product = {
    id,
    sku: id,
    title: String(data.title || '').trim(),
    description: String(data.description || '').trim(),
    quantity,
    status: computeStatus(quantity),
    color: data.color ? String(data.color).trim() : '',
    size: data.size ? String(data.size).trim() : '',
    imageUrl: data.imageUrl || '',
    imageProvider: data.imageProvider || 'inline-mongodb',
    totalSold: 0,
    createdBy: ownerEmail,
    createdAt: now,
    updatedAt: now,
  };

  await executeMongo(
    env,
    (db) => db.collection('products').insertOne({ ...product }),
    async () => {
      await ensureFallbackSeeded();
      memoryStore.products.unshift(product);
    }
  );

  await recordActivity(env, {
    action: 'PRODUCT_CREATED',
    productId: product.id,
    productTitle: product.title,
    quantityBefore: 0,
    quantityAfter: product.quantity,
    actorEmail: ownerEmail,
    actorName: actor.name || 'Admin',
    details: `Created product "${product.title}" (${product.id}) with quantity ${product.quantity}${
      product.quantity === 0 ? ' (Out of Stock)' : ''
    }.`,
  });

  return product;
}

export async function updateProduct(env, id, updates, actor = {}) {
  const ownerEmail = String(actor.email || '').trim().toLowerCase();
  const existing = await getProductById(env, id, ownerEmail);
  if (!existing) return null;

  const newQuantity =
    updates.quantity !== undefined
      ? Math.max(0, Math.floor(Number(updates.quantity) || 0))
      : existing.quantity;

  const updated = {
    ...existing,
    title: updates.title !== undefined ? String(updates.title).trim() : existing.title,
    description:
      updates.description !== undefined ? String(updates.description).trim() : existing.description,
    quantity: newQuantity,
    status: computeStatus(newQuantity),
    color: updates.color !== undefined ? String(updates.color).trim() : existing.color,
    size: updates.size !== undefined ? String(updates.size).trim() : existing.size,
    imageUrl: updates.imageUrl !== undefined ? updates.imageUrl : existing.imageUrl,
    imageProvider:
      updates.imageProvider !== undefined ? updates.imageProvider : existing.imageProvider,
    updatedAt: new Date().toISOString(),
  };

  await executeMongo(
    env,
    (db) =>
      db
        .collection('products')
        .updateOne({ id: existing.id, createdBy: ownerEmail }, { $set: updated }),
    async () => {
      await ensureFallbackSeeded();
      const idx = memoryStore.products.findIndex(
        (p) => p.id === existing.id && String(p.createdBy || '').toLowerCase() === ownerEmail
      );
      if (idx !== -1) {
        memoryStore.products[idx] = updated;
      }
    }
  );

  const becameOutOfStock = existing.quantity > 0 && updated.quantity === 0;
  const actionType = becameOutOfStock ? 'OUT_OF_STOCK' : 'PRODUCT_UPDATED';
  const changes = [];
  if (existing.title !== updated.title) changes.push(`title -> "${updated.title}"`);
  if (existing.quantity !== updated.quantity)
    changes.push(`quantity ${existing.quantity} -> ${updated.quantity}`);
  if (existing.color !== updated.color) changes.push(`color -> "${updated.color || 'None'}"`);
  if (existing.size !== updated.size) changes.push(`size -> "${updated.size || 'None'}"`);

  await recordActivity(env, {
    action: actionType,
    productId: updated.id,
    productTitle: updated.title,
    quantityBefore: existing.quantity,
    quantityAfter: updated.quantity,
    actorEmail: ownerEmail,
    actorName: actor.name || 'Admin',
    details: becameOutOfStock
      ? `Updated "${updated.title}" quantity (${existing.quantity} -> 0). Product is now Out of Stock!`
      : `Updated product "${updated.title}" (${
          changes.length ? changes.join(', ') : 'metadata updated'
        }).`,
  });

  return updated;
}

export async function markProductAsSold(env, id, units = 1, actor = {}) {
  const ownerEmail = String(actor.email || '').trim().toLowerCase();
  const existing = await getProductById(env, id, ownerEmail);
  if (!existing) {
    return { error: 'Product not found', status: 404 };
  }
  if (existing.quantity <= 0) {
    return {
      error: 'Product is already Out of Stock (quantity = 0)',
      status: 400,
      product: existing,
    };
  }

  const sellCount = Math.max(1, Math.min(existing.quantity, Math.floor(Number(units) || 1)));
  const newQuantity = existing.quantity - sellCount;
  const newStatus = computeStatus(newQuantity);
  const now = new Date().toISOString();

  const updated = {
    ...existing,
    quantity: newQuantity,
    status: newStatus,
    totalSold: (existing.totalSold || 0) + sellCount,
    updatedAt: now,
  };

  await executeMongo(
    env,
    (db) =>
      db
        .collection('products')
        .updateOne({ id: existing.id, createdBy: ownerEmail }, { $set: updated }),
    async () => {
      await ensureFallbackSeeded();
      const idx = memoryStore.products.findIndex(
        (p) => p.id === existing.id && String(p.createdBy || '').toLowerCase() === ownerEmail
      );
      if (idx !== -1) {
        memoryStore.products[idx] = updated;
      }
    }
  );

  // Record the sale activity
  await recordActivity(env, {
    action: newQuantity === 0 ? 'OUT_OF_STOCK' : 'PRODUCT_SOLD',
    productId: updated.id,
    productTitle: updated.title,
    quantityBefore: existing.quantity,
    quantityAfter: newQuantity,
    actorEmail: ownerEmail,
    actorName: actor.name || 'Admin',
    details:
      newQuantity === 0
        ? `Marked ${sellCount} unit of "${updated.title}" as sold (${existing.quantity} -> 0). Product is now Out of Stock!`
        : `Marked ${sellCount} unit of "${updated.title}" as sold (${existing.quantity} -> ${newQuantity}).`,
  });

  return { product: updated, status: 200 };
}

export async function deleteProduct(env, id, actor = {}) {
  const ownerEmail = String(actor.email || '').trim().toLowerCase();
  const existing = await getProductById(env, id, ownerEmail);
  if (!existing) return null;

  await executeMongo(
    env,
    (db) => db.collection('products').deleteOne({ id: existing.id, createdBy: ownerEmail }),
    async () => {
      await ensureFallbackSeeded();
      const idx = memoryStore.products.findIndex(
        (p) => p.id === existing.id && String(p.createdBy || '').toLowerCase() === ownerEmail
      );
      if (idx !== -1) {
        memoryStore.products.splice(idx, 1);
      }
    }
  );

  await recordActivity(env, {
    action: 'PRODUCT_DELETED',
    productId: existing.id,
    productTitle: existing.title,
    quantityBefore: existing.quantity,
    quantityAfter: 0,
    actorEmail: ownerEmail,
    actorName: actor.name || 'Admin',
    details: `Deleted product "${existing.title}" (${existing.id}) from inventory.`,
  });

  return existing;
}

export async function saveImageRecord(env, { id, contentType, base64Data }) {
  const doc = {
    id,
    contentType: contentType || 'image/webp',
    base64Data,
    createdAt: new Date().toISOString(),
  };

  await executeMongo(
    env,
    (db) => db.collection('product_images').insertOne({ ...doc }),
    async () => {
      await ensureFallbackSeeded();
      memoryStore.images.push(doc);
    }
  );
  return doc;
}

export async function getImageRecord(env, id) {
  return executeMongo(
    env,
    (db) => db.collection('product_images').findOne({ id }, { projection: { _id: 0 } }),
    async () => {
      await ensureFallbackSeeded();
      return memoryStore.images.find((img) => img.id === id) || null;
    }
  );
}


