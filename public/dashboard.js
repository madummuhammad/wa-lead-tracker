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
let ordersPageSize = 10;
let ordersPage = 1;
let allPreOrders = [];
let preOrdersPageSize = 10;
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

async function apiUploadFile(path, file, extraFields) {
  const formData = new FormData();
  formData.append('file', file);
  if (extraFields) {
    Object.entries(extraFields).forEach(([key, value]) => formData.append(key, value));
  }
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

// Plain Dari/Sampai range check (inclusive) - simpler than matchesDateFilter
// above, which also handles Kontak's single-date/no-date modes. Used by the
// Pesanan and Pra-Pesanan filter bars.
function withinDateRange(dateValue, from, to) {
  if (!from && !to) return true;
  if (!dateValue) return false;
  const t = new Date(dateValue).getTime();
  if (from && t < new Date(`${from}T00:00:00`).getTime()) return false;
  if (to && t > new Date(`${to}T00:00:00`).getTime() + 24 * 60 * 60 * 1000 - 1) return false;
  return true;
}

// Generic checkbox multi-select ("Semua ..." + one row per option), shared by
// the Pesanan and Pra-Pesanan Produk filters. (Dashboard's own Produk filter
// predates this and keeps its separate, already-shipped implementation.)
const multiselectSelections = {}; // name -> Set<string>

function getMultiselectSelection(name) {
  if (!multiselectSelections[name]) multiselectSelections[name] = new Set();
  return multiselectSelections[name];
}

function updateMultiselectToggleLabel(name, ids) {
  const selected = getMultiselectSelection(name);
  const btn = el(ids.toggle);
  if (selected.size === 0) btn.textContent = 'Semua produk';
  else if (selected.size === 1) btn.textContent = chartTruncate(Array.from(selected)[0], 22);
  else btn.textContent = `${selected.size} produk dipilih`;
}

function renderMultiselectPanel(name, ids, options) {
  // Drop selections for values that no longer exist in the current data.
  const pruned = new Set(Array.from(getMultiselectSelection(name)).filter((v) => options.includes(v)));
  multiselectSelections[name] = pruned;

  const panel = el(ids.panel);
  panel.innerHTML = `
    <label class="multiselect-option">
      <input type="checkbox" id="${ids.all}" ${pruned.size === 0 ? 'checked' : ''} />
      Semua produk
    </label>
    <div class="multiselect-divider"></div>
    ${options.map((o) => `
      <label class="multiselect-option">
        <input type="checkbox" class="multiselect-item" value="${escapeHtml(o)}" ${pruned.has(o) ? 'checked' : ''} />
        ${escapeHtml(o)}
      </label>`).join('')}
  `;
  updateMultiselectToggleLabel(name, ids);
}

function wireMultiselect(name, ids, onChange) {
  el(ids.toggle).addEventListener('click', (e) => {
    e.stopPropagation();
    el(ids.panel).classList.toggle('hidden');
  });
  el(ids.panel).addEventListener('change', (e) => {
    const selected = getMultiselectSelection(name);
    if (e.target.id === ids.all) {
      if (e.target.checked) {
        selected.clear();
        el(ids.panel).querySelectorAll('.multiselect-item').forEach((cb) => { cb.checked = false; });
      } else {
        e.target.checked = true; // deselecting "Semua produk" alone means nothing
      }
    } else if (e.target.classList.contains('multiselect-item')) {
      if (e.target.checked) selected.add(e.target.value);
      else selected.delete(e.target.value);
      el(ids.all).checked = selected.size === 0;
    }
    updateMultiselectToggleLabel(name, ids);
    onChange();
  });
  document.addEventListener('click', (e) => {
    if (!el(ids.multi).contains(e.target)) el(ids.panel).classList.add('hidden');
  });
}

// ---- Column show/hide toggle ("Kolom" button) - generic for any table whose
// <th>/<td> pairs share a matching data-col attribute (see index.html). Which
// columns are hidden is persisted in localStorage per table, so the choice
// survives a reload; visibility itself is applied via one injected <style>
// per table rather than touching each cell directly, since table bodies here
// get fully re-rendered on every filter/page change and a DOM-attribute
// approach would have to be re-applied after every one of those re-renders.
const COLUMN_VISIBILITY_STORAGE = 'waLeadHiddenColumns';

function loadHiddenColumnsStore() {
  try {
    return JSON.parse(localStorage.getItem(COLUMN_VISIBILITY_STORAGE) || '{}');
  } catch (e) {
    return {};
  }
}

function saveHiddenColumnsStore(store) {
  localStorage.setItem(COLUMN_VISIBILITY_STORAGE, JSON.stringify(store));
}

function setupColumnVisibility({ tableId, multiId, toggleId, panelId }) {
  const table = el(tableId);
  const headerCells = Array.from(table.querySelectorAll('thead th[data-col]'));
  if (headerCells.length === 0) return;

  const columns = headerCells.map((th) => ({ key: th.dataset.col, label: th.textContent.trim() }));
  const store = loadHiddenColumnsStore();
  const hidden = new Set(store[tableId] || []);

  const styleEl = document.createElement('style');
  document.head.appendChild(styleEl);

  const applyStyle = () => {
    styleEl.textContent = Array.from(hidden)
      .map((key) => `#${tableId} [data-col="${key}"] { display: none; }`)
      .join('\n');
  };
  const updateToggleLabel = () => {
    el(toggleId).textContent = hidden.size === 0 ? 'Kolom' : `Kolom (${hidden.size} disembunyikan)`;
  };
  const renderPanel = () => {
    el(panelId).innerHTML = columns.map((c) => `
      <label class="multiselect-option">
        <input type="checkbox" class="column-toggle-item" value="${escapeHtml(c.key)}" ${hidden.has(c.key) ? '' : 'checked'} />
        ${escapeHtml(c.label)}
      </label>`).join('');
  };

  renderPanel();
  applyStyle();
  updateToggleLabel();

  el(toggleId).addEventListener('click', (e) => {
    e.stopPropagation();
    el(panelId).classList.toggle('hidden');
  });
  el(panelId).addEventListener('change', (e) => {
    if (!e.target.classList.contains('column-toggle-item')) return;
    if (e.target.checked) hidden.delete(e.target.value);
    else hidden.add(e.target.value);
    store[tableId] = Array.from(hidden);
    saveHiddenColumnsStore(store);
    applyStyle();
    updateToggleLabel();
  });
  document.addEventListener('click', (e) => {
    if (!el(multiId).contains(e.target)) el(panelId).classList.add('hidden');
  });
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
        <td data-col="nama">${escapeHtml(chat.name || '-')}</td>
        <td data-col="nomor">${escapeHtml(chat.phone || '-')}</td>
        <td data-col="akunWa">${escapeHtml(chat.ownerNumber || '-')}</td>
        <td data-col="tanggalLead">
          ${escapeHtml(display)}
          <button class="edit-btn" data-id="${escapeHtml(chat.id)}" title="Isi tanggal lead manual">✎</button>
        </td>
        <td data-col="status">${closing ? '<span class="status-pill">Closing</span>' : ''}</td>
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
// Maps each field to the data-col key its <th> carries in index.html, for
// the Kolom show/hide toggle (see setupColumnVisibility below).
const PRODUCT_DIM_COL = { weight: 'berat', volume: 'volume', length: 'panjang', width: 'lebar', height: 'tinggi' };

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
          .map((field) => `<td data-col="${PRODUCT_DIM_COL[field]}"><input type="number" class="edit-product-${field}" min="0" value="${escapeHtml(product[field] ?? '')}" /></td>`)
          .join('');
        tr.innerHTML = `
          <td data-col="nama"><input type="text" class="edit-product-name" value="${escapeHtml(product.name)}" /></td>
          <td data-col="harga"><input type="number" class="edit-product-price" min="0" value="${escapeHtml(product.price)}" /></td>
          ${dimInputs}
          <td>
            <button class="save-product-btn" data-id="${escapeHtml(product.id)}">Simpan</button>
            <button class="cancel-product-btn">Batal</button>
          </td>
        `;
      } else {
        const dimCells = PRODUCT_DIM_FIELDS
          .map((field) => `<td data-col="${PRODUCT_DIM_COL[field]}">${escapeHtml(formatDim(product[field]))}</td>`)
          .join('');
        tr.innerHTML = `
          <td data-col="nama">${escapeHtml(product.name)}</td>
          <td data-col="harga">${escapeHtml(formatRupiah(product.price))}</td>
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

const ORDER_PRODUCT_MULTISELECT = {
  multi: 'orderFilterProductMulti', toggle: 'orderFilterProductToggle',
  panel: 'orderFilterProductPanel', all: 'orderFilterProductAll',
};

function populateOrderStatusSelect(select) {
  const statuses = Array.from(new Set(allOrders.map((o) => o.status).filter(Boolean))).sort();
  const previousValue = select.value || 'all';
  select.innerHTML = '<option value="all">Semua Status</option>' +
    statuses.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  select.value = statuses.includes(previousValue) || previousValue === 'all' ? previousValue : 'all';
}

function populateOrderOwnerSelect(select) {
  const owners = Array.from(new Set(allOrders.map((o) => o.ownerNumber).filter(Boolean))).sort();
  const previousValue = select.value || 'all';
  select.innerHTML = '<option value="all">Semua akun</option>' +
    owners.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
  select.value = owners.includes(previousValue) || previousValue === 'all' ? previousValue : 'all';
}

function renderOrdersTable() {
  populateOrderStatusSelect(el('orderFilterStatus'));
  populateOrderOwnerSelect(el('orderFilterOwner'));
  const orderProductNames = Array.from(new Set(allOrders.map((o) => o.productName).filter(Boolean))).sort();
  renderMultiselectPanel('orderProduct', ORDER_PRODUCT_MULTISELECT, orderProductNames);

  const statusFilter = el('orderFilterStatus').value;
  const ownerFilter = el('orderFilterOwner').value;
  const from = el('orderFilterFrom').value;
  const to = el('orderFilterTo').value;
  const selectedProducts = getMultiselectSelection('orderProduct');
  const q = el('orderSearchBox').value.trim().toLowerCase();

  const filtered = allOrders.filter((order) => {
    if (statusFilter !== 'all' && (order.status || '') !== statusFilter) return false;
    if (ownerFilter !== 'all' && (order.ownerNumber || '') !== ownerFilter) return false;
    if (selectedProducts.size > 0 && !selectedProducts.has(order.productName || '')) return false;
    if (!withinDateRange(order.createdDate, from, to)) return false;
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

  const totalPages = Math.max(1, Math.ceil(sorted.length / ordersPageSize));
  if (ordersPage > totalPages) ordersPage = totalPages;
  if (ordersPage < 1) ordersPage = 1;
  const pageStart = (ordersPage - 1) * ordersPageSize;
  const pageItems = sorted.slice(pageStart, pageStart + ordersPageSize);

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
      <td data-col="noOrder">${escapeHtml(order.id)}</td>
      <td data-col="tanggal">${escapeHtml(dateDisplay)}</td>
      <td data-col="penerima">${escapeHtml(order.customerName || '-')}</td>
      <td data-col="noHp">${escapeHtml(order.customerPhone || '-')}</td>
      <td data-col="produk">${escapeHtml(order.productName || '-')}</td>
      <td data-col="jumlah">${escapeHtml(order.qty ?? '-')}</td>
      <td data-col="harga">${escapeHtml(formatRupiah(order.price))}</td>
      <td data-col="akunWa">${escapeHtml(order.ownerNumber || '-')}</td>
      <td data-col="status">${escapeHtml(order.status || '-')}</td>
      <td data-col="resi">${escapeHtml(order.trackingNumber || '-')}</td>
      <td>
        <button class="edit-product-btn edit-order-btn" data-id="${escapeHtml(order.id)}">Edit</button>
        <button class="delete-product-btn delete-order-btn" data-id="${escapeHtml(order.id)}">Hapus</button>
      </td>
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
  tbody.querySelectorAll('.edit-order-btn').forEach((btn) => {
    btn.addEventListener('click', () => startEditOrder(btn.dataset.id));
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

// ---- Orders (Pesanan) - edit modal ----

let editingOrderId = null;

// [form element id, Order field name] - covers every plain text/number field.
// createdDate/receivedDate (dates) and productName (own select + price
// autofill) are handled separately below.
const ORDER_FORM_TEXT_FIELDS = [
  ['orderCustomerName', 'customerName'],
  ['orderCustomerPhone', 'customerPhone'],
  ['orderAddress', 'address'],
  ['orderCity', 'city'],
  ['orderZipcode', 'zipcode'],
  ['orderShippingType', 'shippingType'],
  ['orderCourier', 'courier'],
  ['orderOwnerNumber', 'ownerNumber'],
  ['orderQty', 'qty'],
  ['orderWeight', 'weight'],
  ['orderVolume', 'volume'],
  ['orderPrice', 'price'],
  ['orderShippingCost', 'shippingCost'],
  ['orderCodDiscount', 'codDiscount'],
  ['orderCodFee', 'codFee'],
  ['orderCodValue', 'codValue'],
  ['orderStatus', 'status'],
  ['orderTrackingNumber', 'trackingNumber'],
  ['orderRefCode', 'refCode'],
  ['orderReconciliationStatus', 'reconciliationStatus'],
  ['orderWarehouseAdminName', 'warehouseAdminName'],
  ['orderNote', 'note'],
];

// Options come from the Product catalog (same source of truth as the Produk
// page and the Pra-Pesanan form), not free text.
function populateOrderProductSelect(currentValue) {
  const select = el('orderProductName');
  const names = Array.from(new Set(allProducts.map((p) => p.name).filter(Boolean))).sort();
  if (currentValue && !names.includes(currentValue)) names.unshift(currentValue);
  select.innerHTML = '<option value="">Pilih Produk</option>' +
    names.map((name) => `<option value="${escapeHtml(name)}" ${name === currentValue ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('');
}

// Harga Produk is pre-filled from the catalog price when a product is
// picked, but stays a normal editable number field afterward - same
// per-order-can-differ-from-catalog reasoning as the Pra-Pesanan form.
function applyOrderProductPrice() {
  const product = allProducts.find((p) => p.name === el('orderProductName').value);
  if (product && product.price !== undefined && product.price !== null) {
    el('orderPrice').value = product.price;
  }
}

function readOrderForm() {
  const body = {};
  ORDER_FORM_TEXT_FIELDS.forEach(([elId, key]) => { body[key] = el(elId).value; });
  body.productName = el('orderProductName').value;
  body.createdDate = el('orderCreatedDate').value || undefined;
  body.receivedDate = el('orderReceivedDate').value || undefined;
  return body;
}

function fillOrderForm(order) {
  ORDER_FORM_TEXT_FIELDS.forEach(([elId, key]) => { el(elId).value = order[key] ?? ''; });
  el('orderCreatedDate').value = order.createdDate ? new Date(order.createdDate).toISOString().slice(0, 10) : '';
  el('orderReceivedDate').value = order.receivedDate ? new Date(order.receivedDate).toISOString().slice(0, 10) : '';
}

function resetOrderForm() {
  ORDER_FORM_TEXT_FIELDS.forEach(([elId]) => { el(elId).value = ''; });
  el('orderCreatedDate').value = '';
  el('orderReceivedDate').value = '';
  editingOrderId = null;
  el('orderFormMsg').textContent = '';
  el('orderNumberDisplay').textContent = '';
}

function closeOrderFormModal() {
  el('orderFormModal').classList.add('hidden');
  resetOrderForm();
}

async function startEditOrder(id) {
  const order = allOrders.find((o) => o.id === id);
  if (!order) return;
  await loadProducts();
  populateOrderProductSelect(order.productName);
  fillOrderForm(order);
  editingOrderId = id;
  el('orderFormMsg').textContent = '';
  el('orderNumberDisplay').textContent = `No. Order: ${order.id}`;
  el('orderFormModal').classList.remove('hidden');
}

async function saveOrder() {
  if (!editingOrderId) return;
  const body = readOrderForm();
  try {
    await apiPut(`/api/orders/${editingOrderId}`, body);
    closeOrderFormModal();
    await loadOrders();
    // Editing the product name can create a new catalog entry, same as import.
    await loadProducts();
  } catch (e) {
    if (e.message === 'unauthorized') {
      handleApiError(e);
      return;
    }
    el('orderFormMsg').textContent = e.message || 'Gagal menyimpan pesanan.';
  }
}

// Shared by both the Pesanan page's import controls and the duplicate set on
// the Pra-Pesanan page (same underlying action - a lincah import moves any
// matching pre-orders out, so it's genuinely useful to trigger from either
// page rather than forcing a page switch).
// Two-phase import: a dry run first to see if any row's product couldn't be
// resolved (no matching Pra-Pesanan, no exact catalog name); if so, prompt
// the admin to map each one to an existing catalog product before actually
// committing anything. Returns the final commit result, or null if the
// admin cancelled the mapping popup (nothing was imported in that case).
async function importFileWithProductResolution(url, file, msgElId) {
  el(msgElId).textContent = 'Memeriksa file...';
  const dryRunUrl = url + (url.includes('?') ? '&' : '?') + 'dryRun=true';
  const preview = await apiUploadFile(dryRunUrl, file);
  let productMapping;
  if (preview.unresolvedProducts && preview.unresolvedProducts.length > 0) {
    await loadProducts();
    productMapping = await promptProductMapping(preview.unresolvedProducts);
    if (!productMapping) return null;
  }
  el(msgElId).textContent = 'Mengimpor...';
  return apiUploadFile(url, file, productMapping ? { productMapping: JSON.stringify(productMapping) } : undefined);
}

// Shows the shared "Pilih Produk" modal for raw product names (from an
// import file) nothing could resolve automatically. Resolves to a
// { rawName: { productId, productName } } map once every row is filled in
// and the admin confirms "Lanjutkan Impor", or null if they cancel.
function promptProductMapping(names) {
  return new Promise((resolve) => {
    const list = el('productMappingList');
    const sortedProducts = allProducts.slice().sort((a, b) => a.name.localeCompare(b.name));
    list.innerHTML = names.map((name) => {
      const lower = name.trim().toLowerCase();
      const options = sortedProducts
        .map((p) => `<option value="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" ${p.name.trim().toLowerCase() === lower ? 'selected' : ''}>${escapeHtml(p.name)}</option>`)
        .join('');
      return `
        <label class="form-field" data-raw-name="${escapeHtml(name)}">
          <span>${escapeHtml(name)}</span>
          <select><option value="">Pilih Produk</option>${options}</select>
        </label>`;
    }).join('');
    el('productMappingMsg').textContent = '';
    el('productMappingModal').classList.remove('hidden');

    const overlay = el('productMappingModal');
    let mouseDownOnBackdrop = false;
    function onBackdropMouseDown(e) {
      mouseDownOnBackdrop = e.target === overlay;
    }
    // Same click-outside gate used by the other modals - only closes if both
    // the mousedown and the click resolved to the overlay itself, so a text
    // selection that ends outside the modal box doesn't dismiss it.
    function onBackdropClick(e) {
      if (mouseDownOnBackdrop && e.target === overlay) onCancel();
      mouseDownOnBackdrop = false;
    }

    function cleanup() {
      overlay.classList.add('hidden');
      el('productMappingConfirmBtn').removeEventListener('click', onConfirm);
      el('productMappingCancelBtn').removeEventListener('click', onCancel);
      el('productMappingCloseBtn').removeEventListener('click', onCancel);
      overlay.removeEventListener('mousedown', onBackdropMouseDown);
      overlay.removeEventListener('click', onBackdropClick);
    }
    function onConfirm() {
      const rows = list.querySelectorAll('[data-raw-name]');
      const mapping = {};
      let allFilled = true;
      rows.forEach((rowEl) => {
        const select = rowEl.querySelector('select');
        if (!select.value) {
          allFilled = false;
          return;
        }
        const option = select.options[select.selectedIndex];
        mapping[rowEl.dataset.rawName] = { productId: select.value, productName: option.dataset.name };
      });
      if (!allFilled) {
        el('productMappingMsg').textContent = 'Pilih produk untuk semua baris dulu.';
        return;
      }
      cleanup();
      resolve(mapping);
    }
    function onCancel() {
      cleanup();
      resolve(null);
    }
    el('productMappingConfirmBtn').addEventListener('click', onConfirm);
    el('productMappingCancelBtn').addEventListener('click', onCancel);
    el('productMappingCloseBtn').addEventListener('click', onCancel);
    overlay.addEventListener('mousedown', onBackdropMouseDown);
    overlay.addEventListener('click', onBackdropClick);
  });
}

async function importLincahOrders(ids) {
  const fileInput = el(ids.file);
  const file = fileInput.files[0];
  el(ids.msg).textContent = '';
  if (!file) {
    el(ids.msg).textContent = 'Pilih file .xlsx dulu.';
    return;
  }
  el(ids.btn).disabled = true;
  try {
    const url = ids.onlyMatched ? '/api/orders/import?onlyMatched=true' : '/api/orders/import';
    const result = await importFileWithProductResolution(url, file, ids.msg);
    if (!result) {
      el(ids.msg).textContent = '';
      return;
    }
    el(ids.msg).textContent =
      `${result.ordersImported} pesanan diimpor, ${result.contactsCreated} kontak baru` +
      (result.rowsSkipped > 0 ? `, ${result.rowsSkipped} baris dilewati (tanpa nomor HP)` : '') +
      (result.rowsUnmatchedSkipped > 0 ? `, ${result.rowsUnmatchedSkipped} baris dilewati (tidak cocok dengan pra-pesanan)` : '') +
      (result.rowsProductUnresolvedSkipped > 0 ? `, ${result.rowsProductUnresolvedSkipped} baris dilewati (produk tidak dipilih)` : '') +
      (result.preOrdersMoved > 0 ? `, ${result.preOrdersMoved} pra-pesanan dipindahkan ke pesanan` : '') + '.';
    fileInput.value = '';
    ordersPage = 1;
    await loadOrders();
    if (ids.modal) el(ids.modal).classList.add('hidden');
    // The import can create new contacts, and can also mark matching
    // pre-orders converted server-side - refresh all of them so nothing
    // looks stale until manually reloaded.
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
    modal: 'preOrderLincahImportModal', onlyMatched: true,
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
  recalcPreOrderTotals();
}

// Total Harga/Total Tagihan are derived, read-only fields - not free text -
// so a wrong manual total can never drift from what Qty/Harga Satuan/Ongkir
// actually say. Total Harga = Qty x Harga Satuan; Total Tagihan = Total
// Harga + Ongkir.
function recalcPreOrderTotals() {
  const qty = Number(el('preOrderQty').value) || 0;
  const unitPrice = Number(el('preOrderUnitPrice').value) || 0;
  const shippingCost = Number(el('preOrderShippingCost').value) || 0;
  const totalPrice = qty * unitPrice;
  const totalBill = totalPrice + shippingCost;
  el('preOrderTotalPrice').value = totalPrice;
  el('preOrderTotalBill').value = totalBill;
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
  ['preOrderCampaignSource', 'campaignSource'],
  ['preOrderNote', 'note'],
];
// paymentStatus/courier/noResi/statusOrder/ctt are intentionally not in the
// form - nothing is known about them yet when a pre-order is first entered
// (before it's even placed on lincah). They still exist on the PreOrder
// model (populated later by the "Impor Data Order"/"Impor dari Lincah"
// imports, or left blank) - the form simply never sends them, and the
// backend's $set drops undefined keys, so editing a pre-order through this
// form can't accidentally wipe out values an import already filled in.

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
  // Re-derive rather than trust whatever totalPrice/totalBill was already
  // stored - keeps old rows consistent with the formula the moment they're
  // opened for editing, instead of only on the next manual edit.
  recalcPreOrderTotals();
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

const PREORDER_PRODUCT_MULTISELECT = {
  multi: 'preOrderFilterProductMulti', toggle: 'preOrderFilterProductToggle',
  panel: 'preOrderFilterProductPanel', all: 'preOrderFilterProductAll',
};

function populatePreOrderCreatorFilterSelect(select) {
  const creators = Array.from(new Set(allPreOrders.map((p) => p.createdByEmail).filter(Boolean))).sort();
  const previousValue = select.value || 'all';
  select.innerHTML = '<option value="all">Semua CS</option>' +
    creators.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  select.value = creators.includes(previousValue) || previousValue === 'all' ? previousValue : 'all';
}

// Kabari Proses/Resi status for one Pra-Pesanan row, mirroring the same two
// per-chat flags the extension's floating panel toggles: Chat.preOrderNotified
// tied to *this* row's own orderNumber, Chat.resiNotified tied to the Order
// it converted into (if any) - so a chat's marks from an unrelated, earlier
// Pra-Pesanan/Order never leak onto a different row for the same phone.
// Unlike the extension's chat-list "Belum Di Input" state, there's no
// equivalent here - a Pra-Pesanan row is by definition already entered into
// the system, so this only ever has 3 states.
function preOrderNotifyStatus(preOrder) {
  const chat = preOrder.customerPhone ? allChats[preOrder.customerPhone] : null;
  if (chat && chat.resiNotified === true && preOrder.convertedOrderId
    && chat.resiNotifiedOrderId === preOrder.convertedOrderId) {
    return { state: 'dikirim', text: 'Dikirim' };
  }
  if (chat && chat.preOrderNotified === true && chat.preOrderNotifiedOrderNumber === preOrder.orderNumber) {
    return { state: 'proses', text: 'Di Proses' };
  }
  return { state: 'belum', text: 'Belum Dikabari' };
}

// Clicking the Status Kabar pill advances it one stage - Belum Dikabari ->
// Di Proses -> Dikirim -> back to Belum Dikabari - writing to the same
// Chat.preOrderNotified/resiNotified fields (with their paired *UpdatedAt
// timestamps) the extension's floating panel toggles, so an edit made here
// is indistinguishable from one made in WhatsApp Web and merges the same way
// across devices. Dikirim is only reachable once this row has actually
// become a real Pesanan (preOrder.convertedOrderId set) - clicking Di Proses
// before that just cycles back to Belum Dikabari instead, since there's no
// resi to have told the customer about yet.
async function togglePreOrderNotifyStatus(id) {
  const preOrder = allPreOrders.find((p) => p.id === id);
  if (!preOrder) return;
  if (!preOrder.customerPhone) {
    alert('Pra-pesanan ini tidak punya nomor HP/WA, jadi statusnya tidak bisa disimpan.');
    return;
  }

  const status = preOrderNotifyStatus(preOrder);
  const chat = { ...(allChats[preOrder.customerPhone] || { id: preOrder.customerPhone, phone: preOrder.customerPhone }) };
  const now = new Date().toISOString();

  if (status.state === 'belum') {
    chat.preOrderNotified = true;
    chat.preOrderNotifiedOrderNumber = preOrder.orderNumber;
    chat.preOrderNotifiedUpdatedAt = now;
  } else if (status.state === 'proses' && preOrder.convertedOrderId) {
    chat.resiNotified = true;
    chat.resiNotifiedOrderId = preOrder.convertedOrderId;
    chat.resiNotifiedUpdatedAt = now;
  } else {
    // Either already "Dikirim", or "Di Proses" with no Order to attach a
    // resi status to yet - both cases reset to the start of the cycle.
    chat.preOrderNotified = false;
    chat.preOrderNotifiedUpdatedAt = now;
    chat.resiNotified = false;
    chat.resiNotifiedUpdatedAt = now;
  }

  try {
    await apiPut('/api/chats', { [preOrder.customerPhone]: chat });
    allChats[preOrder.customerPhone] = chat;
    renderPreOrdersTable();
  } catch (e) {
    handleApiError(e, 'Gagal menyimpan status kabar.');
  }
}

// Status Respon - whether the customer actually replied to the CS's
// confirmation message, as opposed to Status Kabar above (whether *this
// business* told the customer something). Lives directly on the PreOrder
// itself (PreOrder.responseStatus), not on Chat - it's specific to this one
// pre-order's confirmation, not a per-contact fact. Edited the same
// click-to-cycle way as Status Kabar, but through its own dedicated
// PUT /api/preorders/:id/response-status (see server/app.js) rather than the
// general pre-order PUT, since that one always rewrites the whole record.
const RESPONSE_STATUS_CYCLE = ['belum_membalas', 'jadi_dikirim', 'dibatalkan'];
const RESPONSE_STATUS_LABELS = {
  belum_membalas: 'Belum Membalas',
  jadi_dikirim: 'Jadi Dikirim',
  dibatalkan: 'Dibatalkan',
};

function preOrderResponseStatus(preOrder) {
  const state = RESPONSE_STATUS_CYCLE.includes(preOrder.responseStatus) ? preOrder.responseStatus : 'belum_membalas';
  return { state, text: RESPONSE_STATUS_LABELS[state] };
}

async function togglePreOrderResponseStatus(id) {
  const preOrder = allPreOrders.find((p) => p.id === id);
  if (!preOrder) return;
  const current = preOrderResponseStatus(preOrder).state;
  const next = RESPONSE_STATUS_CYCLE[(RESPONSE_STATUS_CYCLE.indexOf(current) + 1) % RESPONSE_STATUS_CYCLE.length];
  try {
    await apiPut(`/api/preorders/${id}/response-status`, { responseStatus: next });
    preOrder.responseStatus = next;
    renderPreOrdersTable();
  } catch (e) {
    handleApiError(e, 'Gagal menyimpan status respon.');
  }
}

// Which of our own WA accounts this pre-order's customer came in through -
// derived read-only from Chat.ownerNumber (set when the extension scans that
// phone in WhatsApp Web), keyed the same way Status Kabar/Status Respon
// cross-reference allChats. PreOrder itself has no ownerNumber field of its
// own - if this phone was never scanned by the extension, there's simply
// nothing to show it from.
function preOrderOwnerNumber(preOrder) {
  const chat = preOrder.customerPhone ? allChats[preOrder.customerPhone] : null;
  return (chat && chat.ownerNumber) || null;
}

function renderPreOrdersTable() {
  populatePreOrderCreatorFilterSelect(el('preOrderFilterCreator'));
  populateOwnerSelect(el('preOrderFilterOwner'));
  const preOrderProductNames = Array.from(new Set(allPreOrders.map((p) => p.productName).filter(Boolean))).sort();
  renderMultiselectPanel('preOrderProduct', PREORDER_PRODUCT_MULTISELECT, preOrderProductNames);

  const creatorFilter = el('preOrderFilterCreator').value;
  const ownerFilter = el('preOrderFilterOwner').value;
  const from = el('preOrderFilterFrom').value;
  const to = el('preOrderFilterTo').value;
  const selectedProducts = getMultiselectSelection('preOrderProduct');
  const notifyStatusFilter = el('preOrderFilterNotifyStatus').value;
  const responseStatusFilter = el('preOrderFilterResponseStatus').value;

  const filtered = allPreOrders.filter((p) => {
    if (creatorFilter !== 'all' && (p.createdByEmail || '') !== creatorFilter) return false;
    // Same Chat.ownerNumber lookup the Akun WA column itself displays (see
    // preOrderOwnerNumber) - a pre-order whose phone was never scanned by
    // the extension has no owner to match against, so it's excluded by any
    // specific Akun WA filter (only "Semua akun" shows it).
    if (ownerFilter !== 'all' && preOrderOwnerNumber(p) !== ownerFilter) return false;
    if (selectedProducts.size > 0 && !selectedProducts.has(p.productName || '')) return false;
    if (!withinDateRange(p.orderDate, from, to)) return false;
    if (notifyStatusFilter !== 'all' && preOrderNotifyStatus(p).state !== notifyStatusFilter) return false;
    if (responseStatusFilter !== 'all' && preOrderResponseStatus(p).state !== responseStatusFilter) return false;
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

  const totalPages = Math.max(1, Math.ceil(sorted.length / preOrdersPageSize));
  if (preOrdersPage > totalPages) preOrdersPage = totalPages;
  if (preOrdersPage < 1) preOrdersPage = 1;
  const pageStart = (preOrdersPage - 1) * preOrdersPageSize;
  const pageItems = sorted.slice(pageStart, pageStart + preOrdersPageSize);

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
    const notifyStatus = preOrderNotifyStatus(preOrder);
    const responseStatus = preOrderResponseStatus(preOrder);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="checkbox" class="preorder-row-checkbox" data-id="${escapeHtml(preOrder.id)}" ${selectedPreOrderIds.has(preOrder.id) ? 'checked' : ''} /></td>
      <td data-col="noOrder">${escapeHtml(preOrder.orderNumber || '-')}</td>
      <td data-col="noOrderPesanan">${escapeHtml(preOrder.convertedOrderId || '-')}</td>
      <td data-col="tanggalOrder">${escapeHtml(dateDisplay)}</td>
      <td data-col="statusKabar">
        <button type="button" class="notify-pill notify-pill--${notifyStatus.state} notify-pill-btn" data-id="${escapeHtml(preOrder.id)}" title="Klik untuk ubah status: Belum Dikabari → Di Proses → Dikirim → ulang">${escapeHtml(notifyStatus.text)}</button>
      </td>
      <td data-col="statusRespon">
        <button type="button" class="response-pill response-pill--${responseStatus.state} response-pill-btn" data-id="${escapeHtml(preOrder.id)}" title="Klik untuk ubah status: Belum Membalas → Jadi Dikirim → Dibatalkan → ulang">${escapeHtml(responseStatus.text)}</button>
      </td>
      <td data-col="namaCustomer">${escapeHtml(preOrder.customerName || '-')}</td>
      <td data-col="noHp">${escapeHtml(preOrder.customerPhone || '-')}</td>
      <td data-col="akunWa">${escapeHtml(preOrderOwnerNumber(preOrder) || '-')}</td>
      <td data-col="alamat">${escapeHtml(preOrder.address || '-')}</td>
      <td data-col="produk">${escapeHtml(preOrder.productName || '-')}</td>
      <td data-col="qty">${escapeHtml(preOrder.qty ?? '-')}</td>
      <td data-col="hargaSatuan">${escapeHtml(formatRupiah(preOrder.unitPrice))}</td>
      <td data-col="totalHarga">${escapeHtml(formatRupiah(preOrder.totalPrice))}</td>
      <td data-col="ongkir">${escapeHtml(formatRupiah(preOrder.shippingCost))}</td>
      <td data-col="totalTagihan">${escapeHtml(formatRupiah(preOrder.totalBill))}</td>
      <td data-col="metodeBayar">${escapeHtml(preOrder.paymentMethod || '-')}</td>
      <td data-col="noResi">${escapeHtml(preOrder.noResi || '-')}</td>
      <td data-col="statusOrder">${escapeHtml(preOrder.statusOrder || '-')}</td>
      <td data-col="sumberCampaign">${escapeHtml(preOrder.campaignSource || '-')}</td>
      <td data-col="catatan">${escapeHtml(preOrder.note || '-')}</td>
      <td data-col="lincah">${preOrder.lincah ? '✓' : '-'}</td>
      <td data-col="aneka">${preOrder.aneka ? '✓' : '-'}</td>
      <td data-col="dibuatOleh">${escapeHtml(preOrder.createdByEmail || '-')}</td>
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
  tbody.querySelectorAll('.notify-pill-btn').forEach((btn) => {
    btn.addEventListener('click', () => togglePreOrderNotifyStatus(btn.dataset.id));
  });
  tbody.querySelectorAll('.response-pill-btn').forEach((btn) => {
    btn.addEventListener('click', () => togglePreOrderResponseStatus(btn.dataset.id));
  });

  updatePreOrdersSelectionUi();
}

function updatePreOrdersSelectionUi() {
  const count = selectedPreOrderIds.size;
  el('preOrdersDeleteSelectedBtn').disabled = count === 0;
  el('preOrdersMarkAnekaSelectedBtn').disabled = count === 0;
  el('preOrdersUnmarkAnekaSelectedBtn').disabled = count === 0;
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

// Bulk ANEKA toggle - LINCAH fills in automatically from the "Data Order"
// sheet's own column on import, but ANEKA has never had a source to fill it
// from, so it's always had to be ticked one row at a time in the edit form.
// This reuses the same row-selection checkboxes the table already has for
// "Hapus yang Dipilih" to set it for many rows in one click instead.
let preOrdersBulkActionMsgTimer = null;

async function bulkSetPreOrderAneka(aneka) {
  const ids = Array.from(selectedPreOrderIds);
  if (ids.length === 0) return;

  const msgEl = el('preOrdersBulkActionMsg');
  const markBtn = el('preOrdersMarkAnekaSelectedBtn');
  const unmarkBtn = el('preOrdersUnmarkAnekaSelectedBtn');
  clearTimeout(preOrdersBulkActionMsgTimer);
  markBtn.disabled = true;
  unmarkBtn.disabled = true;
  msgEl.textContent = aneka ? 'Menandai ANEKA...' : 'Membatalkan ANEKA...';

  try {
    await apiPost('/api/preorders/bulk-aneka', { ids, aneka });
    allPreOrders.forEach((p) => {
      if (selectedPreOrderIds.has(p.id)) p.aneka = aneka;
    });
    selectedPreOrderIds.clear(); // done with this batch - same as delete, don't leave rows checked
    renderPreOrdersTable();
    msgEl.textContent = aneka
      ? `✓ ${ids.length} pra-pesanan ditandai ANEKA.`
      : `✓ ANEKA dibatalkan untuk ${ids.length} pra-pesanan.`;
    preOrdersBulkActionMsgTimer = setTimeout(() => { msgEl.textContent = ''; }, 3000);
  } catch (e) {
    msgEl.textContent = '';
    markBtn.disabled = false;
    unmarkBtn.disabled = false;
    handleApiError(e, 'Gagal menandai ANEKA.');
  }
}

function getPreOrderStatusFilter() {
  const activeTab = document.querySelector('#preOrderStatusTabs .tab-btn.active');
  return (activeTab && activeTab.dataset.status) || 'active';
}

async function loadPreOrders() {
  el('preOrdersLoadingState').classList.remove('hidden');
  try {
    const status = getPreOrderStatusFilter();
    const { preOrders } = await apiGet(`/api/preorders?status=${status}`);
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
  try {
    const result = await importFileWithProductResolution('/api/preorders/import', file, 'preOrderImportMsg');
    if (!result) {
      el('preOrderImportMsg').textContent = '';
      return;
    }
    el('preOrderImportMsg').textContent =
      `${result.added} pra-pesanan baru ditambahkan` +
      (result.skippedDuplicate > 0 ? `, ${result.skippedDuplicate} dilewati (sudah ada)` : '') +
      (result.rowsProductUnresolvedSkipped > 0 ? `, ${result.rowsProductUnresolvedSkipped} dilewati (produk tidak dipilih)` : '') + '.';
    fileInput.value = '';
    preOrdersPage = 1;
    await loadPreOrders();
    closePreOrderImportModal();
    // Same as manual create - can create a new contact.
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

// ---- Message templates (extension's "Kabar Pra-Pesanan" quick replies) ----

let allTemplates = [];
let editingTemplateId = null;

function renderTemplatesTable() {
  const tbody = el('templatesTableBody');
  tbody.innerHTML = '';
  el('templatesEmptyState').classList.toggle('hidden', allTemplates.length > 0);

  allTemplates.forEach((t) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(t.label)}</td>
      <td class="template-text-cell">${escapeHtml(t.text)}</td>
      <td>
        <button class="edit-product-btn edit-template-btn" data-id="${escapeHtml(t.id)}">Edit</button>
        <button class="delete-product-btn delete-template-btn" data-id="${escapeHtml(t.id)}">Hapus</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.edit-template-btn').forEach((btn) => {
    btn.addEventListener('click', () => startEditTemplate(btn.dataset.id));
  });
  tbody.querySelectorAll('.delete-template-btn').forEach((btn) => {
    btn.addEventListener('click', () => deleteTemplate(btn.dataset.id));
  });
}

async function loadTemplates() {
  el('templatesLoadingState').classList.remove('hidden');
  try {
    const { templates } = await apiGet('/api/message-templates');
    allTemplates = templates;
    renderTemplatesTable();
  } catch (e) {
    handleApiError(e, 'Gagal memuat daftar template.');
  } finally {
    el('templatesLoadingState').classList.add('hidden');
  }
}

function resetTemplateForm() {
  el('templateLabel').value = '';
  el('templateText').value = '';
  editingTemplateId = null;
  el('templateFormTitle').textContent = 'Tambah Template Baru';
  el('templateSaveBtn').textContent = 'Tambah';
  el('templateFormMsg').textContent = '';
}

function openTemplateAddModal() {
  resetTemplateForm();
  el('templateFormModal').classList.remove('hidden');
}

function closeTemplateFormModal() {
  el('templateFormModal').classList.add('hidden');
  resetTemplateForm();
}

function startEditTemplate(id) {
  const template = allTemplates.find((t) => t.id === id);
  if (!template) return;
  el('templateLabel').value = template.label;
  el('templateText').value = template.text;
  editingTemplateId = id;
  el('templateFormTitle').textContent = 'Edit Template';
  el('templateSaveBtn').textContent = 'Simpan Perubahan';
  el('templateFormMsg').textContent = '';
  el('templateFormModal').classList.remove('hidden');
}

async function saveTemplate() {
  const label = el('templateLabel').value.trim();
  const text = el('templateText').value.trim();
  if (!label || !text) {
    el('templateFormMsg').textContent = 'Isi nama template dan isi pesannya dulu.';
    return;
  }
  try {
    if (editingTemplateId) {
      await apiPut(`/api/message-templates/${editingTemplateId}`, { label, text });
    } else {
      await apiPost('/api/message-templates', { label, text });
    }
    closeTemplateFormModal();
    await loadTemplates();
  } catch (e) {
    if (e.message === 'unauthorized') {
      handleApiError(e);
      return;
    }
    el('templateFormMsg').textContent = e.message || 'Gagal menyimpan template.';
  }
}

async function deleteTemplate(id) {
  if (!confirm('Hapus template ini? Tindakan ini tidak bisa dibatalkan.')) return;
  try {
    await apiDelete(`/api/message-templates/${id}`);
    if (editingTemplateId === id) resetTemplateForm();
    await loadTemplates();
  } catch (e) {
    handleApiError(e, 'Gagal menghapus template.');
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
  el('templatesPage').classList.toggle('hidden', page !== 'templates');
  el('usersPage').classList.toggle('hidden', page !== 'users');
  if (page === 'dashboard') renderDashboard();
  if (page === 'produk') loadProducts();
  if (page === 'pesanan') loadOrders();
  if (page === 'praPesanan') loadPreOrders();
  if (page === 'templates') loadTemplates();
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
  ['preOrderQty', 'preOrderUnitPrice', 'preOrderShippingCost'].forEach((id) => {
    el(id).addEventListener('input', recalcPreOrderTotals);
  });

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
    ['orderFormModal', closeOrderFormModal],
    ['preOrderFormModal', closePreOrderFormModal],
    ['preOrderImportModal', closePreOrderImportModal],
    ['preOrderLincahImportModal', closePreOrderLincahImportModal],
    ['templateFormModal', closeTemplateFormModal],
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

  ['orderFilterStatus', 'orderFilterOwner', 'orderFilterFrom', 'orderFilterTo', 'orderSearchBox'].forEach((id) => {
    el(id).addEventListener('input', () => {
      ordersPage = 1;
      renderOrdersTable();
    });
  });
  wireMultiselect('orderProduct', ORDER_PRODUCT_MULTISELECT, () => {
    ordersPage = 1;
    renderOrdersTable();
  });
  el('preOrdersRefreshBtn').addEventListener('click', loadPreOrders);
  ['preOrderFilterCreator', 'preOrderFilterOwner', 'preOrderFilterFrom', 'preOrderFilterTo', 'preOrderFilterNotifyStatus', 'preOrderFilterResponseStatus'].forEach((id) => {
    el(id).addEventListener('input', () => {
      preOrdersPage = 1;
      renderPreOrdersTable();
    });
  });
  wireMultiselect('preOrderProduct', PREORDER_PRODUCT_MULTISELECT, () => {
    preOrdersPage = 1;
    renderPreOrdersTable();
  });
  document.querySelectorAll('#preOrderStatusTabs .tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('active')) return;
      document.querySelectorAll('#preOrderStatusTabs .tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      preOrdersPage = 1;
      loadPreOrders();
    });
  });

  el('ordersPrevBtn').addEventListener('click', () => {
    ordersPage -= 1;
    renderOrdersTable();
  });
  el('ordersNextBtn').addEventListener('click', () => {
    ordersPage += 1;
    renderOrdersTable();
  });
  el('ordersPageSize').addEventListener('change', () => {
    ordersPageSize = Number(el('ordersPageSize').value) || 10;
    ordersPage = 1;
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
  el('orderSaveBtn').addEventListener('click', saveOrder);
  el('orderCancelEditBtn').addEventListener('click', closeOrderFormModal);
  el('orderFormCloseBtn').addEventListener('click', closeOrderFormModal);
  el('orderProductName').addEventListener('change', applyOrderProductPrice);

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
  el('preOrdersMarkAnekaSelectedBtn').addEventListener('click', () => bulkSetPreOrderAneka(true));
  el('preOrdersUnmarkAnekaSelectedBtn').addEventListener('click', () => bulkSetPreOrderAneka(false));

  el('preOrdersPrevBtn').addEventListener('click', () => {
    preOrdersPage -= 1;
    renderPreOrdersTable();
  });
  el('preOrdersNextBtn').addEventListener('click', () => {
    preOrdersPage += 1;
    renderPreOrdersTable();
  });
  el('preOrdersPageSize').addEventListener('change', () => {
    preOrdersPageSize = Number(el('preOrdersPageSize').value) || 10;
    preOrdersPage = 1;
    renderPreOrdersTable();
  });

  el('templateAddOpenBtn').addEventListener('click', openTemplateAddModal);
  el('templateFormCloseBtn').addEventListener('click', closeTemplateFormModal);
  el('templateCancelEditBtn').addEventListener('click', closeTemplateFormModal);
  el('templateSaveBtn').addEventListener('click', saveTemplate);

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

  setupColumnVisibility({ tableId: 'chatTable', multiId: 'kontakColumnMulti', toggleId: 'kontakColumnToggle', panelId: 'kontakColumnPanel' });
  setupColumnVisibility({ tableId: 'productsTable', multiId: 'produkColumnMulti', toggleId: 'produkColumnToggle', panelId: 'produkColumnPanel' });
  setupColumnVisibility({ tableId: 'ordersTable', multiId: 'ordersColumnMulti', toggleId: 'ordersColumnToggle', panelId: 'ordersColumnPanel' });
  setupColumnVisibility({ tableId: 'preOrdersTable', multiId: 'preOrdersColumnMulti', toggleId: 'preOrdersColumnToggle', panelId: 'preOrdersColumnPanel' });

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
