/**
 * ============================================================
 *  DEPRECATED -- EMERGENCY USE ONLY
 * ============================================================
 * This module is the original Excel/CSV rate importer that predated the
 * Supabase shipping integration. It is kept ONLY as a last-resort manual
 * recovery path for when Supabase is unreachable AND the offline cache
 * (see src/shipping/cache.js) has nothing usable.
 *
 * It must NEVER be loaded during normal execution. It is reachable only
 * via a dynamic `import()` triggered from the Developer-Mode Emergency
 * Import UI (see the "Emergency Import" section wired in index.html),
 * which itself is hidden unless Developer Mode + the EMERGENCY_IMPORT
 * feature flag are both explicitly enabled. Normal users never trigger
 * the network request that loads this file at all.
 *
 * Depends on the global `XLSX` (SheetJS) library already loaded on the
 * page for the unrelated "Saved Weights" backup feature -- this module
 * does not load its own copy.
 */

function cleanNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  let s = String(v)
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[^0-9.,-]/g, '');
  if (!s) return null;
  if (s.includes(',') && !s.includes('.')) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function norm(v) {
  return String(v ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function headerHas(h, words) {
  return words.some((w) => h.includes(w));
}

function findHeader(rows, type) {
  const limit = Math.min(rows.length, 30);
  for (let r = 0; r < limit; r++) {
    const headers = rows[r].map(norm);
    const weightCol = headers.findIndex((h) =>
      headerHas(h, ['weight', 'weights', 'lb', 'lbs', 'pound', 'kg', 'كيلو', 'كجم', 'وزن', 'رطل'])
    );
    if (type === 'myus') {
      const cols = {
        budget: headers.findIndex((h) => headerHas(h, ['budget', 'economy', 'budget economy', 'myus budget', 'اقتصادي'])),
        aramex: headers.findIndex((h) => headerHas(h, ['aramex', 'myus aramex', 'ارامكس'])),
        fedex: headers.findIndex((h) => headerHas(h, ['fedex', 'fedex priority', 'myus fedex', 'فيديكس'])),
        dhl: headers.findIndex((h) => headerHas(h, ['dhl', 'dhl express', 'myus dhl', 'دي اتش ال'])),
      };
      if (weightCol >= 0 && Object.values(cols).filter((v) => v >= 0).length >= 1) {
        const headerText = headers[weightCol] || '';
        return { startRow: r + 1, weightCol, cols, weightUnit: headerHas(headerText, ['kg', 'كيلو', 'كجم']) ? 'kg' : 'lb' };
      }
    } else {
      const priceCol = headers.findIndex(
        (h, idx) => idx !== weightCol && headerHas(h, ['price', 'rate', 'cost', 'shipping', 'sar', 'riyals', 'ريال', 'سعر', 'تكلفة', 'الشحن'])
      );
      if (weightCol >= 0 && priceCol >= 0) {
        const headerText = headers[weightCol] || '';
        return { startRow: r + 1, weightCol, priceCol, weightUnit: headerHas(headerText, ['kg', 'كيلو', 'كجم']) ? 'kg' : 'lb' };
      }
    }
  }
  return null;
}

function findFallback(rows, type) {
  for (let r = 0; r < rows.length; r++) {
    const nums = rows[r].map((v, j) => ({ j, n: cleanNumber(v) })).filter((x) => x.n != null);
    if (type === 'myus' && nums.length >= 5 && nums[0].n > 0 && nums[0].n <= 500) {
      return { startRow: r, weightCol: nums[0].j, cols: { budget: nums[1].j, aramex: nums[2].j, fedex: nums[3].j, dhl: nums[4].j }, weightUnit: 'lb' };
    }
    if (type === 'shopship' && nums.length >= 2 && nums[0].n > 0 && nums[0].n <= 500) {
      return { startRow: r, weightCol: nums[0].j, priceCol: nums[1].j, weightUnit: 'lb' };
    }
  }
  return null;
}

function fileWeightToLb(n, unit, kgToLb) {
  return Math.max(1, Math.ceil(unit === 'kg' ? n * kgToLb : n));
}

/**
 * Parses rows (already extracted from a workbook/CSV) into the legacy
 * multi-carrier shape: {[weightLb]: {budget, aramex, fedex, dhl}} for
 * type "myus", or {[weightLb]: price} for type "shopship".
 */
export function parseRowsToLegacyRates(rows, type, kgToLb) {
  const cfg = findHeader(rows, type) || findFallback(rows, type);
  if (!cfg) throw new Error('لم أتعرف على أعمدة الوزن والسعر في الملف.');
  const rates = {};
  for (let r = cfg.startRow; r < rows.length; r++) {
    const row = rows[r];
    const w = cleanNumber(row[cfg.weightCol]);
    if (!w || w <= 0) continue;
    const lb = fileWeightToLb(w, cfg.weightUnit, kgToLb);
    if (type === 'myus') {
      const item = {};
      Object.keys(cfg.cols).forEach((key) => {
        const col = cfg.cols[key];
        if (col >= 0) {
          const val = cleanNumber(row[col]);
          if (val != null && val >= 0) item[key] = val;
        }
      });
      if (Object.keys(item).length) rates[lb] = { ...(rates[lb] || {}), ...item };
    } else {
      const val = cleanNumber(row[cfg.priceCol]);
      if (val != null && val >= 0) rates[lb] = val;
    }
  }
  const count = Object.keys(rates).length;
  if (!count) throw new Error('لم أجد أسعار صالحة داخل الملف.');
  return { rates, count };
}

/** Reads an .xlsx/.xls/.csv File into a flat array-of-rows using SheetJS. */
export async function rowsFromWorkbookFile(file) {
  if (!window.XLSX) throw new Error('تعذر تحميل مكتبة Excel. افتح الصفحة مع اتصال بالإنترنت');
  const data = await file.arrayBuffer();
  const workbook = window.XLSX.read(data, { type: 'array' });
  const allRows = [];
  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const rows = window.XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    if (rows.some((row) => row.some((cell) => String(cell || '').trim() !== ''))) {
      allRows.push(...rows, []);
    }
  });
  return allRows;
}

/**
 * Parses a JSON file directly into the canonical RateTable shape for ONE
 * carrier: {"5": {"price": 42.1, "currency": "USD", "deliveryDays": "3-5 days"}, ...}.
 * This is the fastest emergency path -- no column-guessing, just validation.
 * @returns {import('../src/shipping/types.js').RateTable}
 */
export async function parseJsonRateFile(file) {
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error('ملف JSON غير صالح: ' + err.message);
  }

  const table = {};
  for (const [weightKey, row] of Object.entries(parsed)) {
    const weight = Number(weightKey);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    const price = Number(row?.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    table[weight] = {
      price,
      currency: String(row.currency || '').toUpperCase() || 'SAR',
      deliveryDays: String(row.deliveryDays || ''),
    };
  }

  if (!Object.keys(table).length) throw new Error('لم أجد أسعار صالحة داخل ملف JSON.');
  return table;
}

/**
 * Fans the legacy multi-carrier "myus" shape (or single-column "shopship"
 * shape) out into one canonical RateTable per carrier code, ready to hand
 * to ShippingProvider.importEmergencyTable() once per entry.
 *
 * @param {Record<number, object>|Record<number, number>} legacyRates
 * @param {'myus'|'shopship'} type
 * @param {import('../src/shipping/types.js').CarrierPair[] & {legacyKey: string}[]} carrierDefinitions
 *   e.g. [{ legacyKey: 'budget', warehouseCode: 'MYUS_US', carrierCode: 'BUDGET' }, ...]
 * @returns {Array<{warehouseCode: string, carrierCode: string, table: import('../src/shipping/types.js').RateTable}>}
 */
export function toRateTablesByCarrier(legacyRates, type, carrierDefinitions) {
  const results = [];

  if (type === 'shopship') {
    const def = carrierDefinitions[0];
    if (!def) return results;
    const table = {};
    Object.entries(legacyRates).forEach(([weight, price]) => {
      table[weight] = { price, currency: 'SAR', deliveryDays: '' };
    });
    results.push({ warehouseCode: def.warehouseCode, carrierCode: def.carrierCode, table });
    return results;
  }

  for (const def of carrierDefinitions) {
    const table = {};
    Object.entries(legacyRates).forEach(([weight, row]) => {
      const price = row[def.legacyKey];
      if (price != null) table[weight] = { price, currency: 'USD', deliveryDays: '' };
    });
    if (Object.keys(table).length) {
      results.push({ warehouseCode: def.warehouseCode, carrierCode: def.carrierCode, table });
    }
  }
  return results;
}
