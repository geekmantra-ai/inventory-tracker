# StockPulse — Cloud Inventory Management Platform

A full-stack Inventory Management Platform built on **Cloudflare Workers**, **Cloud MongoDB (MongoDB Atlas)**, and **GitHub Repository + jsDelivr Global CDN** for 100% free product image storage.

---

## Core Features

1. **Admin & User Authentication (Email & Password)**:
   - Sign in or register a new user account (`/api/auth/login`, `/api/auth/register`).
   - Built-in Web Crypto PBKDF2 password hashing and HMAC-SHA256 JWT tokens compatible with Cloudflare Workers edge runtime.
   - Pre-seeded demo admin account: `admin@inventory.io` / `Admin@123`.
2. **Complete Product CRUD**:
   - **Create (`POST /api/products`)**: Add Product with **Title**, **Description**, **Quantity**, **Color (optional)**, **Size (optional)**, and **Upload Picture**.
   - **Read (`GET /api/products`, `GET /api/products/:id`)**: Searchable, filterable inventory grid plus a dedicated **Product Display Page** at `/product/:id`.
   - **Update (`PUT /api/products/:id`)**: Edit product details, stock quantity, optional attributes, or replace product image.
   - **Delete (`DELETE /api/products/:id`)**: Delete products with confirmation and audit logging.
3. **Automatic Barcode & QR Code Generation + Scanning**:
   - Immediately upon adding a product, the platform generates both a **QR Code** (encoding the direct URL `${origin}/product/<SKU>`) and a **Code-128B Barcode** (encoding the product SKU).
   - Scanning the QR code with any phone camera—or using the built-in **Scan QR / Barcode** modal in the app—opens the **Product Display Page** directly in the tool.
   - Includes 1-click **Download QR PNG** and **Print Barcode / QR Label**.
4. **Mark as Sold & Out of Stock Automation (`POST /api/products/:id/sell`)**:
   - Clicking **Mark as Sold (-1)** atomically decrements `quantity` by 1 and increments `totalSold`.
   - When `quantity` reaches `0`, the product status automatically transitions to **Out of Stock** and disables further sales until restocked.
5. **Activity History Tracking (`GET /api/activities`)**:
   - Tracks `PRODUCT_CREATED`, `PRODUCT_UPDATED`, `PRODUCT_SOLD`, `OUT_OF_STOCK`, `PRODUCT_DELETED`, `USER_LOGIN`, and `USER_REGISTERED` with actor details and before/after quantities.

---

## Free Product Image Storage: GitHub Repository + jsDelivr CDN

Product images are handled by [`src/storage.js`](file:///Users/suraj/Downloads/GeekMantra/Inventory%20Management/src/storage.js) using **GitHub Contents REST API + jsDelivr CDN** ($0 cost, no credit card required, unlimited global CDN bandwidth):

### How It Works
1. When an admin selects a picture in **Add Product**, [`compressImageToWebpDataUrl`](file:///Users/suraj/Downloads/GeekMantra/Inventory%20Management/public/app.js#L565-L591) compresses and converts the image to a lightweight **WebP** file in the browser.
2. The Cloudflare Worker uploads the file to your GitHub repository via:
   `PUT https://api.github.com/repos/<GITHUB_REPO>/contents/product-images/<imageId>.webp`
3. For public repositories, the image URL is returned as a global **jsDelivr CDN** link:
   `https://cdn.jsdelivr.net/gh/<owner>/<repo>@main/product-images/<imageId>.webp`
   *(For private repositories, set `GITHUB_REPO_PRIVATE=true` and the Worker automatically serves the image through `/api/images/gh-<imageId>.webp` with Cloudflare Edge Caching!)*

### 1-Minute Setup Guide for GitHub Image Storage
1. Create a free repository on GitHub (e.g., `your-username/inventory-product-images`).
2. Go to **GitHub Settings &rarr; Developer settings &rarr; Personal access tokens &rarr; Fine-grained tokens &rarr; Generate new token**:
   - **Repository access**: Select *Only select repositories* &rarr; pick `inventory-product-images`.
   - **Permissions**: Under *Repository permissions*, set **Contents** to **Read and write**.
3. Copy [`.dev.vars.example`](file:///Users/suraj/Downloads/GeekMantra/Inventory%20Management/.dev.vars.example) to `.dev.vars` and fill in:
   ```ini
   GITHUB_TOKEN=github_pat_...
   GITHUB_REPO=your-username/inventory-product-images
   GITHUB_BRANCH=main
   ```
4. For production Cloudflare Worker deployment:
   ```bash
   npx wrangler secret put GITHUB_TOKEN
   npx wrangler secret put GITHUB_REPO
   ```

*(Note: Before `GITHUB_TOKEN` and `GITHUB_REPO` are set, [`src/storage.js`](file:///Users/suraj/Downloads/GeekMantra/Inventory%20Management/src/storage.js) automatically falls back to storing images in your MongoDB `product_images` collection so local testing works immediately with zero configuration.)*

---

## Quick Start

```bash
# Run locally on http://localhost:8787
npm start

# Run automated test suite
npm test
```
