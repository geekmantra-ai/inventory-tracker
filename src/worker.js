// Cloudflare Worker Entry Point for Inventory Management Platform
import { hashPassword, verifyPassword, signJwt, getAuthUser } from './auth.js';
import {
  getDbStatus,
  findUserByEmail,
  createUser,
  listProducts,
  getProductById,
  createProduct,
  updateProduct,
  markProductAsSold,
  deleteProduct,
  listActivities,
  recordActivity,
} from './db.js';
import {
  getActiveStorageProvider,
  uploadProductImage,
  serveStoredImage,
} from './storage.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
    },
  });
}

async function parseRequestBody(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData();
    const result = {};
    for (const [key, value] of formData.entries()) {
      result[key] = value;
    }
    return result;
  }
  try {
    return await request.json();
  } catch {
    return {};
  }
}

export default {
  async fetch(request, env = {}, ctx = {}) {
    try {
      const url = new URL(request.url);
      const { pathname } = url;
      const method = (request.method || 'GET').toUpperCase();

      if (method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      // 1. Serve stored product images (/api/images/:id) with Cloudflare Edge Cache headers
      if (pathname.startsWith('/api/images/')) {
        const key = pathname.replace('/api/images/', '');
        return serveStoredImage(key, env);
      }

      // 2. Health & Platform Configuration Endpoint
      if (pathname === '/api/health' && method === 'GET') {
        const dbStatus = await getDbStatus(env);
        const storageProvider = getActiveStorageProvider(env);
        return jsonResponse({
          ok: true,
          platform: 'Cloudflare Workers + Cloud MongoDB Inventory Platform',
          database: dbStatus,
          imageStorage: {
            activeProvider: storageProvider,
            githubRepo: env.GITHUB_REPO || '(not configured yet — set GITHUB_TOKEN & GITHUB_REPO)',
            recommendedFreeOptions: [
              {
                name: 'GitHub Repository + jsDelivr Global CDN (Primary — 100% Free, No Credit Card)',
                freeTier: 'Multi-GB free GitHub repository storage + Unlimited global CDN bandwidth via cdn.jsdelivr.net',
                why: 'Uploads compressed WebP product photos via GitHub Contents REST API (`PUT /repos/:owner/:repo/contents/product-images/:file`) and serves them globally via `https://cdn.jsdelivr.net/gh/<owner>/<repo>@main/product-images/<file>`.',
              },
              {
                name: 'Cloud MongoDB + Cloudflare Edge Cache (Automatic Local/Edge Fallback)',
                freeTier: '512 MB free on MongoDB Atlas M0 (~15,000+ WebP product photos), No Credit Card Required',
                why: 'Used automatically when `GITHUB_TOKEN` & `GITHUB_REPO` are not yet set so image uploads work out-of-the-box.',
              },
            ],
          },
        });
      }

      // 3. Authentication Endpoints
      if (pathname === '/api/auth/login' && method === 'POST') {
        const body = await parseRequestBody(request);
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');

        if (!email || !password) {
          return jsonResponse({ error: 'Email and password are required.' }, 400);
        }

        const user = await findUserByEmail(env, email);
        if (!user) {
          return jsonResponse({ error: 'Invalid email or password.' }, 401);
        }

        const valid = await verifyPassword(password, user.passwordHash);
        if (!valid) {
          return jsonResponse({ error: 'Invalid email or password.' }, 401);
        }

        const token = await signJwt(
          { id: user.id, email: user.email, name: user.name, role: user.role },
          env.JWT_SECRET || 'default-inventory-secret-key'
        );

        await recordActivity(env, {
          action: 'USER_LOGIN',
          actorEmail: user.email,
          actorName: user.name,
          details: `User "${user.name}" (${user.email}) signed in.`,
        });

        return jsonResponse({
          token,
          user: { id: user.id, name: user.name, email: user.email, role: user.role },
        });
      }

      if (pathname === '/api/auth/register' && method === 'POST') {
        const body = await parseRequestBody(request);
        const name = String(body.name || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');

        if (!email || ! email.includes('@')) {
          return jsonResponse({ error: 'Please provide a valid email address.' }, 400);
        }
        if (!password || password.length < 6) {
          return jsonResponse(
            { error: 'Password must be at least 6 characters long.' },
            400
          );
        }

        const existing = await findUserByEmail(env, email);
        if (existing) {
          return jsonResponse(
            { error: 'An account with this email already exists.' },
            409
          );
        }

        const passwordHash = await hashPassword(password);
        const user = await createUser(env, {
          name: name || email.split('@')[0],
          email,
          passwordHash,
          role: 'admin',
        });

        const token = await signJwt(
          { id: user.id, email: user.email, name: user.name, role: user.role },
          env.JWT_SECRET || 'default-inventory-secret-key'
        );

        await recordActivity(env, {
          action: 'USER_REGISTERED',
          actorEmail: user.email,
          actorName: user.name,
          details: `New user "${user.name}" (${user.email}) registered an account.`,
        });

        return jsonResponse(
          {
            token,
            user: { id: user.id, name: user.name, email: user.email, role: user.role },
          },
          201
        );
      }

      if (pathname === '/api/auth/me' && method === 'GET') {
        const user = await getAuthUser(request, env);
        if (!user) {
          return jsonResponse({ error: 'Unauthorized' }, 401);
        }
        return jsonResponse({ user });
      }

      // 4. Standalone Image Upload Endpoint
      if (pathname === '/api/upload' && method === 'POST') {
        const user = await getAuthUser(request, env);
        if (!user) {
          return jsonResponse({ error: 'Authentication required to upload images.' }, 401);
        }
        const body = await parseRequestBody(request);
        const fileOrData = body.image || body.file || body.imageUrl;
        if (!fileOrData) {
          return jsonResponse({ error: 'No image data provided.' }, 400);
        }
        const uploaded = await uploadProductImage(fileOrData, env, url.origin);
        return jsonResponse(uploaded);
      }

      // 5. Products Collection Endpoints (GET all / POST create) — User Specific
      if (pathname === '/api/products' && method === 'GET') {
        const user = await getAuthUser(request, env);
        if (!user) {
          return jsonResponse({ error: 'Please sign in to view your inventory.' }, 401);
        }

        const search = url.searchParams.get('search') || '';
        const status = url.searchParams.get('status') || '';
        const color = url.searchParams.get('color') || '';
        const size = url.searchParams.get('size') || '';

        const allProducts = await listProducts(env, { ownerEmail: user.email });
        const filteredProducts =
          search || status || color || size
            ? await listProducts(env, {
                ownerEmail: user.email,
                search,
                status,
                color,
                size,
              })
            : allProducts;

        const stats = {
          totalProducts: allProducts.length,
          totalUnits: allProducts.reduce((sum, p) => sum + (Number(p.quantity) || 0), 0),
          outOfStockCount: allProducts.filter((p) => Number(p.quantity) === 0).length,
          lowStockCount: allProducts.filter(
            (p) => Number(p.quantity) > 0 && Number(p.quantity) <= 5
          ).length,
          totalUnitsSold: allProducts.reduce(
            (sum, p) => sum + (Number(p.totalSold) || 0),
            0
          ),
        };

        return jsonResponse({
          products: filteredProducts,
          stats,
        });
      }

      if (pathname === '/api/products' && method === 'POST') {
        const user = await getAuthUser(request, env);
        if (!user) {
          return jsonResponse({ error: 'Please log in to add products.' }, 401);
        }

        const body = await parseRequestBody(request);
        const title = String(body.title || '').trim();
        const description = String(body.description || '').trim();
        const quantity =
          body.quantity !== undefined && body.quantity !== ''
            ? Math.max(0, Math.floor(Number(body.quantity)))
            : NaN;

        if (!title) {
          return jsonResponse({ error: 'Product title is required.' }, 400);
        }
        if (!description) {
          return jsonResponse({ error: 'Product description is required.' }, 400);
        }
        if (Number.isNaN(quantity) || quantity < 0) {
          return jsonResponse(
            { error: 'Valid non-negative quantity is required.' },
            400
          );
        }

        let imageUrl = '';
        let imageProvider = 'none';
        const rawImage = body.image || body.imageData || body.imageUrl;
        if (rawImage) {
          const uploaded = await uploadProductImage(rawImage, env, url.origin);
          imageUrl = uploaded.url;
          imageProvider = uploaded.provider;
        }

        const product = await createProduct(
          env,
          {
            title,
            description,
            quantity,
            color: body.color || '',
            size: body.size || '',
            imageUrl,
            imageProvider,
          },
          user
        );

        return jsonResponse({ product }, 201);
      }

      // 6. Single Product Endpoints (/api/products/:id and /api/products/:id/sell)
      const sellMatch = pathname.match(/^\/api\/products\/([^/]+)\/sell$/);
      if (sellMatch && method === 'POST') {
        const user = await getAuthUser(request, env);
        if (!user) {
          return jsonResponse({ error: 'Please log in to mark products as sold.' }, 401);
        }
        const productId = decodeURIComponent(sellMatch[1]);
        const body = await parseRequestBody(request);
        const units = body.units ? Number(body.units) : 1;

        const result = await markProductAsSold(env, productId, units, user);
        if (result.error) {
          return jsonResponse(
            { error: result.error, product: result.product || null },
            result.status || 400
          );
        }
        return jsonResponse({ product: result.product });
      }

      const productMatch = pathname.match(/^\/api\/products\/([^/]+)$/);
      if (productMatch) {
        const productId = decodeURIComponent(productMatch[1]);

        if (method === 'GET') {
          const user = await getAuthUser(request, env);
          if (!user) {
            return jsonResponse({ error: 'Please sign in to view this product.' }, 401);
          }
          const product = await getProductById(env, productId, user.email);
          if (!product) {
            return jsonResponse({ error: 'Product not found in your account.' }, 404);
          }
          const activities = await listActivities(env, {
            ownerEmail: user.email,
            productId: product.id,
            limit: 50,
          });
          return jsonResponse({ product, activities });
        }

        if (method === 'PUT' || method === 'PATCH') {
          const user = await getAuthUser(request, env);
          if (!user) {
            return jsonResponse({ error: 'Please log in to update products.' }, 401);
          }

          const body = await parseRequestBody(request);
          const updates = {};

          if (body.title !== undefined) {
            if (!String(body.title).trim()) {
              return jsonResponse({ error: 'Product title cannot be empty.' }, 400);
            }
            updates.title = String(body.title).trim();
          }
          if (body.description !== undefined) {
            if (!String(body.description).trim()) {
              return jsonResponse({ error: 'Product description cannot be empty.' }, 400);
            }
            updates.description = String(body.description).trim();
          }
          if (body.quantity !== undefined && body.quantity !== '') {
            const qty = Math.floor(Number(body.quantity));
            if (Number.isNaN(qty) || qty < 0) {
              return jsonResponse({ error: 'Quantity must be 0 or greater.' }, 400);
            }
            updates.quantity = qty;
          }
          if (body.color !== undefined) updates.color = body.color;
          if (body.size !== undefined) updates.size = body.size;

          const rawImage = body.image || body.imageData || body.imageUrl;
          if (rawImage) {
            const uploaded = await uploadProductImage(rawImage, env, url.origin);
            updates.imageUrl = uploaded.url;
            updates.imageProvider = uploaded.provider;
          }

          const updated = await updateProduct(env, productId, updates, user);
          if (!updated) {
            return jsonResponse({ error: 'Product not found.' }, 404);
          }
          return jsonResponse({ product: updated });
        }

        if (method === 'DELETE') {
          const user = await getAuthUser(request, env);
          if (!user) {
            return jsonResponse({ error: 'Please log in to delete products.' }, 401);
          }
          const deleted = await deleteProduct(env, productId, user);
          if (!deleted) {
            return jsonResponse({ error: 'Product not found.' }, 404);
          }
          return jsonResponse({ deleted: true, product: deleted });
        }
      }

      // 7. Activity History Endpoint — User Specific
      if (pathname === '/api/activities' && method === 'GET') {
        const user = await getAuthUser(request, env);
        if (!user) {
          return jsonResponse({ error: 'Please sign in to view your activity history.' }, 401);
        }
        const productId = url.searchParams.get('productId') || null;
        const limit = Number(url.searchParams.get('limit') || 100);
        const activities = await listActivities(env, {
          ownerEmail: user.email,
          productId,
          limit,
        });
        return jsonResponse({ activities });
      }

      // 8. Static Assets & SPA Deep Link Fallback (delegated to Cloudflare Assets)
      if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
        try {
          const assetRes = await env.ASSETS.fetch(request);
          if (assetRes && assetRes.status !== 404) {
            return assetRes;
          }
          const indexUrl = new URL('/index.html', request.url);
          return await env.ASSETS.fetch(new Request(indexUrl, { method: 'GET' }));
        } catch (assetErr) {
          console.error('ASSETS fetch fallback error:', assetErr);
        }
      }

      return jsonResponse({ error: 'Not Found' }, 404);
    } catch (err) {
      console.error('Worker API Error:', err?.stack || err?.message || err);
      const status = Number(err?.status) || 500;
      return jsonResponse(
        {
          error: err?.message || 'Internal Server Error',
          stack: err?.stack || null,
        },
        status
      );
    }
  },
};

