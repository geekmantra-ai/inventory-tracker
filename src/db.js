// Cloudflare D1 Native Edge SQL Data Layer for Cloudflare Workers
//
// Zero-latency serverless SQL database running natively at Cloudflare Edge.
// Zero TCP socket timeouts, zero connection freezing, ultra-lightweight.

import { hashPassword } from './auth.js';

let d1Initialized = false;

// Fallback store when env.DB binding is not yet attached (e.g. initial dev or mock tests)
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

export async function ensureD1Tables(env) {
  if (d1Initialized || !env?.DB || typeof env.DB.exec !== 'function') return;
  try {
    await env.DB.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        role TEXT NOT NULL DEFAULT 'admin',
        passwordHash TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        sku TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        quantity INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'In Stock',
        color TEXT DEFAULT '',
        size TEXT DEFAULT '',
        imageUrl TEXT DEFAULT '',
        imageProvider TEXT DEFAULT 'github-jsdelivr-cdn',
        totalSold INTEGER NOT NULL DEFAULT 0,
        createdBy TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_products_owner ON products(createdBy);
      CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);

      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        productId TEXT,
        productTitle TEXT,
        quantityBefore INTEGER,
        quantityAfter INTEGER,
        actorEmail TEXT NOT NULL,
        actorName TEXT NOT NULL,
        details TEXT DEFAULT '',
        timestamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_activities_owner ON activities(actorEmail);
      CREATE INDEX IF NOT EXISTS idx_activities_product ON activities(productId);

      CREATE TABLE IF NOT EXISTS product_images (
        id TEXT PRIMARY KEY,
        contentType TEXT NOT NULL,
        base64Data TEXT NOT NULL,
        createdAt TEXT NOT NULL
      );
    `);
    d1Initialized = true;
  } catch (err) {
    console.warn('D1 schema initialization warning:', err?.message || err);
  }
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

export async function getDbStatus(env = {}) {
  if (env.DB) {
    await ensureD1Tables(env);
    return {
      mode: 'cloudflare-d1',
      connected: true,
      database: 'stockpulse-db (Native Edge SQLite)',
      engine: 'Cloudflare D1 (0ms TCP cold-start, instant queries)',
    };
  }
  await ensureFallbackSeeded();
  return {
    mode: 'edge-fallback-store',
    connected: true,
    database: 'local_memory_fallback (Attach Cloudflare D1 via wrangler.toml [[d1_databases]])',
  };
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

  if (env.DB) {
    await ensureD1Tables(env);
    await env.DB.prepare(`
      INSERT INTO activities (id, action, productId, productTitle, quantityBefore, quantityAfter, actorEmail, actorName, details, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      entry.id,
      entry.action,
      entry.productId,
      entry.productTitle,
      entry.quantityBefore,
      entry.quantityAfter,
      entry.actorEmail,
      entry.actorName,
      entry.details,
      entry.timestamp
    ).run();
  } else {
    await ensureFallbackSeeded();
    memoryStore.activities.unshift(entry);
    if (memoryStore.activities.length > 500) {
      memoryStore.activities.length = 500;
    }
  }

  return entry;
}

export async function listActivities(
  env,
  { ownerEmail = '', productId = null, limit = 100 } = {}
) {
  const normalizedOwner = String(ownerEmail || '').trim().toLowerCase();
  if (!normalizedOwner) return [];

  if (env.DB) {
    await ensureD1Tables(env);
    let query = 'SELECT * FROM activities WHERE actorEmail = ?';
    const params = [normalizedOwner];
    if (productId) {
      query += ' AND productId = ?';
      params.push(productId);
    }
    query += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(Number(limit) || 100);

    const { results } = await env.DB.prepare(query).bind(...params).all();
    return results || [];
  }

  await ensureFallbackSeeded();
  let items = memoryStore.activities.filter(
    (a) => String(a.actorEmail || '').toLowerCase() === normalizedOwner
  );
  if (productId) {
    items = items.filter((a) => a.productId === productId);
  }
  return items.slice(0, Number(limit) || 100);
}

export async function findUserByEmail(env, email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (env.DB) {
    await ensureD1Tables(env);
    const user = await env.DB.prepare('SELECT id, name, email, role, passwordHash, createdAt FROM users WHERE LOWER(email) = ?')
      .bind(normalized)
      .first();
    return user || null;
  }

  await ensureFallbackSeeded();
  return memoryStore.users.find((u) => u.email === normalized) || null;
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

  if (env.DB) {
    await ensureD1Tables(env);
    await env.DB.prepare('INSERT INTO users (id, name, email, role, passwordHash, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(user.id, user.name, user.email, user.role, user.passwordHash, user.createdAt)
      .run();
    return user;
  }

  await ensureFallbackSeeded();
  memoryStore.users.push(user);
  return user;
}

export async function listProducts(
  env,
  { ownerEmail = '', search = '', status = '', color = '', size = '' } = {}
) {
  const normalizedOwner = String(ownerEmail || '').trim().toLowerCase();
  if (!normalizedOwner) return [];

  if (env.DB) {
    await ensureD1Tables(env);
    let query = 'SELECT * FROM products WHERE LOWER(createdBy) = ?';
    const params = [normalizedOwner];

    if (search) {
      query += ' AND (LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(id) LIKE ? OR LOWER(color) LIKE ? OR LOWER(size) LIKE ?)';
      const term = `%${search.toLowerCase()}%`;
      params.push(term, term, term, term, term);
    }
    if (status) {
      if (status === 'out_of_stock') {
        query += ' AND quantity = 0';
      } else if (status === 'in_stock') {
        query += ' AND quantity > 0';
      } else if (status === 'low_stock') {
        query += ' AND quantity > 0 AND quantity <= 5';
      }
    }
    if (color) {
      query += ' AND LOWER(color) = ?';
      params.push(color.toLowerCase());
    }
    if (size) {
      query += ' AND LOWER(size) = ?';
      params.push(size.toLowerCase());
    }

    query += ' ORDER BY createdAt DESC';
    const { results } = await env.DB.prepare(query).bind(...params).all();
    return results || [];
  }

  await ensureFallbackSeeded();
  let products = memoryStore.products
    .filter((p) => String(p.createdBy || '').toLowerCase() === normalizedOwner)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

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

  if (env.DB) {
    await ensureD1Tables(env);
    const prod = await env.DB.prepare('SELECT * FROM products WHERE id = ? AND LOWER(createdBy) = ?')
      .bind(cleanId, normalizedOwner)
      .first();
    return prod || null;
  }

  await ensureFallbackSeeded();
  return (
    memoryStore.products.find(
      (p) => p.id === cleanId && String(p.createdBy || '').toLowerCase() === normalizedOwner
    ) || null
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
    imageProvider: data.imageProvider || 'github-jsdelivr-cdn',
    totalSold: 0,
    createdBy: ownerEmail,
    createdAt: now,
    updatedAt: now,
  };

  if (env.DB) {
    await ensureD1Tables(env);
    await env.DB.prepare(`
      INSERT INTO products (id, sku, title, description, quantity, status, color, size, imageUrl, imageProvider, totalSold, createdBy, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      product.id,
      product.sku,
      product.title,
      product.description,
      product.quantity,
      product.status,
      product.color,
      product.size,
      product.imageUrl,
      product.imageProvider,
      product.totalSold,
      product.createdBy,
      product.createdAt,
      product.updatedAt
    ).run();
  } else {
    await ensureFallbackSeeded();
    memoryStore.products.unshift(product);
  }

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

  if (env.DB) {
    await ensureD1Tables(env);
    await env.DB.prepare(`
      UPDATE products
      SET title = ?, description = ?, quantity = ?, status = ?, color = ?, size = ?, imageUrl = ?, imageProvider = ?, updatedAt = ?
      WHERE id = ? AND LOWER(createdBy) = ?
    `).bind(
      updated.title,
      updated.description,
      updated.quantity,
      updated.status,
      updated.color,
      updated.size,
      updated.imageUrl,
      updated.imageProvider,
      updated.updatedAt,
      existing.id,
      ownerEmail
    ).run();
  } else {
    await ensureFallbackSeeded();
    const idx = memoryStore.products.findIndex(
      (p) => p.id === existing.id && String(p.createdBy || '').toLowerCase() === ownerEmail
    );
    if (idx !== -1) {
      memoryStore.products[idx] = updated;
    }
  }

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

  if (env.DB) {
    await ensureD1Tables(env);
    await env.DB.prepare(`
      UPDATE products
      SET quantity = ?, status = ?, totalSold = ?, updatedAt = ?
      WHERE id = ? AND LOWER(createdBy) = ?
    `).bind(updated.quantity, updated.status, updated.totalSold, updated.updatedAt, existing.id, ownerEmail).run();
  } else {
    await ensureFallbackSeeded();
    const idx = memoryStore.products.findIndex(
      (p) => p.id === existing.id && String(p.createdBy || '').toLowerCase() === ownerEmail
    );
    if (idx !== -1) {
      memoryStore.products[idx] = updated;
    }
  }

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

  if (env.DB) {
    await ensureD1Tables(env);
    await env.DB.prepare('DELETE FROM products WHERE id = ? AND LOWER(createdBy) = ?')
      .bind(existing.id, ownerEmail)
      .run();
  } else {
    await ensureFallbackSeeded();
    const idx = memoryStore.products.findIndex(
      (p) => p.id === existing.id && String(p.createdBy || '').toLowerCase() === ownerEmail
    );
    if (idx !== -1) {
      memoryStore.products.splice(idx, 1);
    }
  }

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

  if (env.DB) {
    await ensureD1Tables(env);
    await env.DB.prepare('INSERT INTO product_images (id, contentType, base64Data, createdAt) VALUES (?, ?, ?, ?)')
      .bind(doc.id, doc.contentType, doc.base64Data, doc.createdAt)
      .run();
  } else {
    await ensureFallbackSeeded();
    memoryStore.images.push(doc);
  }
  return doc;
}

export async function getImageRecord(env, id) {
  if (env.DB) {
    await ensureD1Tables(env);
    const row = await env.DB.prepare('SELECT * FROM product_images WHERE id = ?')
      .bind(id)
      .first();
    return row || null;
  }

  await ensureFallbackSeeded();
  return memoryStore.images.find((img) => img.id === id) || null;
}
