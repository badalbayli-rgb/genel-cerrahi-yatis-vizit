(() => {
  "use strict";

  const APP_VERSION = "1.3";
  const APP_ID = "gcyv-panel";
  const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const TARGET_UNIT = /genel\s*cerrahi/i;
  const ADMISSION_POSITIVE = [
    /yat[ıi]ş[ıi]?\s+(?:uygundur|verildi|planland[ıi]|önerildi)/i,
    /yat[ıi]ş[ıi]?\s+(?:yap[ıi]ld[ıi]|sağland[ıi]|sagland[ıi]|düşünüldü|dusunuldu)/i,
    /yat[ıi]ş[ıi]?\s+(?:uygun|plan[ıi])(?:d[ıi]r)?/i,
    /(?:servisimize|servise|genel\s*cerrahi\s*servisine)\s+yat[ıi]ş/i,
    /servis(?:e|imize)?\s+yat[ıi]r[ıi]l/i,
    /resen\s+yat[ıi]ş/i,
    /yat[ıi]r[ıi]lmas[ıi]\s+(?:uygundur|planland[ıi]|önerildi)/i,
    /servise\s+kabul/i,
    /yat[ıi]r[ıi]lacak/i,
    /yatarak\s+tedavi/i,
    /yat[ıi]ş\s+karar[ıi]/i
  ];
  const ADMISSION_NEGATIVE = [
    /yat[ıi]ş\s+(?:endikasyonu|gerekliliği|gerekliligi)\s+(?:yoktur|yok)/i,
    /yat[ıi]ş[ıi]na\s+gerek\s+yok/i,
    /yat[ıi]ş[ıi]?\s+(?:uygun\s+değildir|uygun\s+degildir|düşünülmedi|dusunulmedi)/i,
    /taburcu(?:luğu|lugu)?\s+uygundur/i
  ];

  if (window.__GENEL_CERRAHI_YATIS_VIZIT__) {
    try { window.__GENEL_CERRAHI_YATIS_VIZIT__.destroy?.(); } catch (error) {}
  }

  const state = {
    records: new Map(),
    candidates: new Map(),
    consultCache: new Map(),
    captured: 0,
    scannedRows: 0,
    errors: [],
    busy: false,
    done: 0,
    total: 0,
    originalFetch: window.fetch,
    xhrOpen: XMLHttpRequest.prototype.open,
    xhrSend: XMLHttpRequest.prototype.send,
    observer: null,
    renderTimer: null,
    active: true
  };
  window.__GENEL_CERRAHI_YATIS_VIZIT__ = state;

  const clean = (value) => String(value == null ? "" : value)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\r/g, "")
    .trim();
  const norm = (value) => clean(value).toLocaleLowerCase("tr-TR");
  const text = (value) => clean(String(value == null ? "" : value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " "));
  const clip = (value, length = 160) => clean(value).length > length ? clean(value).slice(0, length - 1) + "…" : clean(value);
  const esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
  })[ch]);
  const xmlEsc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&apos;"
  })[ch]);

  function deepGet(object, paths) {
    for (const path of paths) {
      let current = object;
      for (const part of path.split(".")) current = current == null ? undefined : current[part];
      const value = typeof current === "object" && current ? current.adi || current.aciklama || current.value : current;
      if (clean(value)) return clean(value);
    }
    return "";
  }

  function flatValue(object, keys) {
    const output = {};
    const visit = (value, prefix = "", depth = 0) => {
      if (!value || typeof value !== "object" || depth > 7) return;
      Object.entries(value).forEach(([key, child]) => {
        const path = `${prefix}${key}`.toLocaleLowerCase("tr-TR");
        if (child && typeof child === "object") visit(child, `${path}.`, depth + 1);
        else output[path] = child;
      });
    };
    visit(object);
    for (const key of keys) {
      const wanted = key.toLocaleLowerCase("tr-TR");
      const match = Object.entries(output).find(([path]) => path === wanted || path.endsWith(`.${wanted}`));
      if (match && clean(match[1])) return clean(match[1]);
    }
    return "";
  }

  const baseUrl = () => `${location.origin}/hbys-rs/hbys`;
  async function apiJson(path) {
    const separator = path.includes("?") ? "&" : "?";
    const response = await state.originalFetch(`${baseUrl()}${path}${separator}_dc=${Date.now()}`, {
      credentials:"include",
      headers:{ Accept:"application/json, text/plain, */*" }
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${clean(body).slice(0, 120)}`);
    try { return JSON.parse(body); }
    catch (error) { throw new Error("FONET yanıtı JSON olarak okunamadı."); }
  }

  function admissionSignal(answer) {
    const text = clean(answer);
    if (!text || ADMISSION_NEGATIVE.some((pattern) => pattern.test(text))) return "";
    const pattern = ADMISSION_POSITIVE.find((candidate) => candidate.test(text));
    return pattern ? clean(text.match(pattern)?.[0] || "Yatış kararı") : "";
  }

  function consultAnswer(raw = {}) {
    return text([
      raw.sonucAciklama, raw.sonucAciklama2, raw.cevap, raw.cevapMetni,
      raw.konsultasyonCevabi, raw.yanit, raw.yanitMetni, raw.degerlendirme
    ].filter(Boolean).join("\n"));
  }

  function consultRequest(raw = {}) {
    return deepGet(raw, [
      "istemSebebi", "istemNedeni", "istemAciklama", "istek", "istekAciklama", "konsultasyonNedeni",
      "sikayet", "onTani", "talep", "aciklama"
    ]);
  }

  function targetUnit(raw = {}) {
    return deepGet(raw, [
      "birimSevk.birim.adi", "sonucBirim.adi", "istenenBirim.adi", "istemBirim.adi", "konsultasyonBirim.adi",
      "hedefBirim.adi", "cevapBirim.adi", "istenenBirimAdi", "sonucBirimAdi",
      "konsultasyonBirimAdi", "birimAdi", "birim.adi", "klinik.adi"
    ]);
  }

  function patientName(raw = {}) {
    const direct = deepGet(raw, [
      "hasta.adSoyad", "hastaAdiSoyadi", "hastaAdSoyad", "adSoyad", "hastaAdi", "adSoyadi",
      "hasta.adiSoyadi", "patientName"
    ]);
    if (direct) return direct;
    const name = deepGet(raw, ["hasta.ad", "ad", "hastaAdi"]);
    const surname = deepGet(raw, ["hasta.soyad", "soyad", "hastaSoyadi"]);
    return clean([name, surname].filter(Boolean).join(" "));
  }

  function consultDate(raw = {}) {
    return deepGet(raw, [
      "birimSevk.sevkTarihi", "etar", "istemTarihi", "konsultasyonTarihi", "tarih", "kayitTarihi", "olusturmaTarihi",
      "sonucTarihi", "cevapTarihi"
    ]);
  }

  function patientId(raw = {}) {
    return deepGet(raw, ["hasta.id", "hastaId", "hasta.idHasta", "idHasta"]);
  }

  function visitId(raw = {}) {
    return deepGet(raw, ["hastaGelis.id", "hastaGelisId", "gelisId", "hastaGelis.idHastaGelis"]);
  }

  function consultId(raw = {}) {
    return deepGet(raw, ["id", "konsultasyonId", "hastaGelisKonsultasyonId", "idHastaGelisKonsultasyon"]);
  }

  function protocol(raw = {}) {
    return deepGet(raw, ["protokolNo", "protokol", "hastaGelis.protokolNo", "takipNo", "dosyaNo"]);
  }

  function ageSex(raw = {}) {
    const age = deepGet(raw, ["hasta.yas", "yas", "hastaYasi"]);
    const sexRaw = norm(deepGet(raw, ["hasta.cinsiyet.adi", "hasta.cinsiyet", "cinsiyet.adi", "cinsiyet"]));
    const sex = /erkek|^e$|male/.test(sexRaw) ? "E" : (/kad[ıi]n|^k$|female/.test(sexRaw) ? "K" : "");
    return clean(age + sex);
  }

  function admissionDiagnosis(answer, request) {
    const text = clean(answer);
    const patterns = [
      /(.{3,100}?)\s+tan[ıi]s[ıi]\s+ile\s+(?:servise\s+)?yat[ıi]ş/i,
      /(.{3,100}?)\s+nedeni(?:yle|\s+ile)\s+(?:servise\s+)?yat[ıi]ş/i,
      /(?:ön\s*tan[ıi]|tan[ıi])\s*[:\-]\s*([^.;\n]{3,100})/i
    ];
    for (const pattern of patterns) {
      const value = clean(text.match(pattern)?.[1] || "").replace(/^(hastan[ıi]n|hasta)\s+/i, "");
      if (value) return value;
    }
    return clip(request, 100);
  }

  function recordKey(record) {
    return clean(record.consultId) || [norm(record.name), clean(record.date), norm(record.answer).slice(0, 80)].join("|");
  }

  function normalizeConsult(raw, source = "API", trustedPolyclinicTarget = false) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const answer = consultAnswer(raw);
    const request = consultRequest(raw);
    const unit = targetUnit(raw);
    const combined = clean([unit, request, answer].join(" "));
    if (!trustedPolyclinicTarget && !TARGET_UNIT.test(unit || combined)) return null;
    const signal = admissionSignal(answer);
    if (!signal) return null;
    const record = {
      consultId: consultId(raw),
      hastaGelisId: visitId(raw),
      hastaId: patientId(raw),
      protocol: protocol(raw),
      name: patientName(raw) || "Hasta adı alınamadı",
      ageSex: ageSex(raw),
      date: consultDate(raw),
      unit: unit || "Genel Cerrahi",
      request,
      answer,
      signal,
      diagnosis: admissionDiagnosis(answer, request),
      source,
      selected: true,
      raw
    };
    record.key = recordKey(record);
    return record;
  }

  function polyclinicCandidate(raw = {}, record = null, index = 0) {
    const id = flatValue(raw, ["hastaGelisId", "gelisId", "idHastaGelis"]) || clean(record?.getId?.()) || clean(record?.internalId) || flatValue(raw, ["id"]);
    return {
      hastaGelisId:id,
      birimSevkId:flatValue(raw, ["birimSevkId", "hastaBirimSevkId", "idBirimSevk"]),
      hastaId:flatValue(raw, ["hastaId", "idHasta"]),
      name:flatValue(raw, ["adiSoyadi", "adSoyad", "hastaAdiSoyadi", "hastaAdSoyad", "hastaAdi"]),
      protocol:flatValue(raw, ["protokolNo", "protokol", "takipNo", "dosyaNo"]),
      ageSex:flatValue(raw, ["yasCinsiyet", "yasCins", "yas"]),
      date:flatValue(raw, ["kabulTarihi", "gelisTarihi", "tarih", "saat"]),
      requestingUnit:flatValue(raw, ["konsIsteyenBirimAdi", "konsultasyonIsteyenBirimAdi", "isteyenBirimAdi", "istemBirimAdi", "birimAdi"]),
      doctor:flatValue(raw, ["doktorAdiSoyadi", "doktorAdi", "doktor", "personelAdiSoyadi"]),
      index,
      raw
    };
  }

  function mergeRecord(record) {
    if (!record?.key) return false;
    const previous = state.records.get(record.key);
    state.records.set(record.key, previous ? {
      ...previous,
      ...record,
      selected: previous.selected,
      name: record.name === "Hasta adı alınamadı" ? previous.name : record.name,
      source: [...new Set([previous.source, record.source].filter(Boolean))].join(" + "),
      requestingUnit: [...new Set([previous.requestingUnit, record.requestingUnit].filter(Boolean))].join(" / ")
    } : record);
    scheduleRender();
    return !previous;
  }

  function walkPayload(value, source, depth = 0, seen = new WeakSet()) {
    if (depth > 8 || value == null) return;
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.slice(0, 5000).forEach((item) => walkPayload(item, source, depth + 1, seen));
      return;
    }
    mergeRecord(normalizeConsult(value, source));
    Object.values(value).forEach((child) => walkPayload(child, source, depth + 1, seen));
  }

  function capturePayload(payload, source) {
    try {
      state.captured += 1;
      walkPayload(payload, source);
    } catch (error) {
      state.errors.push("Yanıt tarama: " + clean(error?.message || error));
    }
  }

  function installNetworkCapture() {
    if (window.fetch === state.patchedFetch) return;
    state.patchedFetch = async function(...args) {
      const response = await state.originalFetch.apply(this, args);
      try {
        const url = String(args[0]?.url || args[0] || "");
        const contentType = response.headers?.get?.("content-type") || "";
        if (/json/i.test(contentType) || /kons|consult|poliklinik/i.test(url)) {
          response.clone().json().then((payload) => capturePayload(payload, "API: " + clip(url, 80))).catch(() => {});
        }
      } catch (error) {}
      return response;
    };
    window.fetch = state.patchedFetch;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__gcyvUrl = String(url || "");
      return state.xhrOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function(...args) {
      this.addEventListener("load", () => {
        try {
          if (/kons|consult|poliklinik/i.test(this.__gcyvUrl || "") || /json/i.test(this.getResponseHeader("content-type") || "")) {
            const payload = typeof this.response === "object" && this.response ? this.response : JSON.parse(this.responseText || "null");
            capturePayload(payload, "XHR: " + clip(this.__gcyvUrl, 80));
          }
        } catch (error) {}
      }, { once:true });
      return state.xhrSend.apply(this, args);
    };
  }

  function headerMap(table) {
    const headers = Array.from(table.querySelectorAll("thead th, tr:first-child th, tr:first-child td"));
    return headers.map((cell) => norm(cell.innerText || cell.textContent || ""));
  }

  function cellValue(cells, headers, patterns) {
    const index = headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
    return index >= 0 ? clean(cells[index]?.innerText || cells[index]?.textContent || "") : "";
  }

  function extractNumericAttribute(row, names) {
    const values = [];
    for (const element of [row, ...row.querySelectorAll("[data-id],[data-hasta-gelis-id],[onclick],[href]")]) {
      for (const name of names) {
        const raw = element.getAttribute?.(name) || "";
        const match = String(raw).match(/\b\d{2,}\b/);
        if (match) values.push(match[0]);
      }
    }
    return values[0] || "";
  }

  function findPolyclinicGrid() {
    const Ext = window.Ext;
    if (!Ext?.ComponentQuery) throw new Error("FONET ExtJS ekranı bulunamadı. Aracı FONET ana sayfasında çalıştırın.");
    const candidates = Ext.ComponentQuery.query("gridpanel,grid").map((grid) => {
      const store = grid.getStore?.();
      const columns = (grid.getColumnManager?.().getColumns?.() || grid.columns || []);
      const headers = columns.map((column) => clean(column.text || column.header || column.dataIndex || ""));
      const headerText = norm(headers.join(" | "));
      const first = store?.getAt?.(0)?.data || {};
      const keys = norm(Object.keys(first).join(" "));
      const score = (store?.getCount?.() || 0)
        + (/ad[ıi]\s*soyad/.test(headerText) ? 10000 : 0)
        + (/kons.*isteyen\s*birim/.test(headerText) ? 10000 : 0)
        + (/hastagelis|gelisid/.test(keys) ? 3000 : 0);
      return { grid, store, headers, score, count:store?.getCount?.() || 0, total:store?.getTotalCount?.() || store?.getCount?.() || 0 };
    }).filter((item) => item.store && item.count).sort((a, b) => b.score - a.score);
    if (!candidates.length || candidates[0].score < 15000) {
      throw new Error("Soldaki Poliklinik konsültasyon listesi bulunamadı. Muayene Tipi: Konsültasyon seçip Sorgula'ya basın.");
    }
    return candidates[0];
  }

  function domCandidates() {
    const panels = Array.from(document.querySelectorAll(".x-grid"));
    const panel = panels.find((element) => {
      const value = norm(element.innerText || "");
      return /ad[ıi]\s*soyad/.test(value) && /kons\.?.*isteyen\s*birim/.test(value);
    });
    if (!panel) return [];
    return Array.from(panel.querySelectorAll("tr[data-recordid]")).map((row, index) => {
      const cells = Array.from(row.querySelectorAll("td")).map((cell) => clean(cell.innerText || cell.textContent || ""));
      return {
        hastaGelisId:clean(row.dataset.recordid),
        date:cells[4] || "",
        name:cells[5] || "",
        requestingUnit:cells[6] || "",
        doctor:cells[8] || "",
        index,
        raw:{}
      };
    }).filter((item) => item.hastaGelisId);
  }

  async function loadPolyclinicList() {
    let list = [];
    try {
      const source = findPolyclinicGrid();
      let records = source.store.getRange();
      if (source.total > records.length) {
        const proxy = source.store.getProxy?.();
        const rawUrl = clean(proxy?.url || proxy?.api?.read);
        if (rawUrl) {
          const url = new URL(rawUrl, location.origin);
          url.searchParams.set("start", "0");
          url.searchParams.set("page", "1");
          url.searchParams.set("limit", String(source.total));
          url.searchParams.set("_dc", String(Date.now()));
          Object.entries(proxy?.extraParams || {}).forEach(([key, value]) => url.searchParams.set(key, String(value)));
          const response = await state.originalFetch(url.href, { credentials:"include", headers:{ Accept:"application/json, text/plain, */*" } });
          if (response.ok) {
            const payload = await response.json();
            const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
            if (rows.length) records = rows.map((data) => ({ data, getId:() => data.id }));
          }
        }
      }
      list = records.map((record, index) => polyclinicCandidate(record.data || record, record, index));
    } catch (error) {
      list = domCandidates();
      if (!list.length) throw error;
    }
    const readable = list.filter((item) => item.hastaGelisId);
    state.candidates = new Map(readable.map((item, index) => [`${item.hastaGelisId}|${index}`, item]));
    state.total = readable.length;
    state.scannedRows = list.length;
    if (!readable.length) throw new Error("Listede okunabilir hasta kaydı bulunamadı.");
    return readable;
  }

  function positiveConsults(payload, candidate) {
    const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
    const exactRows = candidate.birimSevkId ? rows.filter((raw) => clean(raw?.birimSevk?.id || raw?.birimSevkId) === candidate.birimSevkId) : [];
    const surgeryRows = rows.filter((raw) => TARGET_UNIT.test(clean([
      raw?.birimSevk?.birim?.adi, raw?.sonucBirim?.adi, raw?.cevapBirim?.adi,
      raw?.konsultasyonBirim?.adi, raw?.istenenBirim?.adi
    ].filter(Boolean).join(" "))));
    const scopedRows = exactRows.length ? exactRows : (surgeryRows.length ? surgeryRows : rows);
    return scopedRows.map((raw) => normalizeConsult(raw, "FONET konsültasyon cevabı", true)).filter(Boolean).map((record) => {
      const merged = {
        ...record,
        hastaGelisId:candidate.hastaGelisId || record.hastaGelisId,
        hastaId:candidate.hastaId || record.hastaId,
        name:candidate.name || record.name,
        protocol:candidate.protocol || record.protocol,
        ageSex:candidate.ageSex || record.ageSex,
        requestingUnit:candidate.requestingUnit || "",
        doctor:candidate.doctor || "",
        date:record.date || candidate.date,
        selected:true
      };
      merged.key = recordKey(merged);
      return merged;
    });
  }

  async function scanCandidate(candidate) {
    let pending = state.consultCache.get(candidate.hastaGelisId);
    if (!pending) {
      pending = apiJson(`/Poliklinik/Poliklinik/getHastaGelisKonsultasyonList/${encodeURIComponent(candidate.hastaGelisId)}/1`);
      state.consultCache.set(candidate.hastaGelisId, pending);
    }
    const payload = await pending;
    positiveConsults(payload, candidate).forEach(mergeRecord);
  }

  async function scanWorker(queue) {
    while (queue.length && state.busy) {
      const candidate = queue.shift();
      if (!candidate) return;
      try { await scanCandidate(candidate); }
      catch (error) { state.errors.push(`Kayıt ${candidate.index + 1}: ${clean(error?.message || error)}`); }
      state.done += 1;
      setMessage(`${state.done}/${state.total} konsültasyon tarandı · yatış verilen ${state.records.size} hasta bulundu.`);
      render();
    }
  }

  async function scanDom() {
    if (state.busy) return;
    state.busy = true;
    state.done = 0;
    state.records.clear();
    state.consultCache.clear();
    state.errors = [];
    render();
    try {
      const candidates = await loadPolyclinicList();
      setMessage(`${candidates.length} Poliklinik konsültasyonu bulundu; cevaplar taranıyor…`);
      const queue = [...candidates];
      await Promise.all(Array.from({ length:Math.min(4, queue.length) }, () => scanWorker(queue)));
      setMessage(`Tarama tamamlandı: ${state.total} konsültasyondan ${state.records.size} yatış kararlı Genel Cerrahi kaydı bulundu.`);
    } catch (error) {
      state.errors.push(clean(error?.message || error));
      setMessage(clean(error?.message || error));
    } finally {
      state.busy = false;
      render();
    }
  }

  function selectedRecords() {
    return [...state.records.values()].filter((record) => record.selected).sort((a, b) =>
      clean(a.date).localeCompare(clean(b.date), "tr", { numeric:true }) || clean(a.name).localeCompare(clean(b.name), "tr")
    );
  }

  function crc32(bytes) {
    let crc = -1;
    for (const byte of bytes) {
      crc ^= byte;
      for (let index = 0; index < 8; index += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ -1) >>> 0;
  }
  const u16 = (value) => new Uint8Array([value & 255, (value >>> 8) & 255]);
  const u32 = (value) => new Uint8Array([value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]);
  function joinBytes(parts) {
    const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    parts.forEach((part) => { output.set(part, offset); offset += part.length; });
    return output;
  }
  function zip(files) {
    const encoder = new TextEncoder();
    const locals = [], centrals = [];
    let offset = 0;
    Object.entries(files).forEach(([name, content]) => {
      const nameBytes = encoder.encode(name), data = encoder.encode(content), crc = crc32(data);
      const local = joinBytes([u32(0x04034b50),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(nameBytes.length),u16(0),nameBytes,data]);
      locals.push(local);
      centrals.push(joinBytes([u32(0x02014b50),u16(20),u16(20),u16(0),u16(0),u16(0),u16(0),u32(crc),u32(data.length),u32(data.length),u16(nameBytes.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset),nameBytes]));
      offset += local.length;
    });
    const central = joinBytes(centrals);
    return joinBytes([...locals, central, u32(0x06054b50),u16(0),u16(0),u16(centrals.length),u16(centrals.length),u32(central.length),u32(offset),u16(0)]);
  }

  function wordParagraph(text, options = {}) {
    const size = Math.round(Number(options.size || 9) * 2);
    const color = clean(options.color || "000000").replace(/[^0-9A-F]/gi, "") || "000000";
    const runs = String(text == null ? "" : text).split(/\n/).map((line, index) =>
      (index ? "<w:r><w:br/></w:r>" : "") +
      `<w:r><w:rPr><w:rFonts w:ascii="Tahoma" w:hAnsi="Tahoma"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/>${options.bold ? "<w:b/>" : ""}<w:color w:val="${color}"/></w:rPr><w:t xml:space="preserve">${xmlEsc(line)}</w:t></w:r>`
    ).join("");
    return `<w:p><w:pPr>${options.keep ? "<w:keepNext/>" : ""}${options.align ? `<w:jc w:val="${options.align}"/>` : ""}<w:spacing w:before="${options.before || 0}" w:after="${options.after || 0}" w:line="190" w:lineRule="auto"/></w:pPr>${runs}</w:p>`;
  }

  function wordPatient(record) {
    const title = [record.name, record.ageSex, record.protocol ? "Prot: " + record.protocol : ""].filter(Boolean).join(" · ");
    return [
      wordParagraph(title, { size:15, bold:true, keep:true, after:30 }),
      wordParagraph("YATIŞ KARARI: " + (record.signal || "Yatış kararı"), { size:11, bold:true, color:"B91C1C" }),
      wordParagraph("TANI: " + (record.diagnosis || "—"), { size:11, bold:true }),
      wordParagraph("Konsültasyon Tarihi: " + (record.date || "—"), { size:9 }),
      wordParagraph("İsteyen Birim: " + (record.requestingUnit || "—"), { size:9 }),
      wordParagraph("Konsültasyon Birimi: " + (record.unit || "Genel Cerrahi"), { size:9 }),
      wordParagraph("KONS İSTEMİ", { size:9, bold:true, keep:true, before:80 }),
      wordParagraph(record.request || "—", { size:9 }),
      wordParagraph("GENEL CERRAHİ CEVABI", { size:9, bold:true, keep:true, before:80 }),
      wordParagraph(record.answer || "—", { size:9 }),
      wordParagraph("BH: ______________________________________________", { size:9, before:90 }),
      wordParagraph("Kİ: _______________________________________________", { size:9 }),
      wordParagraph("GO: ______________________________________________", { size:9 }),
      wordParagraph("PLAN: ____________________________________________", { size:9 }),
      wordParagraph("------------------------------------------------------------", { size:9, color:"64748B", before:90, after:120 })
    ].join("");
  }

  function docxBytes(records) {
    const body = wordParagraph("GENEL CERRAHİ YATIŞ VİZİT", { size:17, bold:true, after:140 }) + records.map(wordPatient).join("");
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${WORD_NS}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="900" w:right="900" w:bottom="900" w:left="900"/><w:cols w:num="2" w:space="500" w:sep="1"/></w:sectPr></w:body></w:document>`;
    return zip({
      "[Content_Types].xml":"<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>",
      "_rels/.rels":"<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>",
      "word/document.xml":documentXml
    });
  }

  function downloadBytes(bytes, name, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const anchor = Object.assign(document.createElement("a"), { href:url, download:name });
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function exportWord() {
    const records = selectedRecords();
    if (!records.length) return alert("Önce en az bir yatış verilen hasta seçin.");
    downloadBytes(docxBytes(records), `Genel-Cerrahi-Yatis-Vizit-${new Date().toISOString().slice(0,10)}.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    setMessage(`${records.length} hasta için Word vizit kağıdı indirildi.`);
  }

  function csvCell(value) { return '"' + String(value == null ? "" : value).replace(/"/g, '""') + '"'; }
  function exportCsv() {
    const records = selectedRecords();
    if (!records.length) return alert("Önce en az bir hasta seçin.");
    const header = ["Hasta","Yaş/Cinsiyet","Protokol","Tarih","İsteyen Birim","Konsültasyon Birimi","Yatış Sinyali","Tanı","İstem","Cevap","Hasta Geliş ID"];
    const lines = [header, ...records.map((record) => [record.name,record.ageSex,record.protocol,record.date,record.requestingUnit,record.unit,record.signal,record.diagnosis,record.request,record.answer,record.hastaGelisId])];
    downloadBytes("\uFEFF" + lines.map((row) => row.map(csvCell).join(";")).join("\r\n"), `Genel-Cerrahi-Yatis-Kons-${new Date().toISOString().slice(0,10)}.csv`, "text/csv;charset=utf-8");
  }

  function setMessage(message) {
    const element = document.getElementById("gcyv-message");
    if (element) element.textContent = message;
  }

  function scheduleRender() {
    clearTimeout(state.renderTimer);
    state.renderTimer = setTimeout(render, 80);
  }

  function render() {
    const body = document.getElementById("gcyv-body");
    const stats = document.getElementById("gcyv-stats");
    if (!body || !stats) return;
    const records = [...state.records.values()].sort((a, b) => clean(b.date).localeCompare(clean(a.date), "tr", { numeric:true }));
    stats.textContent = `Poliklinik listesi: ${state.scannedRows} | Taranan: ${state.done}/${state.total} | Yatış verilen: ${records.length} | Seçili: ${records.filter((record) => record.selected).length} | Hata: ${state.errors.length}`;
    body.innerHTML = records.map((record) => `<tr>
      <td><input type="checkbox" data-select="${esc(record.key)}" ${record.selected ? "checked" : ""}></td>
      <td><strong>${esc(record.name)}</strong><div class="muted">${esc([record.ageSex, record.protocol && "Prot " + record.protocol].filter(Boolean).join(" · "))}</div></td>
      <td>${esc(record.date || "—")}</td>
      <td>${esc(record.requestingUnit || "—")}<div class="muted">→ ${esc(record.unit || "Genel Cerrahi")}</div></td>
      <td><strong class="admission">${esc(record.signal)}</strong><div>${esc(record.diagnosis || "—")}</div></td>
      <td title="${esc(record.request)}">${esc(clip(record.request || "—", 130))}</td>
      <td title="${esc(record.answer)}">${esc(clip(record.answer || "—", 210))}</td>
      <td class="muted">${esc(record.source)}</td>
    </tr>`).join("") || `<tr><td colspan="8" class="empty">Poliklinik ekranında Muayene Tipi “Konsültasyon” seçiliyken Sorgula'ya basın; ardından “Listeyi Tara”yı çalıştırın.</td></tr>`;
    body.querySelectorAll("[data-select]").forEach((checkbox) => {
      checkbox.onchange = () => {
        const record = state.records.get(checkbox.dataset.select);
        if (record) record.selected = checkbox.checked;
        render();
      };
    });
    for (const id of ["gcyv-scan","gcyv-word","gcyv-csv"]) {
      const button = document.getElementById(id);
      if (button) button.disabled = state.busy;
    }
  }

  function destroy() {
    state.active = false;
    clearTimeout(state.renderTimer);
    try { state.observer?.disconnect(); } catch (error) {}
    if (window.fetch === state.patchedFetch) window.fetch = state.originalFetch;
    XMLHttpRequest.prototype.open = state.xhrOpen;
    XMLHttpRequest.prototype.send = state.xhrSend;
    document.getElementById(APP_ID)?.remove();
    if (window.__GENEL_CERRAHI_YATIS_VIZIT__ === state) delete window.__GENEL_CERRAHI_YATIS_VIZIT__;
  }
  state.destroy = destroy;

  function installPanel() {
    document.getElementById(APP_ID)?.remove();
    const panel = document.createElement("section");
    panel.id = APP_ID;
    panel.innerHTML = `<style>
      #${APP_ID}{position:fixed;inset:12px;z-index:2147483647;background:#f4f8fc;color:#10233b;border:1px solid #8fa8c1;border-radius:14px;box-shadow:0 22px 70px #0009;font:13px Arial,sans-serif;display:flex;flex-direction:column;padding:14px;gap:10px}
      #${APP_ID} *{box-sizing:border-box}#${APP_ID} header{display:flex;align-items:center;gap:10px}#${APP_ID} h2{margin:0;color:#0b4f7c;font-size:21px}#${APP_ID} .grow{flex:1}
      #${APP_ID} button{border:0;border-radius:7px;padding:9px 12px;background:#0878bd;color:white;font-weight:800;cursor:pointer}#${APP_ID} button:disabled{opacity:.45;cursor:wait}#${APP_ID} .secondary{background:#475569}#${APP_ID} .success{background:#15803d}#${APP_ID} .danger{background:#b91c1c}
      #${APP_ID} #gcyv-message{padding:9px 11px;background:#e0f2fe;border-left:5px solid #0284c7;border-radius:7px}#${APP_ID} #gcyv-stats{font-weight:800}
      #${APP_ID} .table-wrap{overflow:auto;flex:1;background:white;border:1px solid #cbd5e1;border-radius:9px}#${APP_ID} table{border-collapse:collapse;width:100%;min-width:1350px}#${APP_ID} th,#${APP_ID} td{padding:8px;border-bottom:1px solid #e2e8f0;text-align:left;vertical-align:top}#${APP_ID} th{position:sticky;top:0;background:#dbeafe;z-index:1}#${APP_ID} td:nth-child(6),#${APP_ID} td:nth-child(7){max-width:330px}#${APP_ID} .muted{color:#64748b;font-size:11px;margin-top:3px}#${APP_ID} .admission{color:#b91c1c}#${APP_ID} .empty{text-align:center;padding:35px;color:#64748b}
    </style>
    <header><h2>Genel Cerrahi Yatış Vizit <small>V${APP_VERSION}</small></h2><span class="grow"></span><button id="gcyv-close" class="danger">Kapat</button></header>
    <div><button id="gcyv-scan">Listeyi Tara</button> <button id="gcyv-word" class="success">Seçilenlerden Word</button> <button id="gcyv-csv" class="secondary">CSV İndir</button></div>
    <div id="gcyv-message">Poliklinik ekranında doktoru ve tarih aralığını seçin; Muayene Tipi “Konsültasyon” iken Sorgula'ya basıp “Listeyi Tara”yı çalıştırın.</div>
    <div id="gcyv-stats"></div>
    <div class="table-wrap"><table><thead><tr><th>✓</th><th>Hasta</th><th>Tarih</th><th>Hedef birim</th><th>Yatış / Tanı</th><th>Kons istemi</th><th>Genel Cerrahi cevabı</th><th>Kaynak</th></tr></thead><tbody id="gcyv-body"></tbody></table></div>`;
    document.body.appendChild(panel);
    document.getElementById("gcyv-close").onclick = destroy;
    document.getElementById("gcyv-scan").onclick = scanDom;
    document.getElementById("gcyv-word").onclick = exportWord;
    document.getElementById("gcyv-csv").onclick = exportCsv;
    render();
  }

  installNetworkCapture();
  installPanel();
  state.observer = new MutationObserver(() => {
    if (state.active && !document.getElementById(APP_ID)) installPanel();
  });
  state.observer.observe(document.documentElement, { childList:true, subtree:true });
})();
