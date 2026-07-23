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

const el = (id) => document.getElementById(id);

// Two independent filter bars share the same date/owner logic: the Dashboard
// page's filter only slices the stat cards, the Kontak page's filter (plus
// search) drives the table - they're intentionally not linked to each other.
const DASH_IDS = { owner: 'dashFilterOwner', mode: 'dashFilterMode', single: 'dashFilterSingle', from: 'dashFilterFrom', to: 'dashFilterTo' };
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

// ---- Dashboard page: stat cards only ----

function renderDashboard() {
  populateOwnerSelect(el(DASH_IDS.owner));
  const filter = readFilterState(DASH_IDS);

  const matched = Object.values(allChats).filter((chat) => {
    if (filter.owner !== 'all' && (chat.ownerNumber || '') !== filter.owner) return false;
    if (!matchesDateFilter(chat, filter)) return false;
    return true;
  });

  const totalLead = matched.length;
  const closingCount = matched.filter(isClosing).length;
  const rate = totalLead > 0 ? Math.round((closingCount / totalLead) * 1000) / 10 : 0;

  el('statTotal').textContent = totalLead;
  el('statClosing').textContent = closingCount;
  el('statRate').textContent = `${rate}%`;
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

function renderOrdersTable() {
  const sorted = allOrders.slice().sort((a, b) => {
    const ta = a.createdDate ? new Date(a.createdDate).getTime() : 0;
    const tb = b.createdDate ? new Date(b.createdDate).getTime() : 0;
    return tb - ta;
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
    `;
    tbody.appendChild(tr);
  });
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

async function importOrders() {
  const fileInput = el('orderImportFile');
  const file = fileInput.files[0];
  el('orderImportMsg').textContent = '';
  if (!file) {
    el('orderImportMsg').textContent = 'Pilih file .xlsx dulu.';
    return;
  }
  el('orderImportBtn').disabled = true;
  el('orderImportMsg').textContent = 'Mengimpor...';
  try {
    const result = await apiUploadFile('/api/orders/import', file);
    el('orderImportMsg').textContent =
      `${result.ordersImported} pesanan diimpor, ${result.productsCreated} produk baru, ` +
      `${result.contactsCreated} kontak baru` +
      (result.rowsSkipped > 0 ? `, ${result.rowsSkipped} baris dilewati (tanpa nomor HP)` : '') + '.';
    fileInput.value = '';
    ordersPage = 1;
    await loadOrders();
    // The import can create new products/contacts, so refresh the pages that
    // list them too - otherwise they'd look stale until manually reloaded.
    await Promise.all([loadProducts(), loadData()]);
  } catch (e) {
    if (e.message === 'unauthorized') {
      handleApiError(e);
      return;
    }
    el('orderImportMsg').textContent = e.message || 'Gagal mengimpor file.';
  } finally {
    el('orderImportBtn').disabled = false;
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
  el('usersPage').classList.toggle('hidden', page !== 'users');
  if (page === 'produk') loadProducts();
  if (page === 'pesanan') loadOrders();
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

  el('refreshBtn').addEventListener('click', loadData);
  el('dashRefreshBtn').addEventListener('click', loadData);
  el('ordersRefreshBtn').addEventListener('click', loadOrders);

  el('ordersPrevBtn').addEventListener('click', () => {
    ordersPage -= 1;
    renderOrdersTable();
  });
  el('ordersNextBtn').addEventListener('click', () => {
    ordersPage += 1;
    renderOrdersTable();
  });

  el('dashFilterMode').addEventListener('change', () => {
    syncFilterVisibility(DASH_IDS, { single: 'dashFilterSingleWrap', range: 'dashFilterRangeWrap' });
    renderDashboard();
  });
  ['dashFilterOwner', 'dashFilterSingle', 'dashFilterFrom', 'dashFilterTo'].forEach((id) => {
    el(id).addEventListener('input', renderDashboard);
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

  syncFilterVisibility(DASH_IDS, { single: 'dashFilterSingleWrap', range: 'dashFilterRangeWrap' });
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
