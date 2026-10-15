-- Cloudflare D1 Database Schema for StockPulse Inventory Platform

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
