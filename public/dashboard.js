const TOKEN_STORAGE = 'waLeadToken';

let token = null;
let currentUser = null; // { email, role, userId }
let allChats = {};
let currentSettings = { staleDays: 3, closingLabels: [], manualClosing: {} };
let selectedIds = new Set();
let allProducts = [];
let editingProductId = null;
const KONTAK_PAGE_SIZE = 10;
let kontakPage = 1;
let allOrders = [];
const ORDERS_PAGE_SIZE = 10;
let ordersPage = 1;
let allPreOrders = [];
const PREORDERS_PAGE_SIZE = 10;
let preOrdersPage = 1;
let selectedOrderIds = new Set();
let selectedPreOrderIds = new Set();
let allUsersMini = [];

const el = (id) => document.getElementById(id);

// Dashboard's filters (date range, Akun WA, Produk, CS) are independent of
// Kontak's own filter+search bar - Dashboard's numbers come from the server
// (GET /api/dashboard/stats, aggregated across Chat/Order/PreOrder), Kontak's
// table is still sliced client-side from the already-loaded chat list.
const KONTAK_IDS = { owner: 'filterOwner', mode: 'filterMode', single: 'filterSingle', from: 'filterFrom', to: 'filterTo' };

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

async function apiGet(path) {
  const res = await fetch(path, { headers: authHeaders() });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function apiPut(path, body) {
  const res = await fetch(path, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function apiDelete(path) {
  const res = await fetch(path, { method: 'DELETE', headers: authHeaders() });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function apiUploadFile(path, file) {
  const formData = new FormData();
  formData.append('file', file);
  // No Content-Type header here - the browser sets the multipart boundary
  // itself, setting it manually breaks the upload.
  const res = await fetch(path, { method: 'POST', headers: authHeaders(), body: formData });
  if (res.status === 401) throw new Error('unauthorized');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function handleApiError(e, fallbackMessage) {
  if (e && e.message === 'unauthorized') {
    showLoginScreen('Sesi berakhir, silakan masuk lagi.');
    return;
  }
  window.alert(fallbackMessage || String(e));
}

function leadDateExact(chat) {
  return chat.firstMessageDate || null;
}

function isClosing(chat) {
  // manualClosing lives on the chat record itself, not in settings - two
  // devices/accounts marking different chats stay additive (upsert by id)
  // instead of one device's whole settings push wiping another's marks.
  // The settings.manualClosing[id] check is a fallback for marks set before
  // this moved.
  const byLabel = (chat.labels || []).some((l) => (currentSettings.closingLabels || []).includes(l));
  const manual = chat.manualClosing === true || (currentSettings.manualClosing && currentSettings.manualClosing[chat.id] === true);
  return byLabel || manual;
}

function matchesDateFilter(chat, filter) {
  if (filter.mode === 'no-date') return !leadDateExact(chat);

  if (filter.mode === 'single' || filter.mode === 'range') {
    const leadDate = leadDateExact(chat);
    if (!leadDate) return false;
    const t = new Date(leadDate).getTime();
    const from = filter.mode === 'single' ? filter.single : filter.from;
    const to = filter.mode === 'single' ? filter.single : filter.to;
    if (from && t < new Date(`${from}T00:00:00`).getTime()) return false;
    if (to && t > new Date(`${to}T00:00:00`).getTime() + 24 * 60 * 60 * 1000 - 1) return false;
    return true;
  }

  return true; // 'all'
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function readFilterState(ids) {
  return {
    owner: el(ids.owner).value,
    mode: el(ids.mode).value,
    single: el(ids.single).value,
    from: el(ids.from).value,
    to: el(ids.to).value,
  };
}

function syncFilterVisibility(ids, wrapIds) {
  const mode = el(ids.mode).value;
  el(wrapIds.single).style.display = mode === 'single' ? 'flex' : 'none';
  el(wrapIds.range).style.display = mode === 'range' ? 'flex' : 'none';
}

function populateOwnerSelect(select) {
  const owners = Array.from(new Set(Object.values(allChats).map((c) => c.ownerNumber).filter(Boolean))).sort();
  const previousValue = select.value || 'all';
  select.innerHTML = '<option value="all">Semua akun</option>' +
    owners.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
  select.value = owners.includes(previousValue) || previousValue === 'all' ? previousValue : 'all';
}

// ---- Dashboard page: cards + charts, aggregated server-side ----

function populateDashboardFilterSelect(select, options, placeholderLabel) {
  const previousValue = select.value || 'all';
  select.innerHTML = `<option value="all">${placeholderLabel}</option>` +
    options.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
  select.value = options.includes(previousValue) || previousValue === 'all' ? previousValue : 'all';
}

// Empty set == "Semua produk" (no filter) - mirrors the 'all' convention
// used by the other single-select dashboard filters.
let dashSelectedProducts = new Set();

function updateDashProductToggleLabel() {
  const btn = el('dashFilterProductToggle');
  if (dashSelectedProducts.size === 0) {
    btn.textContent = 'Semua produk';
  } else if (dashSelectedProducts.size === 1) {
    btn.textContent = chartTruncate(Array.from(dashSelectedProducts)[0], 22);
  } else {
    btn.textContent = `${dashSelectedProducts.size} produk dipilih`;
  }
}

function populateDashboardProductPanel(products) {
  // Drop selections for products that no longer exist (e.g. renamed/deleted).
  dashSelectedProducts = new Set(Array.from(dashSelectedProducts).filter((p) => products.includes(p)));

  const panel = el('dashFilterProductPanel');
  panel.innerHTML = `
    <label class="multiselect-option">
      <input type="checkbox" id="dashFilterProductAll" ${dashSelectedProducts.size === 0 ? 'checked' : ''} />
      Semua produk
    </label>
    <div class="multiselect-divider"></div>
    ${products.map((p) => `
      <label class="multiselect-option">
        <input type="checkbox" class="dash-product-option" value="${escapeHtml(p)}" ${dashSelectedProducts.has(p) ? 'checked' : ''} />
        ${escapeHtml(p)}
      </label>`).join('')}
  `;
  updateDashProductToggleLabel();
}

function renderDashboardCards(cards) {
  el('statOmset').textContent = formatRupiah(cards.totalOmset);
  el('statTotalPesanan').textContent = cards.totalPesanan;
  el('statAov').textContent = formatRupiah(cards.avgOrderValue);
  el('statCancelRate').textContent = `${cards.cancellationRate}%`;
  el('statActivePreOrders').textContent = cards.activePreOrders;
  el('statTotal').textContent = cards.chatMasuk;
  el('statClosing').textContent = cards.closingCount;
  el('statRate').textContent = `${cards.closingRate}%`;
}

function renderDashboardCharts(stats) {
  renderLineChart(el('chartRevenueByDay'), stats.revenueByDay, {
    xKey: 'date', yKey: 'omset', formatValue: chartFormatRupiahCompact,
    emptyMessage: 'Belum ada pesanan pada rentang ini.',
  });
  renderLineChart(el('chartChatsByDay'), stats.chatsByDay, {
    xKey: 'date', yKey: 'count', color: '#2a78d6', formatValue: chartFormatCompactNumber,
    emptyMessage: 'Belum ada chat masuk pada rentang ini.',
  });
  renderBarChart(el('chartOrdersByProduct'), stats.ordersByProduct.slice(0, 8), {
    xKey: 'productName', yKey: 'omset', formatValue: chartFormatRupiahCompact,
    emptyMessage: 'Belum ada pesanan.',
  });
  renderBarChart(el('chartPreOrdersByCreator'), stats.preOrdersByCreator, {
    xKey: 'email', yKey: 'count', color: '#4a3aa7', formatValue: chartFormatCompactNumber,
    emptyMessage: 'Belum ada pra-pesanan.',
  });
  renderBarChart(el('chartClosingRateByOwner'), stats.closingRateByOwner, {
    xKey: 'ownerNumber', yKey: 'rate', color: '#1baf7a', formatValue: (v) => `${Math.round(v * 10) / 10}%`,
    emptyMessage: 'Belum ada chat masuk.',
  });
  el('chartLeadsVsOrdersHint').textContent = stats.productTaggingCoverage > 0
    ? `Hanya ${stats.productTaggingCoverage}% chat yang sudah ditandai produknya di WA Web - rasio di bawah ini baru mewakili sebagian kecil lead.`
    : 'Belum ada chat yang ditandai produknya di WA Web.';
  renderGroupedBarChart(el('chartLeadsVsOrders'), stats.leadsVsOrdersByProduct.slice(0, 8), {
    xKey: 'productName',
    series: [
      { key: 'leads', label: 'Lead', color: CHART_CATEGORICAL[0] },
      { key: 'orders', label: 'Pesanan', color: CHART_CATEGORICAL[1] },
    ],
    formatValue: chartFormatCompactNumber,
    emptyMessage: 'Belum ada chat yang ditandai produknya.',
  });
  renderFunnelChart(el('chartFunnel'), [
    { label: 'Lead', value: stats.funnel.leads },
    { label: 'Pra-Pesanan', value: stats.funnel.preOrders },
    { label: 'Pesanan', value: stats.funnel.orders },
    { label: 'Diterima', value: stats.funnel.delivered },
  ]);
}

async function renderDashboard() {
  el('dashLoadingState').classList.remove('hidden');
  try {
    const params = new URLSearchParams();
    const from = el('dashFilterFrom').value;
    const to = el('dashFilterTo').value;
    const owner = el('dashFilterOwner').value;
    const creator = el('dashFilterCreator').value;
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (owner && owner !== 'all') params.set('ownerNumber', owner);
    dashSelectedProducts.forEach((p) => params.append('productName', p));
    if (creator && creator !== 'all') params.set('createdByEmail', creator);

    const stats = await apiGet(`/api/dashboard/stats?${params.toString()}`);
    populateDashboardFilterSelect(el('dashFilterOwner'), stats.filterOptions.owners, 'Semua akun');
    populateDashboardProductPanel(stats.filterOptions.products);
    populateDashboardFilterSelect(el('dashFilterCreator'), stats.filterOptions.creators, 'Semua CS');
    renderDashboardCards(stats.cards);
    renderDashboardCharts(stats);
  } catch (e) {
    handleApiError(e, 'Gagal memuat statistik dashboard.');
  } finally {
    el('dashLoadingState').classList.add('hidden');
  }
}

// ---- Kontak page: full table ----

function renderKontak() {
  populateOwnerSelect(el(KONTAK_IDS.owner));
  const filter = readFilterState(KONTAK_IDS);
  const q = el('searchBox').value.trim().toLowerCase();

  const matched = Object.values(allChats).filter((chat) => {
    if (filter.owner !== 'all' && (chat.ownerNumber || '') !== filter.owner) return false;
    if (!matchesDateFilter(chat, filter)) return false;
    if (q) {
      const hay = `${chat.name || ''} ${chat.phone || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const matchedIds = new Set(matched.map((c) => c.id));
  Array.from(selectedIds).forEach((id) => {
    if (!matchedIds.has(id)) selectedIds.delete(id);
  });

  matched.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  // Only 10 rows are rendered to the DOM at a time - re-rendering the whole
  // table (edit/toggle/select, filter change, background refresh) stays fast
  // even with a large contact list.
  const totalPages = Math.max(1, Math.ceil(matched.length / KONTAK_PAGE_SIZE));
  if (kontakPage > totalPages) kontakPage = totalPages;
  if (kontakPage < 1) kontakPage = 1;
  const pageStart = (kontakPage - 1) * KONTAK_PAGE_SIZE;
  const pageItems = matched.slice(pageStart, pageStart + KONTAK_PAGE_SIZE);

  el('kontakPageInfo').textContent = matched.length > 0
    ? `Halaman ${kontakPage} dari ${totalPages} (${matched.length} kontak)`
    : '';
  el('kontakPrevBtn').disabled = kontakPage <= 1;
  el('kontakNextBtn').disabled = kontakPage >= totalPages;

  const tbody = el('chatTableBody');
  tbody.innerHTML = '';
  el('emptyState').classList.toggle('hidden', matched.length > 0);

  pageItems
    .forEach((chat) => {
      const leadDate = leadDateExact(chat);
      const display = leadDate
        ? new Date(leadDate).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })
        : '-';
      const closing = isClosing(chat);

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input type="checkbox" class="row-checkbox" data-id="${escapeHtml(chat.id)}" ${selectedIds.has(chat.id) ? 'checked' : ''} /></td>
        <td>${escapeHtml(chat.name || '-')}</td>
        <td>${escapeHtml(chat.phone || '-')}</td>
        <td>${escapeHtml(chat.ownerNumber || '-')}</td>
        <td>
          ${escapeHtml(display)}
          <button class="edit-btn" data-id="${escapeHtml(chat.id)}" title="Isi tanggal lead manual">✎</button>
        </td>
        <td>${closing ? '<span class="status-pill">Closing</span>' : ''}</td>
        <td>
          <button class="closing-toggle ${closing ? 'active' : ''}" data-id="${escapeHtml(chat.id)}">
            ${closing ? '✓ Closing' : 'Tandai Closing'}
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });

  tbody.querySelectorAll('.edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => editDateManually(btn.dataset.id));
  });
  tbody.querySelectorAll('.closing-toggle').forEach((btn) => {
    btn.addEventListener('click', () => toggleClosing(btn.dataset.id));
  });
  tbody.querySelectorAll('.row-checkbox').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedIds.add(cb.dataset.id);
      else selectedIds.delete(cb.dataset.id);
      updateSelectionUi();
    });
  });

  updateSelectionUi();
}

function renderAll() {
  renderDashboard();
  renderKontak();
}

function updateSelectionUi() {
  const count = selectedIds.size;
  el('deleteSelectedBtn').disabled = count === 0;
  el('selectedCount').textContent = count > 0 ? `${count} dipilih` : '';

  const checkboxes = document.querySelectorAll('.row-checkbox');
  const checkedCount = Array.from(checkboxes).filter((cb) => cb.checked).length;
  el('selectAllCheckbox').checked = checkboxes.length > 0 && checkedCount === checkboxes.length;
  el('selectAllCheckbox').indeterminate = checkedCount > 0 && checkedCount < checkboxes.length;
}

async function editDateManually(chatId) {
  const chat = allChats[chatId];
  if (!chat) return;
  const currentVal = chat.firstMessageDate ? new Date(chat.firstMessageDate).toISOString().slice(0, 10) : '';
  const input = window.prompt('Tanggal lead yang benar (YYYY-MM-DD):', currentVal);
  if (!input) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    window.alert('Format tanggal harus YYYY-MM-DD, contoh: 2026-07-20');
    return;
  }
  const parsed = new Date(`${input}T00:00:00`);
  if (isNaN(parsed.getTime())) {
    window.alert('Tanggal tidak valid.');
    return;
  }
  chat.firstMessageDate = parsed.toISOString();
  try {
    await apiPut('/api/chats', { [chatId]: chat });
    renderAll();
  } catch (e) {
    handleApiError(e, 'Gagal menyimpan tanggal.');
  }
}

async function toggleClosing(chatId) {
  const chat = allChats[chatId];
  if (!chat) return;
  const current = chat.manualClosing === true || (currentSettings.manualClosing && currentSettings.manualClosing[chatId] === true);
  chat.manualClosing = !current;
  chat.manualClosingUpdatedAt = new Date().toISOString();
  try {
    await apiPut('/api/chats', { [chatId]: chat });
    renderAll();
  } catch (e) {
    handleApiError(e, 'Gagal menyimpan status closing.');
  }
}

async function deleteSelected() {
  const ids = Array.from(selectedIds);
  if (ids.length === 0) return;
  if (!confirm(`Hapus ${ids.length} chat yang dipilih dari MongoDB? Tindakan ini tidak bisa dibatalkan.`)) return;

  try {
    await apiPost('/api/chats/delete', { ids });
    ids.forEach((id) => delete allChats[id]);
    selectedIds.clear();
    renderAll();
  } catch (e) {
    handleApiError(e, 'Gagal menghapus data.');
  }
}

async function loadData() {
  el('dashLoadingState').classList.remove('hidden');
  el('loadingState').classList.remove('hidden');
  try {
    const [{ chats = {} }, { settings: rawSettings = {} }] = await Promise.all([
      apiGet('/api/chats'),
      apiGet('/api/settings'),
    ]);
    allChats = chats;
    currentSettings = { staleDays: 3, closingLabels: [], manualClosing: {}, ...rawSettings };
    renderAll();
  } catch (e) {
    handleApiError(e, 'Gagal memuat data dari server.');
  } finally {
    el('dashLoadingState').classList.add('hidden');
    el('loadingState').classList.add('hidden');
  }
}

// ---- Products ----

// weight in gram, volume in cm3, length/width/height in cm - all optional,
// unlike name/price which every product needs.
const PRODUCT_DIM_FIELDS = ['weight', 'volume', 'length', 'width', 'height'];

function formatRupiah(price) {
  return `Rp ${Number(price || 0).toLocaleString('id-ID')}`;
}

function formatDim(value) {
  return value === undefined || value === null || value === '' ? '-' : Number(value).toLocaleString('id-ID');
}

function renderProductsTable() {
  const tbody = el('productsTableBody');
  tbody.innerHTML = '';
  el('productsEmptyState').classList.toggle('hidden', allProducts.length > 0);

  allProducts
    .slice()
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .forEach((product) => {
      const tr = document.createElement('tr');
      if (editingProductId === product.id) {
        const dimInputs = PRODUCT_DIM_FIELDS
          .map((field) => `<td><input type="number" class="edit-product-${field}" min="0" value="${escapeHtml(product[field] ?? '')}" /></td>`)
          .join('');
        tr.innerHTML = `
          <td><input type="text" class="edit-product-name" value="${escapeHtml(product.name)}" /></td>
          <td><input type="number" class="edit-product-price" min="0" value="${escapeHtml(product.price)}" /></td>
          ${dimInputs}
          <td>
            <button class="save-product-btn" data-id="${escapeHtml(product.id)}">Simpan</button>
            <button class="cancel-product-btn">Batal</button>
          </td>
        `;
      } else {
        const dimCells = PRODUCT_DIM_FIELDS.map((field) => `<td>${escapeHtml(formatDim(product[field]))}</td>`).join('');
        tr.innerHTML = `
          <td>${escapeHtml(product.name)}</td>
          <td>${escapeHtml(formatRupiah(product.price))}</td>
          ${dimCells}
          <td>
            <button class="edit-product-btn" data-id="${escapeHtml(product.id)}">Edit</button>
            <button class="delete-product-btn" data-id="${escapeHtml(product.id)}">Hapus</button>
          </td>
        `;
      }
      tbody.appendChild(tr);
    });

  tbody.querySelectorAll('.edit-product-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      editingProductId = btn.dataset.id;
      renderProductsTable();
    });
  });
  tbody.querySelectorAll('.cancel-product-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      editingProductId = null;
      renderProductsTable();
    });
  });
  tbody.querySelectorAll('.save-product-btn').forEach((btn) => {
    btn.addEventListener('click', () => saveProductEdit(btn.dataset.id, tbody));
  });
  tbody.querySelectorAll('.delete-product-btn').forEach((btn) => {
    btn.addEventListener('click', () => deleteProduct(btn.dataset.id));
  });
}

async function loadProducts() {
  try {
    const { products } = await apiGet('/api/products');
    allProducts = products;
    renderProductsTable();
  } catch (e) {
    handleApiError(e, 'Gagal memuat daftar produk.');
  }
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

async function addProduct() {
  const name = el('newProductName').value.trim();
  const price = el('newProductPrice').value;
  el('productFormMsg').textContent = '';
  if (!name || price === '') {
    el('productFormMsg').textContent = 'Isi nama produk dan harga jual.';
    return;
  }
  const dims = {};
  PRODUCT_DIM_FIELDS.forEach((field) => {
    const val = el(`newProduct${capitalize(field)}`).value;
    if (val !== '') dims[field] = Number(val);
  });
  try {
    await apiPost('/api/products', { name, price: Number(price), ...dims });
    el('newProductName').value = '';
    el('newProductPrice').value = '';
    PRODUCT_DIM_FIELDS.forEach((field) => { el(`newProduct${capitalize(field)}`).value = ''; });
    await loadProducts();
  } catch (e) {
    if (e.message === 'unauthorized') {
      handleApiError(e);
      return;
    }
    el('productFormMsg').textContent = e.message || 'Gagal menambah produk.';
  }
}

async function saveProductEdit(id, tbody) {
  const name = tbody.querySelector('.edit-product-name').value.trim();
  const price = tbody.querySelector('.edit-product-price').value;
  if (!name || price === '') {
    window.alert('Isi nama produk dan harga jual.');
    return;
  }
  const dims = {};
  PRODUCT_DIM_FIELDS.forEach((field) => {
    const val = tbody.querySelector(`.edit-product-${field}`).value;
    if (val !== '') dims[field] = Number(val);
  });
  try {
    await apiPut(`/api/products/${id}`, { name, price: Number(price), ...dims });
    editingProductId = null;
    await loadProducts();
  } catch (e) {
    handleApiError(e, 'Gagal menyimpan produk.');
  }
}

async function deleteProduct(id) {
  if (!confirm('Hapus produk ini? Tindakan ini tidak bisa dibatalkan.')) return;
  try {
    await apiDelete(`/api/products/${id}`);
    await loadProducts();
  } catch (e) {
    handleApiError(e, 'Gagal menghapus produk.');
  }
}

// ---- Orders (Pesanan) ----

function populateOrderStatusSelect(select) {
  const statuses = Array.from(new Set(allOrders.map((o) => o.status).filter(Boolean))).sort();
  const previousValue = select.value || 'all';
  select.innerHTML = '<option value="all">Semua Status</option>' +
    statuses.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  select.value = statuses.includes(previousValue) || previousValue === 'all' ? previousValue : 'all';
}

function renderOrdersTable() {
  populateOrderStatusSelect(el('orderFilterStatus'));
  const statusFilter = el('orderFilterStatus').value;
  const q = el('orderSearchBox').value.trim().toLowerCase();

  const filtered = allOrders.filter((order) => {
    if (statusFilter !== 'all' && (order.status || '') !== statusFilter) return false;
    if (q) {
      const hay = `${order.customerName || ''} ${order.customerPhone || ''} ${order.trackingNumber || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const sorted = filtered.slice().sort((a, b) => {
    const ta = a.createdDate ? new Date(a.createdDate).getTime() : 0;
    const tb = b.createdDate ? new Date(b.createdDate).getTime() : 0;
    return tb - ta;
  });

  const currentIds = new Set(sorted.map((o) => o.id));
  Array.from(selectedOrderIds).forEach((id) => {
    if (!currentIds.has(id)) selectedOrderIds.delete(id);
  });

  const totalPages = Math.max(1, Math.ceil(sorted.length / ORDERS_PAGE_SIZE));
  if (ordersPage > totalPages) ordersPage = totalPages;
  if (ordersPage < 1) ordersPage = 1;
  const pageStart = (ordersPage - 1) * ORDERS_PAGE_SIZE;
  const pageItems = sorted.slice(pageStart, pageStart + ORDERS_PAGE_SIZE);

  el('ordersPageInfo').textContent = sorted.length > 0
    ? `Halaman ${ordersPage} dari ${totalPages} (${sorted.length} pesanan)`
    : '';
  el('ordersPrevBtn').disabled = ordersPage <= 1;
  el('ordersNextBtn').disabled = ordersPage >= totalPages;

  const tbody = el('ordersTableBody');
  tbody.innerHTML = '';
  el('ordersEmptyState').classList.toggle('hidden', sorted.length > 0);

  pageItems.forEach((order) => {
    const dateDisplay = order.createdDate
      ? new Date(order.createdDate).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })
      : '-';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" class="order-row-checkbox" data-id="${escapeHtml(order.id)}" ${selectedOrderIds.has(order.id) ? 'checked' : ''} /></td>
      <td>${escapeHtml(order.id)}</td>
      <td>${escapeHtml(dateDisplay)}</td>
      <td>${escapeHtml(order.customerName || '-')}</td>
      <td>${escapeHtml(order.customerPhone || '-')}</td>
      <td>${escapeHtml(order.productName || '-')}</td>
      <td>${escapeHtml(order.qty ?? '-')}</td>
      <td>${escapeHtml(formatRupiah(order.price))}</td>
      <td>${escapeHtml(order.ownerNumber || '-')}</td>
      <td>${escapeHtml(order.status || '-')}</td>
      <td>${escapeHtml(order.trackingNumber || '-')}</td>
      <td><button class="delete-product-btn delete-order-btn" data-id="${escapeHtml(order.id)}">Hapus</button></td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.order-row-checkbox').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedOrderIds.add(cb.dataset.id);
      else selectedOrderIds.delete(cb.dataset.id);
      updateOrdersSelectionUi();
    });
  });
  tbody.querySelectorAll('.delete-order-btn').forEach((btn) => {
    btn.addEventListener('click', () => deleteOrder(btn.dataset.id));
  });

  updateOrdersSelectionUi();
}

function updateOrdersSelectionUi() {
  const count = selectedOrderIds.size;
  el('ordersDeleteSelectedBtn').disabled = count === 0;
  el('ordersSelectedCount').textContent = count > 0 ? `${count} dipilih` : '';

  const checkboxes = document.querySelectorAll('.order-row-checkbox');
  const checkedCount = Array.from(checkboxes).filter((cb) => cb.checked).length;
  el('ordersSelectAllCheckbox').checked = checkboxes.length > 0 && checkedCount === checkboxes.length;
  el('ordersSelectAllCheckbox').indeterminate = checkedCount > 0 && checkedCount < checkboxes.length;
}

async function deleteOrder(id) {
  if (!confirm('Hapus pesanan ini? Tindakan ini tidak bisa dibatalkan.')) return;
  try {
    await apiDelete(`/api/orders/${id}`);
    selectedOrderIds.delete(id);
    await loadOrders();
  } catch (e) {
    handleApiError(e, 'Gagal menghapus pesanan.');
  }
}

async function deleteSelectedOrders() {
  const ids = Array.from(selectedOrderIds);
  if (ids.length === 0) return;
  if (!confirm(`Hapus ${ids.length} pesanan yang dipilih? Tindakan ini tidak bisa dibatalkan.`)) return;
  try {
    await apiPost('/api/orders/delete', { ids });
    selectedOrderIds.clear();
    await loadOrders();
  } catch (e) {
    handleApiError(e, 'Gagal menghapus pesanan.');
  }
}

async function loadOrders() {
  el('ordersLoadingState').classList.remove('hidden');
  try {
    const { orders } = await apiGet('/api/orders');
    allOrders = orders;
    renderOrdersTable();
  } catch (e) {
    handleApiError(e, 'Gagal memuat daftar pesanan.');
  } finally {
    el('ordersLoadingState').classList.add('hidden');
  }
}

// Shared by both the Pesanan page's import controls and the duplicate set on
// the Pra-Pesanan page (same underlying action - a lincah import moves any
// matching pre-orders out, so it's genuinely useful to trigger from either
// page rather than forcing a page switch).
async function importLincahOrders(ids) {
  const fileInput = el(ids.file);
  const file = fileInput.files[0];
  el(ids.msg).textContent = '';
  if (!file) {
    el(ids.msg).textContent = 'Pilih file .xlsx dulu.';
    return;
  }
  el(ids.btn).disabled = true;
  el(ids.msg).textContent = 'Mengimpor...';
  try {
    const result = await apiUploadFile('/api/orders/import', file);
    el(ids.msg).textContent =
      `${result.ordersImported} pesanan diimpor, ${result.productsCreated} produk baru, ` +
      `${result.contactsCreated} kontak baru` +
      (result.rowsSkipped > 0 ? `, ${result.rowsSkipped} baris dilewati (tanpa nomor HP)` : '') +
      (result.preOrdersMoved > 0 ? `, ${result.preOrdersMoved} pra-pesanan dipindahkan ke pesanan` : '') + '.';
    fileInput.value = '';
    ordersPage = 1;
    await loadOrders();
    if (ids.modal) el(ids.modal).classList.add('hidden');
    // The import can create new products/contacts, and can also delete
    // matching pre-orders server-side - refresh all of them so nothing looks
    // stale until manually reloaded.
    await Promise.all([loadProducts(), loadData(), loadPreOrders()]);
  } catch (e) {
    if (e.message === 'unauthorized') {
      handleApiError(e);
      return;
    }
    el(ids.msg).textContent = e.message || 'Gagal mengimpor file.';
  } finally {
    el(ids.btn).disabled = false;
  }
}

function importOrders() {
  return importLincahOrders({ file: 'orderImportFile', msg: 'orderImportMsg', btn: 'orderImportBtn' });
}

function importOrdersFromPreOrderPage() {
  return importLincahOrders({
    file: 'preOrderLincahImportFile', msg: 'preOrderLincahImportMsg', btn: 'preOrderLincahImportBtn',
    modal: 'preOrderLincahImportModal',
  });
}

// ---- Pre-Orders (Pra-Pesanan) - full CRUD ----

let editingPreOrderId = null;

// Options come from the Product catalog (same source of truth as the Produk
// page), not free text - keeps a pre-order's product name matchable against
// real lincah orders later. Keep an already-picked product selectable even
// if it was since renamed/deleted in the catalog, so editing never silently
// discards it.
function populatePreOrderProductSelect(currentValue) {
  const select = el('preOrderProductName');
  const names = Array.from(new Set(allProducts.map((p) => p.name).filter(Boolean))).sort();
  if (currentValue && !names.includes(currentValue)) names.unshift(currentValue);
  select.innerHTML = '<option value="">Pilih Produk</option>' +
    names.map((name) => `<option value="${escapeHtml(name)}" ${name === currentValue ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('');
}

// Harga Satuan is pre-filled from the catalog price when a product is
// picked, but stays a normal editable number field afterward - this order's
// price can differ (discount, negotiation) from the catalog default.
function applyPreOrderProductPrice() {
  const product = allProducts.find((p) => p.name === el('preOrderProductName').value);
  if (product && product.price !== undefined && product.price !== null) {
    el('preOrderUnitPrice').value = product.price;
  }
}

async function loadUsersMini() {
  try {
    const { users } = await apiGet('/api/users/mini');
    allUsersMini = users;
  } catch (e) {
    // Non-fatal - the "Dibuat Oleh" picker just falls back to showing
    // nothing selectable beyond the current user if this fails.
  }
}

// Who created a pre-order is a business attribution field the owner can
// reassign (e.g. entering on behalf of a CS rep), not a locked audit trail -
// defaults to whoever's logged in, but any listed user can be picked instead.
function populatePreOrderCreatorSelect(currentUserId) {
  const select = el('preOrderCreatedBy');
  const value = currentUserId || (currentUser && currentUser.userId) || '';
  select.innerHTML = allUsersMini
    .map((u) => `<option value="${escapeHtml(u.id)}" ${u.id === value ? 'selected' : ''}>${escapeHtml(u.email)}</option>`)
    .join('');
}

async function openPreOrderAddModal() {
  resetPreOrderForm();
  await Promise.all([loadProducts(), loadUsersMini()]);
  populatePreOrderProductSelect('');
  populatePreOrderCreatorSelect();
  el('preOrderFormModal').classList.remove('hidden');
}

function closePreOrderFormModal() {
  el('preOrderFormModal').classList.add('hidden');
  resetPreOrderForm();
}

function openPreOrderImportModal() {
  el('preOrderImportMsg').textContent = '';
  el('preOrderImportModal').classList.remove('hidden');
}

function closePreOrderImportModal() {
  el('preOrderImportModal').classList.add('hidden');
}

function openPreOrderLincahImportModal() {
  el('preOrderLincahImportMsg').textContent = '';
  el('preOrderLincahImportModal').classList.remove('hidden');
}

function closePreOrderLincahImportModal() {
  el('preOrderLincahImportModal').classList.add('hidden');
}

// [form element id, PreOrder field name] - covers every plain text/number
// field. orderDate and the two checkboxes are handled separately below.
const PREORDER_FORM_TEXT_FIELDS = [
  ['preOrderCustomerName', 'customerName'],
  ['preOrderCustomerPhone', 'customerPhone'],
  ['preOrderAddress', 'address'],
  ['preOrderProductName', 'productName'],
  ['preOrderQty', 'qty'],
  ['preOrderUnitPrice', 'unitPrice'],
  ['preOrderTotalPrice', 'totalPrice'],
  ['preOrderShippingCost', 'shippingCost'],
  ['preOrderTotalBill', 'totalBill'],
  ['preOrderPaymentMethod', 'paymentMethod'],
  ['preOrderPaymentStatus', 'paymentStatus'],
  ['preOrderCourier', 'courier'],
  ['preOrderNoResi', 'noResi'],
  ['preOrderStatusOrder', 'statusOrder'],
  ['preOrderCampaignSource', 'campaignSource'],
  ['preOrderNote', 'note'],
  ['preOrderCtt', 'ctt'],
];

function readPreOrderForm() {
  const body = {};
  PREORDER_FORM_TEXT_FIELDS.forEach(([elId, key]) => { body[key] = el(elId).value; });
  body.orderDate = el('preOrderOrderDate').value || undefined;
  body.lincah = el('preOrderLincah').checked;
  body.aneka = el('preOrderAneka').checked;
  body.createdByUserId = el('preOrderCreatedBy').value || undefined;
  return body;
}

function fillPreOrderForm(preOrder) {
  PREORDER_FORM_TEXT_FIELDS.forEach(([elId, key]) => { el(elId).value = preOrder[key] ?? ''; });
  el('preOrderOrderDate').value = preOrder.orderDate ? new Date(preOrder.orderDate).toISOString().slice(0, 10) : '';
  el('preOrderLincah').checked = preOrder.lincah === true;
  el('preOrderAneka').checked = preOrder.aneka === true;
}

function resetPreOrderForm() {
  PREORDER_FORM_TEXT_FIELDS.forEach(([elId]) => { el(elId).value = ''; });
  el('preOrderOrderDate').value = '';
  el('preOrderLincah').checked = false;
  el('preOrderAneka').checked = false;
  editingPreOrderId = null;
  el('preOrderFormTitle').textContent = 'Tambah Pra-Pesanan Baru';
  el('preOrderSaveBtn').textContent = 'Tambah';
  el('preOrderFormMsg').textContent = '';
  el('preOrderNumberDisplay').textContent = '';
}

async function startEditPreOrder(id) {
  const preOrder = allPreOrders.find((p) => p.id === id);
  if (!preOrder) return;
  await Promise.all([loadProducts(), loadUsersMini()]);
  populatePreOrderProductSelect(preOrder.productName);
  populatePreOrderCreatorSelect(preOrder.createdByUserId);
  fillPreOrderForm(preOrder);
  editingPreOrderId = id;
  el('preOrderFormTitle').textContent = 'Edit Pra-Pesanan';
  el('preOrderSaveBtn').textContent = 'Simpan Perubahan';
  el('preOrderFormMsg').textContent = '';
  el('preOrderNumberDisplay').textContent = preOrder.orderNumber ? `No. Order: ${preOrder.orderNumber}` : '';
  el('preOrderFormModal').classList.remove('hidden');
}

async function savePreOrder() {
  const body = readPreOrderForm();
  if (!body.customerName && !body.customerPhone && !body.productName) {
    el('preOrderFormMsg').textContent = 'Isi minimal nama, nomor HP, atau produk.';
    return;
  }
  try {
    if (editingPreOrderId) {
      await apiPut(`/api/preorders/${editingPreOrderId}`, body);
    } else {
      await apiPost('/api/preorders', body);
    }
    closePreOrderFormModal();
    preOrdersPage = 1;
    await loadPreOrders();
    // Can create a new product/contact (same as the bulk import path).
    await Promise.all([loadProducts(), loadData()]);
  } catch (e) {
    if (e.message === 'unauthorized') {
      handleApiError(e);
      return;
    }
    el('preOrderFormMsg').textContent = e.message || 'Gagal menyimpan pra-pesanan.';
  }
}

async function deletePreOrder(id) {
  if (!confirm('Hapus pra-pesanan ini? Tindakan ini tidak bisa dibatalkan.')) return;
  try {
    await apiDelete(`/api/preorders/${id}`);
    if (editingPreOrderId === id) resetPreOrderForm();
    selectedPreOrderIds.delete(id);
    await loadPreOrders();
  } catch (e) {
    handleApiError(e, 'Gagal menghapus pra-pesanan.');
  }
}

function populatePreOrderCreatorFilterSelect(select) {
  const creators = Array.from(new Set(allPreOrders.map((p) => p.createdByEmail).filter(Boolean))).sort();
  const previousValue = select.value || 'all';
  select.innerHTML = '<option value="all">Semua CS</option>' +
    creators.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  select.value = creators.includes(previousValue) || previousValue === 'all' ? previousValue : 'all';
}

function renderPreOrdersTable() {
  populatePreOrderCreatorFilterSelect(el('preOrderFilterCreator'));
  const creatorFilter = el('preOrderFilterCreator').value;

  const filtered = allPreOrders.filter((p) => {
    if (creatorFilter !== 'all' && (p.createdByEmail || '') !== creatorFilter) return false;
    return true;
  });

  const sorted = filtered.slice().sort((a, b) => {
    const ta = a.orderDate ? new Date(a.orderDate).getTime() : 0;
    const tb = b.orderDate ? new Date(b.orderDate).getTime() : 0;
    return tb - ta;
  });

  const currentIds = new Set(sorted.map((p) => p.id));
  Array.from(selectedPreOrderIds).forEach((id) => {
    if (!currentIds.has(id)) selectedPreOrderIds.delete(id);
  });

  const totalPages = Math.max(1, Math.ceil(sorted.length / PREORDERS_PAGE_SIZE));
  if (preOrdersPage > totalPages) preOrdersPage = totalPages;
  if (preOrdersPage < 1) preOrdersPage = 1;
  const pageStart = (preOrdersPage - 1) * PREORDERS_PAGE_SIZE;
  const pageItems = sorted.slice(pageStart, pageStart + PREORDERS_PAGE_SIZE);

  el('preOrdersPageInfo').textContent = sorted.length > 0
    ? `Halaman ${preOrdersPage} dari ${totalPages} (${sorted.length} pra-pesanan)`
    : '';
  el('preOrdersPrevBtn').disabled = preOrdersPage <= 1;
  el('preOrdersNextBtn').disabled = preOrdersPage >= totalPages;

  const tbody = el('preOrdersTableBody');
  tbody.innerHTML = '';
  el('preOrdersEmptyState').classList.toggle('hidden', sorted.length > 0);

  pageItems.forEach((preOrder) => {
    const dateDisplay = preOrder.orderDate
      ? new Date(preOrder.orderDate).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })
      : '-';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" class="preorder-row-checkbox" data-id="${escapeHtml(preOrder.id)}" ${selectedPreOrderIds.has(preOrder.id) ? 'checked' : ''} /></td>
      <td>${escapeHtml(preOrder.orderNumber || '-')}</td>
      <td>${escapeHtml(dateDisplay)}</td>
      <td>${escapeHtml(preOrder.customerName || '-')}</td>
      <td>${escapeHtml(preOrder.customerPhone || '-')}</td>
      <td>${escapeHtml(preOrder.productName || '-')}</td>
      <td>${escapeHtml(preOrder.qty ?? '-')}</td>
      <td>${escapeHtml(preOrder.noResi || '-')}</td>
      <td>${escapeHtml(preOrder.statusOrder || '-')}</td>
      <td>${escapeHtml(preOrder.createdByEmail || '-')}</td>
      <td>
        <button class="edit-product-btn edit-preorder-btn" data-id="${escapeHtml(preOrder.id)}">Edit</button>
        <button class="delete-product-btn delete-preorder-btn" data-id="${escapeHtml(preOrder.id)}">Hapus</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.preorder-row-checkbox').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedPreOrderIds.add(cb.dataset.id);
      else selectedPreOrderIds.delete(cb.dataset.id);
      updatePreOrdersSelectionUi();
    });
  });
  tbody.querySelectorAll('.edit-preorder-btn').forEach((btn) => {
    btn.addEventListener('click', () => startEditPreOrder(btn.dataset.id));
  });
  tbody.querySelectorAll('.delete-preorder-btn').forEach((btn) => {
    btn.addEventListener('click', () => deletePreOrder(btn.dataset.id));
  });

  updatePreOrdersSelectionUi();
}

function updatePreOrdersSelectionUi() {
  const count = selectedPreOrderIds.size;
  el('preOrdersDeleteSelectedBtn').disabled = count === 0;
  el('preOrdersSelectedCount').textContent = count > 0 ? `${count} dipilih` : '';

  const checkboxes = document.querySelectorAll('.preorder-row-checkbox');
  const checkedCount = Array.from(checkboxes).filter((cb) => cb.checked).length;
  el('preOrdersSelectAllCheckbox').checked = checkboxes.length > 0 && checkedCount === checkboxes.length;
  el('preOrdersSelectAllCheckbox').indeterminate = checkedCount > 0 && checkedCount < checkboxes.length;
}

async function deleteSelectedPreOrders() {
  const ids = Array.from(selectedPreOrderIds);
  if (ids.length === 0) return;
  if (!confirm(`Hapus ${ids.length} pra-pesanan yang dipilih? Tindakan ini tidak bisa dibatalkan.`)) return;
  try {
    await apiPost('/api/preorders/delete', { ids });
    selectedPreOrderIds.clear();
    await loadPreOrders();
  } catch (e) {
    handleApiError(e, 'Gagal menghapus pra-pesanan.');
  }
}

async function loadPreOrders() {
  el('preOrdersLoadingState').classList.remove('hidden');
  try {
    const { preOrders } = await apiGet('/api/preorders');
    allPreOrders = preOrders;
    renderPreOrdersTable();
  } catch (e) {
    handleApiError(e, 'Gagal memuat daftar pra-pesanan.');
  } finally {
    el('preOrdersLoadingState').classList.add('hidden');
  }
}

async function importPreOrders() {
  const fileInput = el('preOrderImportFile');
  const file = fileInput.files[0];
  el('preOrderImportMsg').textContent = '';
  if (!file) {
    el('preOrderImportMsg').textContent = 'Pilih file .xlsx dulu.';
    return;
  }
  el('preOrderImportBtn').disabled = true;
  el('preOrderImportMsg').textContent = 'Mengimpor...';
  try {
    const result = await apiUploadFile('/api/preorders/import', file);
    el('preOrderImportMsg').textContent =
      `${result.added} pra-pesanan baru ditambahkan` +
      (result.skippedDuplicate > 0 ? `, ${result.skippedDuplicate} dilewati (sudah ada)` : '') + '.';
    fileInput.value = '';
    preOrdersPage = 1;
    await loadPreOrders();
    closePreOrderImportModal();
    // Same as manual create - can create a new product/contact.
    await Promise.all([loadProducts(), loadData()]);
  } catch (e) {
    if (e.message === 'unauthorized') {
      handleApiError(e);
      return;
    }
    el('preOrderImportMsg').textContent = e.message || 'Gagal mengimpor file.';
  } finally {
    el('preOrderImportBtn').disabled = false;
  }
}

// ---- User management (admin only) ----

function renderUsersTable(users) {
  const tbody = el('usersTableBody');
  tbody.innerHTML = '';
  users.forEach((u) => {
    const created = u.createdAt ? new Date(u.createdAt).toLocaleDateString('id-ID') : '-';
    const isSelf = currentUser && u._id === currentUser.userId;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(u.email)}</td>
      <td>${escapeHtml(u.role)}</td>
      <td>${escapeHtml(created)}</td>
      <td>${isSelf ? '' : `<button class="delete-user-btn" data-id="${escapeHtml(u._id)}">Hapus</button>`}</td>
    `;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.delete-user-btn').forEach((btn) => {
    btn.addEventListener('click', () => deleteUser(btn.dataset.id));
  });
}

async function loadUsers() {
  try {
    const { users } = await apiGet('/api/users');
    renderUsersTable(users);
  } catch (e) {
    handleApiError(e, 'Gagal memuat daftar user.');
  }
}

async function addUser() {
  const email = el('newUserEmail').value.trim();
  const password = el('newUserPassword').value;
  const role = el('newUserRole').value;
  el('userFormMsg').textContent = '';
  if (!email || !password) {
    el('userFormMsg').textContent = 'Isi email dan password.';
    return;
  }
  try {
    await apiPost('/api/users', { email, password, role });
    el('newUserEmail').value = '';
    el('newUserPassword').value = '';
    await loadUsers();
  } catch (e) {
    if (e.message === 'unauthorized') {
      handleApiError(e);
      return;
    }
    el('userFormMsg').textContent = e.message || 'Gagal menambah user.';
  }
}

async function deleteUser(id) {
  if (!confirm('Hapus user ini? Tindakan ini tidak bisa dibatalkan.')) return;
  try {
    await apiDelete(`/api/users/${id}`);
    await loadUsers();
  } catch (e) {
    handleApiError(e, 'Gagal menghapus user.');
  }
}

// ---- Sidebar navigation ----

function switchPage(page) {
  document.querySelectorAll('.nav-link').forEach((btn) => btn.classList.toggle('active', btn.dataset.page === page));
  el('dashboardPage').classList.toggle('hidden', page !== 'dashboard');
  el('kontakPage').classList.toggle('hidden', page !== 'kontak');
  el('produkPage').classList.toggle('hidden', page !== 'produk');
  el('pesananPage').classList.toggle('hidden', page !== 'pesanan');
  el('praPesananPage').classList.toggle('hidden', page !== 'praPesanan');
  el('usersPage').classList.toggle('hidden', page !== 'users');
  if (page === 'dashboard') renderDashboard();
  if (page === 'produk') loadProducts();
  if (page === 'pesanan') loadOrders();
  if (page === 'praPesanan') loadPreOrders();
  if (page === 'users') loadUsers();
}

// ---- Auth screens ----

function showLoginScreen(errorMessage) {
  localStorage.removeItem(TOKEN_STORAGE);
  token = null;
  currentUser = null;
  el('app').classList.add('hidden');
  el('loginScreen').classList.remove('hidden');
  el('loginError').textContent = errorMessage || '';
  el('loginPassword').value = '';
  el('loginEmail').focus();
}

async function showAppScreen() {
  // Validate before revealing the app, so an expired/invalid token bounces
  // straight back to the login screen instead of flashing the dashboard first.
  const me = await apiGet('/api/auth/me');
  currentUser = me;

  el('loginScreen').classList.add('hidden');
  el('app').classList.remove('hidden');
  el('whoami').textContent = `${me.email} (${me.role})`;
  el('usersNavBtn').classList.toggle('hidden', me.role !== 'admin');
  switchPage('dashboard');
  await loadData();
}

async function tryLogin(email, password) {
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      el('loginError').textContent = data.error === 'invalid credentials' ? 'Email atau password salah.' : (data.error || 'Login gagal.');
      return;
    }
    token = data.token;
    localStorage.setItem(TOKEN_STORAGE, token);
    await showAppScreen();
  } catch (e) {
    el('loginError').textContent = `Gagal menghubungi server: ${e.message}`;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  el('loginBtn').addEventListener('click', () => {
    const email = el('loginEmail').value.trim();
    const password = el('loginPassword').value;
    if (!email || !password) return;
    tryLogin(email, password);
  });
  el('loginPassword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el('loginBtn').click();
  });
  el('logoutBtn').addEventListener('click', () => showLoginScreen());

  document.querySelectorAll('.nav-link').forEach((btn) => {
    btn.addEventListener('click', () => switchPage(btn.dataset.page));
  });
  el('addUserBtn').addEventListener('click', addUser);
  el('addProductBtn').addEventListener('click', addProduct);
  el('orderImportBtn').addEventListener('click', importOrders);
  el('preOrderImportBtn').addEventListener('click', importPreOrders);
  el('preOrderLincahImportBtn').addEventListener('click', importOrdersFromPreOrderPage);
  el('preOrderSaveBtn').addEventListener('click', savePreOrder);
  el('preOrderCancelEditBtn').addEventListener('click', closePreOrderFormModal);
  el('preOrderProductName').addEventListener('change', applyPreOrderProductPrice);

  el('preOrderAddOpenBtn').addEventListener('click', openPreOrderAddModal);
  el('preOrderFormCloseBtn').addEventListener('click', closePreOrderFormModal);
  el('preOrderImportOpenBtn').addEventListener('click', openPreOrderImportModal);
  el('preOrderImportCloseBtn').addEventListener('click', closePreOrderImportModal);
  el('preOrderLincahImportOpenBtn').addEventListener('click', openPreOrderLincahImportModal);
  el('preOrderLincahImportCloseBtn').addEventListener('click', closePreOrderLincahImportModal);

  // Clicking the dimmed backdrop (not the modal box itself) closes it too -
  // but only if the whole gesture (mousedown *and* click) started and ended
  // on the backdrop. Selecting text inside the form can end a drag outside
  // the modal box (e.g. onto the backdrop), which makes the resulting click
  // event's target resolve to the overlay even though the user never meant
  // to click outside - checking click alone closed the modal on every such
  // selection.
  [
    ['preOrderFormModal', closePreOrderFormModal],
    ['preOrderImportModal', closePreOrderImportModal],
    ['preOrderLincahImportModal', closePreOrderLincahImportModal],
  ].forEach(([modalId, closeFn]) => {
    const overlay = el(modalId);
    let mouseDownOnBackdrop = false;
    overlay.addEventListener('mousedown', (e) => {
      mouseDownOnBackdrop = e.target === overlay;
    });
    overlay.addEventListener('click', (e) => {
      if (mouseDownOnBackdrop && e.target === overlay) closeFn();
      mouseDownOnBackdrop = false;
    });
  });

  el('refreshBtn').addEventListener('click', loadData);
  el('dashRefreshBtn').addEventListener('click', loadData);
  el('ordersRefreshBtn').addEventListener('click', loadOrders);

  ['orderFilterStatus', 'orderSearchBox'].forEach((id) => {
    el(id).addEventListener('input', () => {
      ordersPage = 1;
      renderOrdersTable();
    });
  });
  el('preOrdersRefreshBtn').addEventListener('click', loadPreOrders);
  el('preOrderFilterCreator').addEventListener('input', () => {
    preOrdersPage = 1;
    renderPreOrdersTable();
  });

  el('ordersPrevBtn').addEventListener('click', () => {
    ordersPage -= 1;
    renderOrdersTable();
  });
  el('ordersNextBtn').addEventListener('click', () => {
    ordersPage += 1;
    renderOrdersTable();
  });

  el('ordersSelectAllCheckbox').addEventListener('change', () => {
    const checked = el('ordersSelectAllCheckbox').checked;
    document.querySelectorAll('.order-row-checkbox').forEach((cb) => {
      cb.checked = checked;
      if (checked) selectedOrderIds.add(cb.dataset.id);
      else selectedOrderIds.delete(cb.dataset.id);
    });
    updateOrdersSelectionUi();
  });
  el('ordersDeleteSelectedBtn').addEventListener('click', deleteSelectedOrders);

  el('preOrdersSelectAllCheckbox').addEventListener('change', () => {
    const checked = el('preOrdersSelectAllCheckbox').checked;
    document.querySelectorAll('.preorder-row-checkbox').forEach((cb) => {
      cb.checked = checked;
      if (checked) selectedPreOrderIds.add(cb.dataset.id);
      else selectedPreOrderIds.delete(cb.dataset.id);
    });
    updatePreOrdersSelectionUi();
  });
  el('preOrdersDeleteSelectedBtn').addEventListener('click', deleteSelectedPreOrders);

  el('preOrdersPrevBtn').addEventListener('click', () => {
    preOrdersPage -= 1;
    renderPreOrdersTable();
  });
  el('preOrdersNextBtn').addEventListener('click', () => {
    preOrdersPage += 1;
    renderPreOrdersTable();
  });

  ['dashFilterFrom', 'dashFilterTo', 'dashFilterOwner', 'dashFilterCreator'].forEach((id) => {
    el(id).addEventListener('input', renderDashboard);
  });

  el('dashFilterProductToggle').addEventListener('click', (e) => {
    e.stopPropagation();
    el('dashFilterProductPanel').classList.toggle('hidden');
  });
  el('dashFilterProductPanel').addEventListener('change', (e) => {
    if (e.target.id === 'dashFilterProductAll') {
      if (e.target.checked) {
        dashSelectedProducts.clear();
        el('dashFilterProductPanel').querySelectorAll('.dash-product-option').forEach((cb) => { cb.checked = false; });
      } else {
        e.target.checked = true; // deselecting "Semua produk" alone means nothing - keep it checked
      }
    } else if (e.target.classList.contains('dash-product-option')) {
      if (e.target.checked) dashSelectedProducts.add(e.target.value);
      else dashSelectedProducts.delete(e.target.value);
      el('dashFilterProductAll').checked = dashSelectedProducts.size === 0;
    }
    updateDashProductToggleLabel();
    renderDashboard();
  });
  document.addEventListener('click', (e) => {
    if (!el('dashFilterProductMulti').contains(e.target)) {
      el('dashFilterProductPanel').classList.add('hidden');
    }
  });

  el('filterMode').addEventListener('change', () => {
    syncFilterVisibility(KONTAK_IDS, { single: 'filterSingleWrap', range: 'filterRangeWrap' });
    kontakPage = 1;
    renderKontak();
  });
  ['filterOwner', 'filterSingle', 'filterFrom', 'filterTo', 'searchBox'].forEach((id) => {
    el(id).addEventListener('input', () => {
      kontakPage = 1;
      renderKontak();
    });
  });

  el('kontakPrevBtn').addEventListener('click', () => {
    kontakPage -= 1;
    renderKontak();
  });
  el('kontakNextBtn').addEventListener('click', () => {
    kontakPage += 1;
    renderKontak();
  });

  el('selectAllCheckbox').addEventListener('change', () => {
    const checked = el('selectAllCheckbox').checked;
    document.querySelectorAll('.row-checkbox').forEach((cb) => {
      cb.checked = checked;
      if (checked) selectedIds.add(cb.dataset.id);
      else selectedIds.delete(cb.dataset.id);
    });
    updateSelectionUi();
  });
  el('deleteSelectedBtn').addEventListener('click', deleteSelected);

  syncFilterVisibility(KONTAK_IDS, { single: 'filterSingleWrap', range: 'filterRangeWrap' });

  const storedToken = localStorage.getItem(TOKEN_STORAGE);
  if (storedToken) {
    token = storedToken;
    try {
      await showAppScreen();
    } catch (e) {
      showLoginScreen();
    }
  } else {
    showLoginScreen();
  }
});
