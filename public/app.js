import { renderCode128Barcode, renderQrCodeSvg } from './codes.js';

// Application State
const state = {
  token: localStorage.getItem('inventory_auth_token') || null,
  user: JSON.parse(localStorage.getItem('inventory_auth_user') || 'null'),
  products: [],
  stats: { totalProducts: 0, totalUnits: 0, outOfStockCount: 0, totalUnitsSold: 0 },
  currentView: 'inventory',
  selectedProductId: null,
  editingProductId: null,
  deletingProductId: null,
  selectedImageDataUrl: '',
  authMode: 'login',
  cameraStream: null,
  scanInterval: null,
};

// =========================================================
// 1. MANDATORY DIALOG LIGHT-DISMISS FALLBACK (modern-web-guidance)
// =========================================================
function setupDialogFallbacks() {
  const dialogs = document.querySelectorAll('dialog');
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    dialogs.forEach((dialog) => {
      dialog.addEventListener('click', (event) => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        const isDialogContent =
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width;
        if (isDialogContent) return;
        dialog.close();
      });
    });
  }
}

// =========================================================
// 2. PERSISTENT TOAST NOTIFICATIONS (popover="manual")
// =========================================================
export function showToast(message, type = 'info') {
  const stack = document.getElementById('toastStack');
  if (!stack) return;

  const toastId = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const toast = document.createElement('div');
  toast.id = toastId;
  toast.setAttribute('popover', 'manual');
  toast.className = `toast-popover toast-${type}`;

  const icon =
    type === 'success'
      ? '✓'
      : type === 'error'
      ? '⚠'
      : 'ℹ';

  toast.innerHTML = `
    <span style="font-weight:800; color:${
      type === 'error' ? 'var(--danger)' : type === 'success' ? 'var(--success)' : 'var(--accent-primary)'
    }">${icon}</span>
    <span style="flex:1; font-size:0.88rem; font-weight:500;">${escapeHtml(message)}</span>
    <button type="button" class="btn-icon" popovertarget="${toastId}" popovertargetaction="hide" aria-label="Close notification">&times;</button>
  `;

  stack.appendChild(toast);

  try {
    if (typeof toast.showPopover === 'function') {
      toast.showPopover();
    } else {
      toast.classList.add(':popover-open');
      toast.style.display = 'flex';
    }
  } catch {
    toast.style.display = 'flex';
  }

  const closeBtn = toast.querySelector('button');
  const dismiss = () => {
    try {
      if (typeof toast.hidePopover === 'function') toast.hidePopover();
    } catch {
      // ignore
    }
    toast.remove();
  };
  closeBtn?.addEventListener('click', dismiss);
  setTimeout(dismiss, 4200);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function getProductDisplayUrl(productId) {
  return `${window.location.origin}/product/${encodeURIComponent(productId)}`;
}

// =========================================================
// 3. API HELPER
// =========================================================
async function apiFetch(path, options = {}, retryCount = 0) {
  const headers = {
    ...(options.headers || {}),
  };
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }

  const res = await fetch(path, {
    ...options,
    headers,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const method = (options.method || 'GET').toUpperCase();
    if ((res.status === 503 || res.status === 500) && method === 'GET' && retryCount < 2) {
      await new Promise((r) => setTimeout(r, 800 * (retryCount + 1)));
      return apiFetch(path, options, retryCount + 1);
    }
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// =========================================================
// 4. AUTHENTICATION FLOW
// =========================================================
function renderAuthStatus() {
  const container = document.getElementById('authStatusArea');
  const guestBanner = document.getElementById('guestBanner');
  if (!container) return;

  if (state.user && state.token) {
    guestBanner.hidden = true;
    container.innerHTML = `
      <span class="user-chip" title="Logged in as ${escapeHtml(state.user.email)}">
        ● ${escapeHtml(state.user.name || state.user.email)}
      </span>
      <button type="button" class="btn btn-sm btn-secondary" id="logoutBtn">Sign Out</button>
    `;
    document.getElementById('logoutBtn')?.addEventListener('click', () => {
      state.token = null;
      state.user = null;
      state.products = [];
      state.stats = { totalProducts: 0, totalUnits: 0, outOfStockCount: 0, totalUnitsSold: 0 };
      localStorage.removeItem('inventory_auth_token');
      localStorage.removeItem('inventory_auth_user');
      renderAuthStatus();
      switchTabView('inventory');
      loadProducts();
      showToast('Signed out.', 'info');
    });
  } else {
    guestBanner.hidden = false;
    container.innerHTML = `
      <button type="button" class="btn btn-secondary" id="openAuthBtn">Sign In</button>
    `;
    document.getElementById('openAuthBtn')?.addEventListener('click', () => openAuthModal('login'));
  }
}

function openAuthModal(mode = 'login') {
  state.authMode = mode;
  const dialog = document.getElementById('authDialog');
  const nameField = document.getElementById('authNameField');
  const titleEl = document.getElementById('authDialogTitle');
  const submitBtn = document.getElementById('submitAuthBtn');
  const tabLogin = document.getElementById('tabLoginMode');
  const tabRegister = document.getElementById('tabRegisterMode');
  const errorEl = document.getElementById('authFormError');

  errorEl.hidden = true;
  if (mode === 'register') {
    nameField.hidden = false;
    titleEl.textContent = 'Create Admin / User Account';
    submitBtn.textContent = 'Create Account';
    tabLogin.classList.remove('active');
    tabRegister.classList.add('active');
  } else {
    nameField.hidden = true;
    titleEl.textContent = 'Admin & User Sign In';
    submitBtn.textContent = 'Sign In';
    tabLogin.classList.add('active');
    tabRegister.classList.remove('active');
  }

  if (!dialog.open) dialog.showModal();
}

async function handleQuickDemoLogin() {
  try {
    const data = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@inventory.io', password: 'Admin@123' }),
    });
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem('inventory_auth_token', data.token);
    localStorage.setItem('inventory_auth_user', JSON.stringify(data.user));
    renderAuthStatus();
    await loadProducts();
    if (state.selectedProductId) {
      await openProductDetailView(state.selectedProductId, false);
    }
    showToast(`Signed in as ${data.user.name} (${data.user.email})`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// =========================================================
// 5. INVENTORY DASHBOARD & PRODUCT CARDS
// =========================================================
async function loadProducts() {
  if (!state.token || !state.user) {
    state.products = [];
    state.stats = { totalProducts: 0, totalUnits: 0, outOfStockCount: 0, totalUnitsSold: 0 };
    document.getElementById('statTotalProducts').textContent = '0';
    document.getElementById('statTotalUnits').textContent = '0';
    document.getElementById('statOutOfStock').textContent = '0';
    document.getElementById('statTotalSold').textContent = '0';
    renderProductsGrid();
    return;
  }

  const search = document.getElementById('searchInput')?.value.trim() || '';
  const checkedRadio = document.querySelector('input[name="statusFilter"]:checked');
  const status = checkedRadio ? checkedRadio.value : '';

  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (status) params.set('status', status);

  try {
    const data = await apiFetch(`/api/products?${params.toString()}`);
    state.products = data.products || [];
    state.stats = data.stats || state.stats;

    document.getElementById('statTotalProducts').textContent = state.stats.totalProducts;
    document.getElementById('statTotalUnits').textContent = state.stats.totalUnits;
    document.getElementById('statOutOfStock').textContent = state.stats.outOfStockCount;
    document.getElementById('statTotalSold').textContent = state.stats.totalUnitsSold;

    renderProductsGrid();
  } catch (err) {
    if (err.message.includes('sign in') || err.message.includes('401')) {
      state.token = null;
      state.user = null;
      localStorage.removeItem('inventory_auth_token');
      localStorage.removeItem('inventory_auth_user');
      renderAuthStatus();
    }
    renderProductsGrid();
  }
}

function getStockBadgeInfo(quantity) {
  const qty = Number(quantity) || 0;
  if (qty === 0) {
    return { label: '✕ Out of Stock', cls: 'out-of-stock' };
  }
  if (qty <= 5) {
    return { label: `⚡ Low Stock (${qty} left)`, cls: 'low-stock' };
  }
  return { label: `● In Stock (${qty})`, cls: 'in-stock' };
}

function renderProductsGrid() {
  const grid = document.getElementById('productsGrid');
  if (!grid) return;

  if (!state.token || !state.user) {
    grid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align:center; padding: 3.5rem 1.25rem; background: var(--bg-surface); border: 1px dashed var(--border-color); border-radius: var(--radius-lg);">
        <h3 style="margin:0 0 0.5rem;">Sign In Required to View Your Inventory</h3>
        <p style="margin:0 0 1.25rem; color: var(--text-muted);">
          Each account has its own private product inventory and activity history. Please sign in or create an account to view and manage your products.
        </p>
        <div style="display:flex; justify-content:center; gap:0.65rem; flex-wrap:wrap;">
          <button type="button" class="btn btn-primary" id="gridSignInBtn">Sign In to Your Account</button>
          <button type="button" class="btn btn-secondary" id="gridRegisterBtn">Create New Account</button>
        </div>
      </div>
    `;
    document.getElementById('gridSignInBtn')?.addEventListener('click', () => openAuthModal('login'));
    document.getElementById('gridRegisterBtn')?.addEventListener('click', () => openAuthModal('register'));
    return;
  }

  if (state.products.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align:center; padding: 3rem 1rem; background: var(--bg-surface); border: 1px dashed var(--border-color); border-radius: var(--radius-lg);">
        <h3 style="margin:0 0 0.4rem;">No products in your account yet</h3>
        <p style="margin:0 0 1rem; color: var(--text-muted);">Add your first product to generate a scannable QR code and barcode.</p>
        <button type="button" class="btn btn-primary" id="emptyStateAddBtn">+ Add First Product</button>
      </div>
    `;
    document.getElementById('emptyStateAddBtn')?.addEventListener('click', () => openProductModal());
    return;
  }

  grid.innerHTML = state.products
    .map((p) => {
      const badge = getStockBadgeInfo(p.quantity);
      const isOut = Number(p.quantity) === 0;
      return `
        <article class="product-card ${isOut ? 'is-out-of-stock' : ''}" data-product-id="${escapeHtml(p.id)}">
          <div class="product-media" data-action="view" data-id="${escapeHtml(p.id)}" title="Open Product Display Page">
            ${
              p.imageUrl
                ? `<img src="${escapeHtml(p.imageUrl)}" alt="${escapeHtml(p.title)}" loading="lazy">`
                : `<div class="product-placeholder-img">
                     <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                     <span>No Picture</span>
                   </div>`
            }
            <span class="stock-badge ${badge.cls}">${badge.label}</span>
            <span class="sku-chip">${escapeHtml(p.id)}</span>
          </div>

          <div class="product-body">
            <a class="product-title-link" data-action="view" data-id="${escapeHtml(p.id)}">
              ${escapeHtml(p.title)}
            </a>
            <p class="product-desc">${escapeHtml(p.description)}</p>

            <div class="product-attributes">
              ${p.color ? `<span class="attr-tag">Color: <strong>${escapeHtml(p.color)}</strong></span>` : ''}
              ${p.size ? `<span class="attr-tag">Size: <strong>${escapeHtml(p.size)}</strong></span>` : ''}
              <span class="attr-tag">Sold: <strong>${Number(p.totalSold) || 0}</strong></span>
            </div>

            <div class="product-qty-row">
              <span>Available Quantity:</span>
              <span class="qty-number" style="color: ${isOut ? 'var(--danger)' : 'var(--text-primary)'}">
                ${isOut ? '0 (Out of Stock)' : `${p.quantity} units`}
              </span>
            </div>

            <div class="product-actions">
              <button
                type="button"
                class="btn btn-sm ${isOut ? 'btn-secondary' : 'btn-success'}"
                data-action="sell"
                data-id="${escapeHtml(p.id)}"
                ${isOut ? 'disabled' : ''}
                title="${isOut ? 'Product is Out of Stock (Quantity = 0)' : 'Reduce quantity by 1 and record sale'}"
              >
                ${isOut ? 'Out of Stock' : 'Mark as Sold (-1)'}
              </button>

              <button
                type="button"
                class="btn btn-sm btn-secondary"
                data-action="qr"
                data-id="${escapeHtml(p.id)}"
                title="View & Print Barcode / QR Code"
              >
                QR / Barcode
              </button>

              <button
                type="button"
                class="btn btn-sm btn-secondary"
                data-action="edit"
                data-id="${escapeHtml(p.id)}"
                title="Edit product"
              >
                Edit
              </button>

              <button
                type="button"
                class="btn btn-sm btn-danger"
                data-action="delete"
                data-id="${escapeHtml(p.id)}"
                title="Delete product"
              >
                Delete
              </button>
            </div>
          </div>
        </article>
      `;
    })
    .join('');
}

// =========================================================
// 6. DEDICATED PRODUCT DISPLAY PAGE (OPENED BY QR SCAN OR CLICK)
// =========================================================
async function openProductDetailView(productId, fromQrScan = false) {
  if (!state.token || !state.user) {
    state.selectedProductId = productId;
    showToast('Please sign in to view this product.', 'info');
    openAuthModal('login');
    return;
  }

  try {
    const data = await apiFetch(`/api/products/${encodeURIComponent(productId)}`);
    const product = data.product;
    const activities = data.activities || [];

    state.selectedProductId = product.id;
    switchTabView('product-detail');

    const scanBadge = document.getElementById('detailScanIndicator');
    if (scanBadge) scanBadge.hidden = !fromQrScan;

    // Update browser URL so QR code link and browser history match
    const targetPath = `/product/${encodeURIComponent(product.id)}`;
    if (window.location.pathname !== targetPath) {
      window.history.pushState({ productId: product.id }, '', targetPath);
    }

    const badge = getStockBadgeInfo(product.quantity);
    const isOut = Number(product.quantity) === 0;
    const productUrl = getProductDisplayUrl(product.id);

    const container = document.getElementById('productDetailContent');
    container.innerHTML = `
      <div class="detail-grid">
        <div>
          <div class="detail-image-box">
            ${
              product.imageUrl
                ? `<img src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.title)}">`
                : `<div class="product-placeholder-img" style="padding:3rem;">No Product Image Uploaded</div>`
            }
          </div>

          <div class="detail-codes-panel">
            <strong style="display:block; margin-bottom:0.65rem; font-size:0.9rem;">
              Scannable Product QR Code &amp; Code-128 Barcode
            </strong>
            <div class="codes-showcase">
              <div class="qr-box">
                <div id="detailQrSvgBox" class="qr-svg-wrapper"></div>
                <span class="code-caption">Scan to open this page</span>
              </div>
              <div class="barcode-box">
                <svg id="detailBarcodeSvgBox" class="barcode-svg"></svg>
                <span class="code-caption">SKU Barcode</span>
              </div>
            </div>
            <div style="margin-top:0.5rem; font-size:0.76rem; color:#475569; word-break:break-all;">
              QR Target URL: <a href="${escapeHtml(productUrl)}" style="color:#2563eb;">${escapeHtml(productUrl)}</a>
            </div>
          </div>
        </div>

        <div class="detail-info">
          <div style="display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;">
            <span class="stock-badge ${badge.cls}" style="position:static;">${badge.label}</span>
            <span style="font-family:monospace; font-size:0.85rem; color:var(--text-muted);">
              SKU / ID: ${escapeHtml(product.id)}
            </span>
          </div>

          <h1>${escapeHtml(product.title)}</h1>
          <p style="font-size:1rem; color:var(--text-secondary); margin:0.5rem 0 1.25rem;">
            ${escapeHtml(product.description)}
          </p>

          <div class="detail-meta-grid">
            <div class="detail-meta-item">
              <span>Current Quantity</span>
              <strong style="color:${isOut ? 'var(--danger)' : 'var(--text-primary)'}">
                ${isOut ? '0 (Out of Stock)' : `${product.quantity} units`}
              </strong>
            </div>
            <div class="detail-meta-item">
              <span>Stock Status</span>
              <strong style="color:${isOut ? 'var(--danger)' : 'var(--success)'}">
                ${escapeHtml(product.status)}
              </strong>
            </div>
            <div class="detail-meta-item">
              <span>Color</span>
              <strong>${escapeHtml(product.color || 'Not specified')}</strong>
            </div>
            <div class="detail-meta-item">
              <span>Size</span>
              <strong>${escapeHtml(product.size || 'Not specified')}</strong>
            </div>
            <div class="detail-meta-item">
              <span>Total Sold</span>
              <strong>${Number(product.totalSold) || 0} units</strong>
            </div>
            <div class="detail-meta-item">
              <span>Image Storage</span>
              <strong>${escapeHtml(product.imageProvider || 'inline-mongodb')}</strong>
            </div>
          </div>

          <div class="detail-action-bar">
            <button
              type="button"
              class="btn ${isOut ? 'btn-secondary' : 'btn-success'}"
              id="detailSellBtn"
              ${isOut ? 'disabled' : ''}
            >
              ${isOut ? '✕ Out of Stock (Quantity = 0)' : '✓ Mark as Sold (-1 Quantity)'}
            </button>

            <button type="button" class="btn btn-secondary" id="detailShowQrModalBtn">
              Print / Download QR &amp; Barcode Label
            </button>

            <button type="button" class="btn btn-secondary" id="detailEditBtn">
              Edit Product Data
            </button>

            <button type="button" class="btn btn-danger" id="detailDeleteBtn">
              Delete Product
            </button>
          </div>

          <div>
            <h3 style="margin:0 0 0.75rem; font-size:1.05rem;">Product Activity History</h3>
            <div class="activity-timeline">
              ${
                activities.length === 0
                  ? `<p class="field-hint">No activity recorded for this product yet.</p>`
                  : activities.map(renderActivityRowHtml).join('')
              }
            </div>
          </div>
        </div>
      </div>
    `;

    renderQrCodeSvg(document.getElementById('detailQrSvgBox'), productUrl);
    renderCode128Barcode(document.getElementById('detailBarcodeSvgBox'), product.id);

    document.getElementById('detailSellBtn')?.addEventListener('click', () => handleMarkAsSold(product.id));
    document.getElementById('detailShowQrModalBtn')?.addEventListener('click', () => openBarcodeModal(product));
    document.getElementById('detailEditBtn')?.addEventListener('click', () => openProductModal(product));
    document.getElementById('detailDeleteBtn')?.addEventListener('click', () => openDeleteModal(product));
  } catch (err) {
    showToast(`Could not load product "${productId}": ${err.message}`, 'error');
    switchTabView('inventory');
  }
}

// =========================================================
// 7. MARK AS SOLD (-1 QUANTITY & OUT OF STOCK AT 0)
// =========================================================
async function handleMarkAsSold(productId) {
  if (!state.token) {
    showToast('Please sign in first to mark products as sold.', 'error');
    openAuthModal('login');
    return;
  }

  try {
    const data = await apiFetch(`/api/products/${encodeURIComponent(productId)}/sell`, {
      method: 'POST',
      body: JSON.stringify({ units: 1 }),
    });
    const updated = data.product;
    if (updated.quantity === 0) {
      showToast(
        `"${updated.title}" marked as sold! Quantity is now 0 — status set to Out of Stock.`,
        'info'
      );
    } else {
      showToast(
        `Marked 1 unit of "${updated.title}" as sold (${updated.quantity} remaining).`,
        'success'
      );
    }

    await loadProducts();
    if (state.currentView === 'product-detail' && state.selectedProductId === productId) {
      await openProductDetailView(productId, false);
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// =========================================================
// 8. ADD / EDIT PRODUCT + IMAGE OPTIMIZATION
// =========================================================
async function compressImageToWebpDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read image file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => resolve(reader.result);
      img.onload = () => {
        const maxDim = 900;
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        const webpUrl = canvas.toDataURL('image/webp', 0.82);
        resolve(webpUrl);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function openProductModal(product = null) {
  if (!state.token) {
    showToast('Please sign in as Admin to add or edit products.', 'error');
    openAuthModal('login');
    return;
  }

  const dialog = document.getElementById('productDialog');
  const titleEl = document.getElementById('productDialogTitle');
  const submitBtn = document.getElementById('submitProductBtn');
  const errorBanner = document.getElementById('productFormError');
  const previewWrapper = document.getElementById('imagePreviewWrapper');
  const previewImg = document.getElementById('imagePreviewEl');

  errorBanner.hidden = true;
  document.getElementById('productImageInput').value = '';
  const driveUrlInput = document.getElementById('productDriveUrlInput');
  if (driveUrlInput) driveUrlInput.value = '';

  if (product) {
    state.editingProductId = product.id;
    titleEl.textContent = `Edit Product (${product.id})`;
    submitBtn.textContent = 'Save Product Changes';
    document.getElementById('productIdInput').value = product.id;
    document.getElementById('productTitleInput').value = product.title || '';
    document.getElementById('productDescInput').value = product.description || '';
    document.getElementById('productQtyInput').value = product.quantity ?? 0;
    document.getElementById('productColorInput').value = product.color || '';
    document.getElementById('productSizeInput').value = product.size || '';
    state.selectedImageDataUrl = product.imageUrl || '';

    if (product.imageUrl) {
      previewImg.src = product.imageUrl;
      previewWrapper.hidden = false;
    } else {
      previewWrapper.hidden = true;
    }
  } else {
    state.editingProductId = null;
    titleEl.textContent = 'Add New Product';
    submitBtn.textContent = 'Add Product & Generate QR / Barcode';
    document.getElementById('productIdInput').value = '';
    document.getElementById('productTitleInput').value = '';
    document.getElementById('productDescInput').value = '';
    document.getElementById('productQtyInput').value = '10';
    document.getElementById('productColorInput').value = '';
    document.getElementById('productSizeInput').value = '';
    state.selectedImageDataUrl = '';
    previewWrapper.hidden = true;
  }

  if (!dialog.open) dialog.showModal();
}

// =========================================================
// 9. BARCODE & QR CODE MODAL + DOWNLOAD PNG
// =========================================================
function openBarcodeModal(product) {
  const dialog = document.getElementById('barcodeDialog');
  const productUrl = getProductDisplayUrl(product.id);

  document.getElementById('labelProductTitle').textContent = product.title;
  document.getElementById('labelProductMeta').textContent = `SKU: ${product.id} ${
    product.color ? `• ${product.color}` : ''
  } ${product.size ? `• ${product.size}` : ''}`;
  document.getElementById('barcodeSkuText').textContent = product.id;

  const linkEl = document.getElementById('labelDirectLink');
  linkEl.href = productUrl;
  linkEl.textContent = productUrl;
  linkEl.onclick = (e) => {
    e.preventDefault();
    dialog.close();
    openProductDetailView(product.id, true);
  };

  renderQrCodeSvg(document.getElementById('qrCodeContainer'), productUrl);
  renderCode128Barcode(document.getElementById('barcodeSvg'), product.id);

  const openPageBtn = document.getElementById('openProductFromLabelBtn');
  openPageBtn.onclick = () => {
    dialog.close();
    openProductDetailView(product.id, true);
  };

  const downloadBtn = document.getElementById('downloadQrBtn');
  downloadBtn.onclick = () => downloadQrAsPng(product);

  if (!dialog.open) dialog.showModal();
}

function downloadQrAsPng(product) {
  const svgEl = document.querySelector('#qrCodeContainer svg');
  if (!svgEl) return;
  const svgData = new XMLSerializer().serializeToString(svgEl);
  const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 512, 512);
    ctx.drawImage(img, 0, 0, 512, 512);
    URL.revokeObjectURL(url);

    const a = document.createElement('a');
    a.download = `${product.id}-qrcode.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
  };
  img.src = url;
}

// =========================================================
// 10. DELETE PRODUCT CONFIRMATION
// =========================================================
function openDeleteModal(product) {
  if (!state.token) {
    showToast('Please sign in to delete products.', 'error');
    openAuthModal('login');
    return;
  }
  state.deletingProductId = product.id;
  document.getElementById('deleteDialogMessage').textContent =
    `Are you sure you want to delete "${product.title}" (${product.id})? This will be logged in Activity History.`;
  const dialog = document.getElementById('deleteConfirmDialog');
  if (!dialog.open) dialog.showModal();
}

// =========================================================
// 11. QR & BARCODE SCANNER (CAMERA + USB/MANUAL INPUT)
// =========================================================
function resolveScannedValueToProductId(rawInput) {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) return null;

  // Check if it's a URL containing /product/<id> or ?product=<id>
  try {
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('/')) {
      const parsed = new URL(trimmed, window.location.origin);
      const match = parsed.pathname.match(/\/product\/([^/]+)/);
      if (match) return decodeURIComponent(match[1]);
      if (parsed.searchParams.get('product')) return parsed.searchParams.get('product');
    }
  } catch {
    // Fallback to raw code
  }
  return trimmed.toUpperCase();
}

async function handleScannedCode(rawCode) {
  const productId = resolveScannedValueToProductId(rawCode);
  if (!productId) return;

  stopCameraScanner();
  const scannerDialog = document.getElementById('scannerDialog');
  if (scannerDialog?.open) scannerDialog.close();

  showToast(`Scanned code: ${productId} — opening Product Display Page...`, 'success');
  await openProductDetailView(productId, true);
}

async function startCameraScanner() {
  const video = document.getElementById('scannerVideo');
  const startBtn = document.getElementById('startCameraScanBtn');
  const stopBtn = document.getElementById('stopCameraScanBtn');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment' },
    });
    state.cameraStream = stream;
    video.srcObject = stream;
    video.hidden = false;
    await video.play();
    startBtn.hidden = true;
    stopBtn.hidden = false;

    if ('BarcodeDetector' in window) {
      const detector = new window.BarcodeDetector({
        formats: ['qr_code', 'code_128', 'ean_13', 'code_39'],
      });
      state.scanInterval = setInterval(async () => {
        try {
          const barcodes = await detector.detect(video);
          if (barcodes.length > 0 && barcodes[0].rawValue) {
            handleScannedCode(barcodes[0].rawValue);
          }
        } catch {
          // ignore frame error
        }
      }, 350);
    } else {
      showToast(
        'Camera active! Tip: Enter or scan the SKU below if your browser lacks native BarcodeDetector.',
        'info'
      );
    }
  } catch (err) {
    showToast(`Camera access unavailable (${err.message}). Use the SKU/URL input below.`, 'info');
  }
}

function stopCameraScanner() {
  if (state.scanInterval) {
    clearInterval(state.scanInterval);
    state.scanInterval = null;
  }
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((t) => t.stop());
    state.cameraStream = null;
  }
  const video = document.getElementById('scannerVideo');
  const startBtn = document.getElementById('startCameraScanBtn');
  const stopBtn = document.getElementById('stopCameraScanBtn');
  if (video) video.hidden = true;
  if (startBtn) startBtn.hidden = false;
  if (stopBtn) stopBtn.hidden = true;
}

// =========================================================
// 12. ACTIVITY HISTORY & STORAGE INFO VIEWS
// =========================================================
function renderActivityRowHtml(a) {
  return `
    <div class="activity-item">
      <div>
        <span class="activity-badge ${escapeHtml(a.action)}">${escapeHtml(a.action.replace(/_/g, ' '))}</span>
        <strong>${escapeHtml(a.details)}</strong>
        ${
          a.productId
            ? `<div class="activity-meta" style="margin-top:0.25rem;">
                 Product SKU: <a href="/product/${escapeHtml(a.productId)}" data-product-link="${escapeHtml(a.productId)}" style="color:var(--accent-primary);">${escapeHtml(a.productId)}</a>
                 ${
                   a.quantityBefore !== null && a.quantityAfter !== null
                     ? ` • Quantity: ${a.quantityBefore} &rarr; <strong>${a.quantityAfter}</strong>`
                     : ''
                 }
               </div>`
            : ''
        }
      </div>
      <div class="activity-meta">
        <div>By <strong>${escapeHtml(a.actorName || a.actorEmail)}</strong></div>
        <div>${formatDate(a.timestamp)}</div>
      </div>
    </div>
  `;
}

async function loadActivityHistory() {
  const container = document.getElementById('activityTimeline');
  if (!container) return;
  if (!state.token || !state.user) {
    container.innerHTML = `<p class="field-hint">Please sign in to view your account's activity history.</p>`;
    return;
  }
  const data = await apiFetch('/api/activities?limit=100');
  const activities = data.activities || [];

  if (activities.length === 0) {
    container.innerHTML = `<p class="field-hint">No activities recorded in your account yet.</p>`;
    return;
  }
  container.innerHTML = activities.map(renderActivityRowHtml).join('');
}

// =========================================================
// 13. VIEW NAVIGATION & EVENT LISTENERS
// =========================================================
function switchTabView(viewName) {
  state.currentView = viewName;
  document.getElementById('viewInventory').hidden = viewName !== 'inventory';
  document.getElementById('viewProductDetail').hidden = viewName !== 'product-detail';
  document.getElementById('viewActivity').hidden = viewName !== 'activity';

  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });

  if (viewName === 'activity') loadActivityHistory();
}

function bindEvents() {
  setupDialogFallbacks();

  // Top navigation tabs
  document.querySelectorAll('.nav-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (window.location.pathname !== '/') {
        window.history.pushState({}, '', '/');
      }
      switchTabView(btn.dataset.view);
    });
  });

  document.getElementById('navHomeLink')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.history.pushState({}, '', '/');
    switchTabView('inventory');
  });

  document.getElementById('backToInventoryBtn')?.addEventListener('click', () => {
    window.history.pushState({}, '', '/');
    switchTabView('inventory');
    loadProducts();
  });

  // Search & Status Filter
  const filterForm = document.getElementById('filterForm');
  filterForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    loadProducts();
  });
  document.getElementById('searchInput')?.addEventListener('input', () => loadProducts());
  document.querySelectorAll('input[name="statusFilter"]').forEach((radio) => {
    radio.addEventListener('change', () => loadProducts());
  });

  // Product Grid delegated actions
  document.getElementById('productsGrid')?.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    const id = target.dataset.id;
    const product = state.products.find((p) => p.id === id);
    if (!id) return;

    if (action === 'view') {
      openProductDetailView(id, false);
    } else if (action === 'sell') {
      handleMarkAsSold(id);
    } else if (action === 'qr' && product) {
      openBarcodeModal(product);
    } else if (action === 'edit' && product) {
      openProductModal(product);
    } else if (action === 'delete' && product) {
      openDeleteModal(product);
    }
  });

  // Activity timeline product links
  document.getElementById('activityTimeline')?.addEventListener('click', (e) => {
    const link = e.target.closest('[data-product-link]');
    if (!link) return;
    e.preventDefault();
    openProductDetailView(link.dataset.productLink, false);
  });

  // Add Product modal triggers
  document.getElementById('openAddProductBtn')?.addEventListener('click', () => openProductModal(null));
  document.getElementById('closeProductDialogBtn')?.addEventListener('click', () =>
    document.getElementById('productDialog').close()
  );
  document.getElementById('cancelProductDialogBtn')?.addEventListener('click', () =>
    document.getElementById('productDialog').close()
  );

  // Image file selection & preview
  document.getElementById('productImageInput')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const compressedDataUrl = await compressImageToWebpDataUrl(file);
      state.selectedImageDataUrl = compressedDataUrl;
      document.getElementById('imagePreviewEl').src = compressedDataUrl;
      document.getElementById('imagePreviewWrapper').hidden = false;
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Google Drive link / Image URL input & live preview
  document.getElementById('productDriveUrlInput')?.addEventListener('input', (e) => {
    const raw = e.target.value.trim();
    if (!raw) return;
    const match =
      raw.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/) ||
      raw.match(/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/) ||
      raw.match(/drive\.google\.com\/uc\?.*id=([a-zA-Z0-9_-]+)/);
    const resolvedUrl = match
      ? `https://lh3.googleusercontent.com/d/${match[1]}=w1000`
      : raw;
    state.selectedImageDataUrl = raw;
    document.getElementById('imagePreviewEl').src = resolvedUrl;
    document.getElementById('imagePreviewWrapper').hidden = false;
  });

  document.getElementById('clearImageBtn')?.addEventListener('click', () => {
    state.selectedImageDataUrl = '';
    document.getElementById('productImageInput').value = '';
    const driveUrlInput = document.getElementById('productDriveUrlInput');
    if (driveUrlInput) driveUrlInput.value = '';
    document.getElementById('imagePreviewWrapper').hidden = true;
  });

  // Submit Add / Edit Product Form
  document.getElementById('productForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const errorBanner = document.getElementById('productFormError');
    const submitBtn = document.getElementById('submitProductBtn');

    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    errorBanner.hidden = true;
    submitBtn.disabled = true; // Disable after valid submission per modern-web-guidance

    const payload = {
      title: document.getElementById('productTitleInput').value.trim(),
      description: document.getElementById('productDescInput').value.trim(),
      quantity: Number(document.getElementById('productQtyInput').value),
      color: document.getElementById('productColorInput').value.trim(),
      size: document.getElementById('productSizeInput').value.trim(),
      imageData: state.selectedImageDataUrl,
    };

    try {
      if (state.editingProductId) {
        const res = await apiFetch(`/api/products/${encodeURIComponent(state.editingProductId)}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        document.getElementById('productDialog').close();
        showToast(`Updated "${res.product.title}".`, 'success');
        await loadProducts();
        if (state.currentView === 'product-detail') {
          await openProductDetailView(res.product.id, false);
        }
      } else {
        const res = await apiFetch('/api/products', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        document.getElementById('productDialog').close();
        showToast(
          `Added "${res.product.title}" and generated QR Code & Barcode!`,
          'success'
        );
        await loadProducts();
        // Automatically show generated Barcode / QR Code modal right after adding product!
        openBarcodeModal(res.product);
      }
    } catch (err) {
      errorBanner.textContent = err.message;
      errorBanner.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });

  // Barcode modal buttons
  document.getElementById('closeBarcodeDialogBtn')?.addEventListener('click', () =>
    document.getElementById('barcodeDialog').close()
  );
  document.getElementById('printLabelBtn')?.addEventListener('click', () => window.print());

  // Scanner modal buttons
  document.getElementById('openScannerBtn')?.addEventListener('click', () => {
    const dialog = document.getElementById('scannerDialog');
    if (!dialog.open) dialog.showModal();
  });
  document.getElementById('closeScannerDialogBtn')?.addEventListener('click', () => {
    stopCameraScanner();
    document.getElementById('scannerDialog').close();
  });
  document.getElementById('scannerDialog')?.addEventListener('close', stopCameraScanner);
  document.getElementById('startCameraScanBtn')?.addEventListener('click', startCameraScanner);
  document.getElementById('stopCameraScanBtn')?.addEventListener('click', stopCameraScanner);

  document.getElementById('manualScanForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = document.getElementById('manualScanInput').value;
    handleScannedCode(val);
  });

  // Auth modal & quick demo login
  document.getElementById('quickDemoLoginBtn')?.addEventListener('click', handleQuickDemoLogin);
  document.getElementById('bannerLoginBtn')?.addEventListener('click', () => openAuthModal('login'));
  document.getElementById('closeAuthDialogBtn')?.addEventListener('click', () =>
    document.getElementById('authDialog').close()
  );
  document.getElementById('cancelAuthDialogBtn')?.addEventListener('click', () =>
    document.getElementById('authDialog').close()
  );
  document.getElementById('tabLoginMode')?.addEventListener('click', () => openAuthModal('login'));
  document.getElementById('tabRegisterMode')?.addEventListener('click', () =>
    openAuthModal('register')
  );

  document.getElementById('authForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const submitBtn = document.getElementById('submitAuthBtn');
    const errorEl = document.getElementById('authFormError');
    errorEl.hidden = true;
    submitBtn.disabled = true;

    const endpoint = state.authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
    const body = {
      name: document.getElementById('authNameInput').value.trim(),
      email: document.getElementById('authEmailInput').value.trim(),
      password: document.getElementById('authPasswordInput').value,
    };

    try {
      const data = await apiFetch(endpoint, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      state.token = data.token;
      state.user = data.user;
      localStorage.setItem('inventory_auth_token', data.token);
      localStorage.setItem('inventory_auth_user', JSON.stringify(data.user));
      document.getElementById('authDialog').close();
      renderAuthStatus();
      await loadProducts();
      if (state.currentView === 'activity') {
        await loadActivityHistory();
      } else if (state.selectedProductId) {
        await openProductDetailView(state.selectedProductId, false);
      }
      showToast(`Welcome, ${data.user.name}!`, 'success');
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });

  // Delete confirmation modal
  document.getElementById('closeDeleteDialogBtn')?.addEventListener('click', () =>
    document.getElementById('deleteConfirmDialog').close()
  );
  document.getElementById('cancelDeleteBtn')?.addEventListener('click', () =>
    document.getElementById('deleteConfirmDialog').close()
  );
  document.getElementById('confirmDeleteBtn')?.addEventListener('click', async () => {
    if (!state.deletingProductId) return;
    const btn = document.getElementById('confirmDeleteBtn');
    btn.disabled = true;
    try {
      const res = await apiFetch(
        `/api/products/${encodeURIComponent(state.deletingProductId)}`,
        { method: 'DELETE' }
      );
      document.getElementById('deleteConfirmDialog').close();
      showToast(`Deleted "${res.product.title}".`, 'info');
      window.history.pushState({}, '', '/');
      switchTabView('inventory');
      await loadProducts();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('refreshActivityBtn')?.addEventListener('click', loadActivityHistory);

  // Browser back/forward navigation support for QR product links
  window.addEventListener('popstate', () => {
    checkDeepLinkRoute();
  });
}

async function checkDeepLinkRoute() {
  const pathMatch = window.location.pathname.match(/^\/product\/([^/]+)/);
  const queryProduct = new URLSearchParams(window.location.search).get('product');
  const targetProductId = pathMatch
    ? decodeURIComponent(pathMatch[1])
    : queryProduct;

  if (targetProductId) {
    await openProductDetailView(targetProductId, true);
  } else {
    switchTabView('inventory');
  }
}

// Initialize App
(async function init() {
  bindEvents();
  renderAuthStatus();
  await loadProducts();
  await checkDeepLinkRoute();
})();

