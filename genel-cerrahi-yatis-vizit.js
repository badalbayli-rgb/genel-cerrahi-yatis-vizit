(() => {
  "use strict";

  const APP_VERSION = "1.7";
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

  function deepFindId(object, predicate, depth = 0, seen = new WeakSet()) {
    if (!object || typeof object !== "object" || depth > 6 || seen.has(object)) return "";
    seen.add(object);
    try { if (predicate(object)) return clean(object.id); } catch (error) {}
    for (const value of Object.values(object)) {
      const found = deepFindId(value, predicate, depth + 1, seen);
      if (found) return found;
    }
    return "";
  }

  function inferPatientIds(raw = {}) {
    const birimSevkId = clean(
      raw.birimSevk?.id || raw.klinik?.birimSevk?.id || raw.hastaBirimSevk?.id ||
      deepFindId(raw, (value) => value.id && value.birim && value.hastaGelis)
    );
    const hastaGelisId = clean(
      raw.hastaGelis?.id || raw.birimSevk?.hastaGelis?.id || raw.hastaBirimSevk?.hastaGelis?.id ||
      deepFindId(raw, (value) => value.id && value.hasta && (value.kodu || value.muracaatTarihi))
    );
    const hastaId = clean(
      raw.hasta?.id || raw.hastaGelis?.hasta?.id || raw.birimSevk?.hastaGelis?.hasta?.id ||
      raw.hastaBirimSevk?.hastaGelis?.hasta?.id || deepFindId(raw, (value) => value.id && value.kimlik)
    );
    return { birimSevkId, hastaGelisId, hastaId };
  }

  const baseUrl = () => `${location.origin}/hbys-rs/hbys`;
  async function apiJson(path, params = null) {
    const url = new URL(`${baseUrl()}${path}`, location.origin);
    Object.entries(params || {}).forEach(([key, value]) => {
      if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, String(item)));
      else if (value != null) url.searchParams.set(key, String(value));
    });
    url.searchParams.set("_dc", String(Date.now()));
    const response = await state.originalFetch.call(window, url.href, {
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
    const content = text(answer);
    const labeled = content.match(/(?:ön\s*tan[ıi]|yat[ıi]ş\s*tan[ıi]s[ıi]|tan[ıi])\s*[:\-]\s*([^.;\n]{3,100})/i);
    if (labeled) return clean(labeled[1]);
    for (const sentence of content.split(/[.!?;\n]+/)) {
      const match = sentence.match(/(?:^|\s)(?:hastan[ıi]n\s+)?([\p{L}][\p{L}\s\-\/]{2,80}?)\s+(?:ön\s*)?tan[ıi]s[ıi](?:yla|yle|\s+ile)(?:\s|$)/iu);
      if (match) return clean(match[1]).replace(/^(?:hastan[ıi]n|hasta)\s+/i, "");
    }
    const requestDiagnosis = text(request).match(/(?:ön\s*tan[ıi]|tan[ıi])\s*[:\-]\s*([^.;\n]{3,100})/i);
    return requestDiagnosis ? clean(requestDiagnosis[1]) : "";
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
    const inferred = inferPatientIds(raw);
    const recordId = clean(record?.getId?.()) || clean(record?.internalId) || flatValue(raw, ["id"]);
    return {
      hastaGelisId:inferred.hastaGelisId || flatValue(raw, ["hastaGelisId", "gelisId", "idHastaGelis"]),
      birimSevkId:inferred.birimSevkId || flatValue(raw, ["birimSevkId", "hastaBirimSevkId", "idBirimSevk"]) || recordId,
      hastaId:inferred.hastaId || flatValue(raw, ["hastaId", "idHasta"]),
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
      const response = await state.originalFetch.apply(window, args);
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
        hastaGelisId:"",
        birimSevkId:clean(row.dataset.recordid),
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
          const response = await state.originalFetch.call(window, url.href, { credentials:"include", headers:{ Accept:"application/json, text/plain, */*" } });
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
    const readable = list.filter((item) => item.hastaGelisId || item.birimSevkId);
    state.candidates = new Map(readable.map((item, index) => [`${item.hastaGelisId || item.birimSevkId}|${index}`, item]));
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
        birimSevkId:candidate.birimSevkId || record.birimSevkId,
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
    if (!candidate.hastaGelisId && candidate.birimSevkId) {
      const sevkPayload = await apiJson(`/Tibbi/HastaBirimSevk/getSevkUyariInfo/${encodeURIComponent(candidate.birimSevkId)}`);
      const root = sevkPayload?.data || sevkPayload || {};
      const sevk = root.hastaBirimSevk || root.birimSevk || {};
      const gelis = sevk.hastaGelis || root.hastaGelis || {};
      candidate.hastaGelisId = clean(gelis.id || inferPatientIds(root).hastaGelisId);
      candidate.hastaId = candidate.hastaId || clean(gelis.hasta?.id || inferPatientIds(root).hastaId);
    }
    if (!candidate.hastaGelisId) throw new Error("Hasta geliş kimliği çözümlenemedi");
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
      const errorNote = state.errors.length ? ` Hata: ${state.errors.length}. İlk hata: ${state.errors[0]}` : "";
      setMessage(`Tarama tamamlandı: ${state.total} konsültasyondan ${state.records.size} yatış kararlı Genel Cerrahi kaydı bulundu.${errorNote}`);
    } catch (error) {
      state.errors.push(clean(error?.message || error));
      setMessage(clean(error?.message || error));
    } finally {
      state.busy = false;
      render();
    }
  }

  function diagnosisNames(root) {
    const found = [];
    const seen = new WeakSet();
    const add = (value) => {
      const name = clean(typeof value === "object" && value ? value.koduAdi || value.kodAdi || value.adi || value.aciklama || value.taniAdi : value);
      if (name && name !== "[object Object]" && !found.some((item) => norm(item) === norm(name))) found.push(name);
    };
    const walk = (value, key = "", depth = 0) => {
      if (value == null || depth > 6) return;
      if (typeof value !== "object") { if (/tan[ıi]|diagnos/i.test(key)) add(value); return; }
      if (seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) { value.forEach((item) => walk(item, key, depth + 1)); return; }
      if (/tan[ıi]|diagnos/i.test(key)) add(value);
      Object.entries(value).forEach(([childKey, child]) => walk(child, childKey, depth + 1));
    };
    walk(root);
    return found.slice(0, 5);
  }

  function labRowsFromPayload(value, output = [], seen = new WeakSet()) {
    if (!value || typeof value !== "object" || seen.has(value)) return output;
    seen.add(value);
    if (Array.isArray(value)) { value.forEach((item) => labRowsFromPayload(item, output, seen)); return output; }
    const test = value?.lisHastaTupTetkik?.tetkik?.adi || value?.lisHastaTupTetkik?.tetkikAdi ||
      value?.tetkik?.adi || value?.lisTetkik?.adi || value?.tetkikAdi || value?.parametreAdi || value?.testAdi || "";
    const result = value?.lisHastaTupTetkik?.sonucByRapor || value?.lisHastaTupTetkik?.sonuc ||
      value?.sonucByRapor || value?.sonuc || value?.sonucDegeri || value?.deger || "";
    if (clean(test) && clean(result)) output.push(value);
    ["data","rows","items","children","records","list","detayList","sonucList"].forEach((key) => {
      if (value[key] && typeof value[key] === "object") labRowsFromPayload(value[key], output, seen);
    });
    return output;
  }

  function labLabel(name) {
    const value = norm(name);
    const labels = [
      ["WBC", /(^|\s)wbc($|\s)|l[öo]kosit|leukocyte/], ["Hb", /(^|\s)hgb?($|\s)|hemoglobin/],
      ["PLT", /(^|\s)plt($|\s)|trombosit/], ["Nöt", /n[öo]trofil|neutrophil/], ["Lenf", /lenfosit|lymphocyte/],
      ["CRP", /crp|c.?reaktif/], ["PCT", /prokalsitonin|procalcitonin/], ["Kre", /kreatinin/],
      ["Üre", /(^|\s)[üu]re($|\s)|urea/], ["Na", /sodyum|sodium|^na$/], ["K", /potasyum|potassium|^k$/],
      ["Glu", /glukoz|glikoz|glucose/], ["AST", /^ast$|aspartat/], ["ALT", /^alt$|alanin/],
      ["T.Bil", /bilirubin.*total|total.*bilirubin/], ["D.Bil", /bilirubin.*direkt|direkt.*bilirubin/],
      ["Alb", /alb[üu]min|albumin/], ["INR", /(^|\s)inr($|\s)/], ["Amilaz", /amilaz/], ["Lipaz", /lipaz/]
    ];
    return labels.find(([, pattern]) => pattern.test(value))?.[0] || "";
  }

  function dateSortKey(value) {
    const source = clean(value);
    const tr = source.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (tr) return [tr[3], tr[2], tr[1], tr[4] || 0, tr[5] || 0, tr[6] || 0].map((part, index) => String(part).padStart(index ? 2 : 4, "0")).join("");
    const iso = source.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (iso) return [iso[1], iso[2], iso[3], iso[4] || 0, iso[5] || 0, iso[6] || 0].map((part, index) => String(part).padStart(index ? 2 : 4, "0")).join("");
    return "";
  }

  function normalizeLabRows(rows) {
    const output = new Map();
    rows.forEach((row) => {
      const rawName = row?.lisHastaTupTetkik?.tetkik?.adi || row?.lisHastaTupTetkik?.tetkikAdi || row?.tetkik?.adi || row?.tetkikAdi || row?.parametreAdi || row?.testAdi || "";
      const label = labLabel(rawName);
      if (!label) return;
      const value = text(row?.lisHastaTupTetkik?.sonucByRapor || row?.lisHastaTupTetkik?.sonuc || row?.sonucByRapor || row?.sonuc || row?.sonucDegeri || row?.deger || "");
      const unit = clean(row?.lisHastaTupTetkik?.tetkik?.birim || row?.birim?.adi || row?.birim || row?.sonucBirimi || "");
      const date = clean(row?.lisHastaTupTetkik?.sonucTarihi || row?.lisHastaTupTetkik?.onayTarihi || row?.sonucTarihi || row?.onayTarihi || row?.lisHastaTupTetkik?.lisHastaTup?.numuneAlmaTarihi || "");
      const previous = output.get(label);
      if (!previous || dateSortKey(date) > dateSortKey(previous.date)) output.set(label, { label, value, unit, date });
    });
    const order = ["WBC","Hb","PLT","Nöt","Lenf","CRP","PCT","Kre","Üre","Na","K","Glu","AST","ALT","T.Bil","D.Bil","Alb","INR","Amilaz","Lipaz"];
    return [...output.values()].sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label));
  }

  async function fetchLatestLabs(record) {
    const property = record.hastaGelisId ? "hastaGelisId" : "hastaId";
    const value = record.hastaGelisId || record.hastaId;
    if (!value) return;
    const kabul = await apiJson("/Lis/LisRaporSonuc/getLisRaporHastaInfoList", {
      filter:JSON.stringify([{ property, value:Number(value), type:"Long", operator:"=" }]),
      page:1, start:0, limit:12,
      sort:JSON.stringify([{ property:"lisKabulTarihi", direction:"DESC" }])
    });
    const accepts = (kabul.data || []).slice(0, 12);
    record.labDate = clean(accepts[0]?.lisKabulTarihi || "");
    const tubePayloads = await Promise.all(accepts.map((item) => apiJson("/Lis/LisRaporSonuc/getLisHastaTupInfo", {
      filter:JSON.stringify([{ filterType:"kriterPanel", property:"t.lisKabul.id", value:Number(item.lisKabulId), type:"Long", operator:"=" }]),
      page:1, start:0, limit:100
    }).catch(() => ({ data:[] }))));
    const barcodes = [...new Set(tubePayloads.flatMap((payload) => (payload.data || []).map((row) => clean(row.barkodNo)).filter(Boolean)))];
    if (!barcodes.length) { record.labs = []; return; }
    const detailRows = [];
    for (let offset = 0; offset < barcodes.length; offset += 18) {
      const batch = barcodes.slice(offset, offset + 18);
      const detail = await apiJson("/Lis/LisRaporSonuc/getLisRaporDetay", {
        filter:JSON.stringify([{ filterType:"kriterPanel", property:"t.lisHastaTup.barkodNo", value:batch, type:"Long", operator:"IN" }]),
        page:1, start:0, limit:1500,
        group:JSON.stringify([{ property:"tupAdi", direction:"ASC" }]),
        sort:JSON.stringify([{ property:"lt.siraNo", direction:"ASC" }])
      });
      detailRows.push(...labRowsFromPayload(detail.data || []));
    }
    record.labs = normalizeLabRows(detailRows);
    const newest = record.labs.map((item) => item.date).filter(Boolean).sort((a, b) => dateSortKey(b).localeCompare(dateSortKey(a)))[0];
    if (newest) record.labDate = newest;
  }

  function radiologyText(payload) {
    const root = payload?.data || payload || {};
    return String(root.raporTextByRapor || root.raporText || root.raporMetni || root.raporHtml || root.rapor || root.bulgu || root.bulgular || root.sonuc || root.sonucAciklama || root.aciklama || "");
  }

  function decodeReportText(value) {
    return String(value || "").replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"')
      .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
  }

  function boldReportBeforeResult(raw) {
    let source = String(raw || "");
    if (!/<\s*[a-z]/i.test(source) && /&lt;\s*(?:b|strong|span|p)\b/i.test(source)) source = decodeReportText(source);
    if (!source) return "";
    const stack = [];
    const segments = [];
    const voidTags = /^(?:br|hr|img|input|meta|link|wbr)$/;
    for (const token of source.split(/(<[^>]*>)/g)) {
      if (!token) continue;
      if (token[0] !== "<") {
        segments.push({ value:decodeReportText(token), bold:stack.some((item) => item.bold) });
        continue;
      }
      const match = token.match(/^<\s*(\/?)\s*([a-z][\w:-]*)/i);
      if (!match) continue;
      const tag = match[2].toLowerCase();
      if (match[1]) {
        while (stack.length) { if (stack.pop().tag === tag) break; }
      } else if (!voidTags.test(tag) && !/\/\s*>$/.test(token)) {
        stack.push({ tag, bold:tag === "b" || tag === "strong" || /font-weight\s*:\s*(?:bold|[6-9]00)/i.test(token) || /class\s*=\s*["'][^"']*\bbold\b/i.test(token) });
      }
    }
    const plain = segments.map((item) => item.value).join("");
    const resultAt = plain.search(/sonu[çc]\s*:/i);
    const limit = resultAt < 0 ? plain.length : resultAt;
    const pieces = [];
    let offset = 0;
    for (const item of segments) {
      if (offset >= limit) break;
      const portion = item.value.slice(0, Math.max(0, limit - offset));
      if (item.bold && portion.trim()) pieces.push(portion);
      offset += item.value.length;
    }
    if (!pieces.length && !/<[^>]+>/.test(source)) {
      const markdown = source.slice(0, resultAt < 0 ? undefined : resultAt).match(/\*\*([^*]+)\*\*/g) || [];
      return markdown.map((item) => clean(item.slice(2, -2))).filter(Boolean).join("\n");
    }
    return pieces.map((item) => clean(item)).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  }

  async function fetchImaging(record) {
    const property = record.hastaGelisId ? "hastaGelisId" : "hastaId";
    const value = record.hastaGelisId || record.hastaId;
    if (!value) return;
    const payload = await apiJson("/Ris/RisHizmetSonuc/getRisHizmetSonucInfoList", {
      filter:JSON.stringify([{ property, value:Number(value), type:"Long", operator:"=" }]),
      page:1, start:0, limit:20,
      sort:JSON.stringify([{ property:"istemTarihi", direction:"DESC" }])
    });
    const rows = (payload.data || []).slice(0, 8);
    record.imaging = await Promise.all(rows.map(async (row) => {
      const reportId = clean(row.raporId || "");
      let report = String(row.raporTextByRapor || row.raporText || row.rapor || row.bulgular || row.sonuc || "");
      if (!report && reportId) {
        try { report = radiologyText(await apiJson(`/Ris/RisHizmetSonuc/getRisRaporSonucByRaporId/${encodeURIComponent(reportId)}`)); } catch (error) {}
      }
      return {
        date:clean(row.istemTarihi || row.risKabulTarihi || ""),
        exam:clean(row.tetkikAdi || row.hizmetAdi || row.hizmet?.adi || row.risOrder?.hizmet?.adi || row.risOrderKodAdi || row.istemAdi || "Görüntüleme"),
        report:boldReportBeforeResult(report)
      };
    }));
  }

  function todayText() {
    const now = new Date(), pad = (value) => String(value).padStart(2, "0");
    return `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()}`;
  }

  async function fetchOrderRows(birimSevkId) {
    const day = todayText(), start = `${day} 00:00:00`, end = `${day} 23:59:59`;
    const filter = [
      { index:1, property:"tarihTuru", value:"tarihAraligiIcinde", filterType:"kriterPanel", isEnum:false, type:"String", operator:"=" },
      { index:2, property:"tarih", value:start, filterType:"kriterPanel", type:"date", operator:"=" },
      { index:3, property:"e.baslangicTarihi", value:start, filterType:"kriterPanel", type:"date", operator:">=" },
      { index:4, property:"e.bitisTarihi", value:end, filterType:"kriterPanel", type:"date", operator:"<=" },
      { index:5, property:"birimSevk.id", value:Number(birimSevkId), filterType:"kriterPanel", type:"Long", operator:"=" },
      { index:6, property:"yeri", value:2, filterType:"kriterPanel", isEnum:true, type:"tr.com.fonet.hbys.common.enums.EOrderYeri", operator:"=" },
      { index:7, property:"hemsireOrder", value:"false", filterType:"kriterPanel", isEnum:false, type:"String", operator:"=" }
    ];
    const payload = await apiJson("/Stok/EOrder/getKayitList", {
      autoStores:["turu","stokTuru","antibiyotikTuru","ekstravazeIlacSekli","durum"],
      filterMap:"", filter:JSON.stringify(filter), page:1, start:0, limit:200
    });
    return Array.isArray(payload.data) ? payload.data : [];
  }

  async function fetchOrders(record) {
    if (!record.birimSevkId) return;
    const rows = await fetchOrderRows(record.birimSevkId);
    if (record.hastaGelisId) {
      try {
        const sevkList = await apiJson("/Tibbi/HastaBirimSevk/getKayitList", {
          filterMap:"",
          filter:JSON.stringify([{ index:1, property:"hastaGelis.id", value:Number(record.hastaGelisId), filterType:"kriterPanel", type:"Long", operator:"=" }]),
          page:1, start:0, limit:100,
          sort:JSON.stringify([{ property:"sevkTarihi", direction:"DESC" }])
        });
        const otherIds = [...new Set((sevkList.data || []).map((row) => clean(row.id || row.birimSevkId)).filter((id) => id && id !== clean(record.birimSevkId)))].slice(0, 5);
        for (const id of otherIds) {
          try { rows.push(...await fetchOrderRows(id)); }
          catch (error) { /* Diğer sevklerdeki orderlar taranmaya devam eder. */ }
        }
      } catch (error) { /* Konsültasyon sevkindeki başarılı sorgu yine geçerlidir. */ }
    }
    const unique = rows.filter((row, index, all) => {
      const identity = (item) => clean(item.id) || [clean(item.stok?.adi || item.adi || item.ilacAdi), clean(item.doz), clean(item.baslangicTarihi)].join("|");
      return all.findIndex((candidate) => identity(candidate) === identity(row)) === index;
    });
    record.orders = unique.map((row) => ({
      name:clean(row.stok?.adi || row.hizmetMakro?.adi || row.malzeme?.adi || row.malzemeAdi || row.adi || row.tedaviAdi || row.ilacAdi || row.aciklama || ""),
      dose:clean(row.doz || row.miktar || ""),
      usage:clean(row.ilacKullanimSekli?.adi || row.ilacKullanimSekliAdi || row.kullanimSekli || ""),
      start:clean(row.baslangicTarihi || row.istemTarihi || ""),
      status:clean(row.durum?.adi || row.durumAdi || (typeof row.durum === "string" ? row.durum : ""))
    })).filter((row) => row.name);
  }

  async function enrichRecord(record) {
    const errors = [];
    try {
      const sevkPayload = await apiJson(`/Tibbi/HastaBirimSevk/getSevkUyariInfo/${encodeURIComponent(record.birimSevkId)}`);
      const root = sevkPayload?.data || sevkPayload || {};
      const ids = inferPatientIds(root);
      record.hastaGelisId = record.hastaGelisId || ids.hastaGelisId;
      record.hastaId = record.hastaId || ids.hastaId;
      const diagnoses = diagnosisNames(root);
      if (!record.diagnosis && diagnoses.length) record.diagnosis = diagnoses.join(", ");
    } catch (error) { if (!record.diagnosis) errors.push("Tanı"); }
    const tasks = [["Kan", fetchLatestLabs], ["Görüntüleme", fetchImaging], ["Order", fetchOrders]];
    await Promise.all(tasks.map(async ([label, handler]) => { try { await handler(record); } catch (error) { errors.push(label); } }));
    record.detailErrors = errors;
    record.detailsLoaded = errors.length === 0;
  }

  async function enrichRecords(records) {
    const pending = records.filter((record) => !record.detailsLoaded);
    let done = 0;
    const queue = [...pending];
    const worker = async () => {
      while (queue.length) {
        const record = queue.shift();
        if (!record) return;
        await enrichRecord(record);
        done += 1;
        setMessage(`${done}/${pending.length} hastanın tanı, kan, görüntüleme ve order bilgileri hazırlanıyor…`);
      }
    };
    await Promise.all(Array.from({ length:Math.min(3, queue.length) }, worker));
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
    const lines = String(text == null ? "" : text).replace(/\r/g, "").split(/\n/).map((line) => line.trim()).filter(Boolean);
    const runs = (lines.length ? lines : [""]).map((line, index) =>
      (index ? "<w:r><w:br/></w:r>" : "") +
      `<w:r><w:rPr><w:rFonts w:ascii="Tahoma" w:hAnsi="Tahoma"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/>${options.bold ? "<w:b/>" : ""}<w:color w:val="${color}"/></w:rPr><w:t xml:space="preserve">${xmlEsc(line)}</w:t></w:r>`
    ).join("");
    return `<w:p><w:pPr>${options.keep ? "<w:keepNext/>" : ""}${options.align ? `<w:jc w:val="${options.align}"/>` : ""}<w:spacing w:before="${options.before || 0}" w:after="${options.after || 0}" w:line="185" w:lineRule="auto"/></w:pPr>${runs}</w:p>`;
  }

  function wordTableCell(value, options = {}) {
    const width = Number(options.width || 1000);
    const shade = options.shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${options.shade}"/>` : "";
    const bold = options.bold ? "<w:b/>" : "";
    return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${shade}<w:tcMar><w:top w:w="10" w:type="dxa"/><w:left w:w="30" w:type="dxa"/><w:bottom w:w="10" w:type="dxa"/><w:right w:w="30" w:type="dxa"/></w:tcMar></w:tcPr><w:p><w:pPr><w:spacing w:before="0" w:after="0"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Tahoma" w:hAnsi="Tahoma"/>${bold}<w:sz w:val="15"/><w:szCs w:val="15"/></w:rPr><w:t xml:space="preserve">${xmlEsc(value || "—")}</w:t></w:r></w:p></w:tc>`;
  }

  function wordLabTable(record) {
    const labs = Array.isArray(record.labs) ? record.labs : [];
    if (!labs.length) return wordParagraph(record.detailErrors?.includes("Kan") ? "Kan sonuçları alınamadı." : "Son güncel kan sonucu bulunamadı.", { size:8 });
    const pairs = [];
    for (let index = 0; index < labs.length; index += 2) pairs.push([labs[index], labs[index + 1]]);
    const borders = '<w:tblBorders><w:top w:val="single" w:sz="3" w:color="CBD5E1"/><w:left w:val="single" w:sz="3" w:color="CBD5E1"/><w:bottom w:val="single" w:sz="3" w:color="CBD5E1"/><w:right w:val="single" w:sz="3" w:color="CBD5E1"/><w:insideH w:val="single" w:sz="3" w:color="E2E8F0"/><w:insideV w:val="single" w:sz="3" w:color="E2E8F0"/></w:tblBorders>';
    const header = `<w:tr>${wordTableCell("Tetkik", { width:700, bold:true, shade:"E2E8F0" })}${wordTableCell("Sonuç", { width:1500, bold:true, shade:"E2E8F0" })}${wordTableCell("Tetkik", { width:700, bold:true, shade:"E2E8F0" })}${wordTableCell("Sonuç", { width:1500, bold:true, shade:"E2E8F0" })}</w:tr>`;
    const rows = pairs.map(([left, right]) => `<w:tr>${wordTableCell(left?.label, { width:700, bold:true })}${wordTableCell(left ? `${left.value}${left.unit ? " " + left.unit : ""}` : "", { width:1500 })}${wordTableCell(right?.label, { width:700, bold:true })}${wordTableCell(right ? `${right.value}${right.unit ? " " + right.unit : ""}` : "", { width:1500 })}</w:tr>`).join("");
    return `<w:tbl><w:tblPr><w:tblW w:w="4400" w:type="dxa"/><w:tblLayout w:type="fixed"/>${borders}</w:tblPr><w:tblGrid><w:gridCol w:w="700"/><w:gridCol w:w="1500"/><w:gridCol w:w="700"/><w:gridCol w:w="1500"/></w:tblGrid>${header}${rows}</w:tbl>`;
  }

  function wordPatient(record) {
    const title = [record.name, record.ageSex, record.protocol ? "Prot: " + record.protocol : ""].filter(Boolean).join(" · ");
    return [
      wordParagraph(title, { size:12, bold:true, keep:true, after:15 }),
      wordParagraph("YATIŞ KARARI: " + (record.signal || "Yatış kararı"), { size:10, bold:true, color:"B91C1C" }),
      wordParagraph("TANI: " + (record.diagnosis || (record.detailErrors?.includes("Tanı") ? "Tanı kaydı alınamadı" : "Tanı kaydı bulunamadı")), { size:10, bold:true }),
      wordParagraph("Konsültasyon Tarihi: " + (record.date || "—"), { size:9 }),
      wordParagraph("İsteyen Birim: " + (record.requestingUnit || "—"), { size:9 }),
      wordParagraph("Konsültasyon Birimi: " + (record.unit || "Genel Cerrahi"), { size:9 }),
      wordParagraph("KONS İSTEMİ", { size:9, bold:true, keep:true, before:40 }),
      wordParagraph(record.request || "—", { size:9 }),
      wordParagraph("GENEL CERRAHİ CEVABI", { size:9, bold:true, keep:true, before:40 }),
      wordParagraph(record.answer || "—", { size:9 }),
      wordParagraph("SON GÜNCEL KANLAR" + (record.labDate ? " · " + record.labDate : ""), { size:9, bold:true, keep:true, before:45 }),
      wordLabTable(record),
      wordParagraph("GÖRÜNTÜLEMELER", { size:9, bold:true, keep:true, before:45 }),
      ...((record.imaging || []).length ? record.imaging.map((item) => wordParagraph(`${item.date || ""} ${item.exam || "Görüntüleme"}${item.report ? "\n" + item.report : ""}`, { size:8 })) : [wordParagraph(record.detailErrors?.includes("Görüntüleme") ? "Görüntüleme bilgileri alınamadı." : "Görüntüleme bulunamadı.", { size:8 })]),
      wordParagraph("ORDER", { size:9, bold:true, keep:true, before:45 }),
      ...((record.orders || []).length ? record.orders.map((item, index) => wordParagraph(`${index + 1}. ${item.name}${item.dose ? " · " + item.dose : ""}${item.usage ? " · " + item.usage : ""}${item.start ? " · " + item.start : ""}${item.status ? " · " + item.status : ""}`, { size:8 })) : [wordParagraph(record.detailErrors?.includes("Order") ? "Order bilgileri alınamadı." : "Bugüne ait order bulunamadı.", { size:8 })]),
      wordParagraph("BH: ______________________________________________", { size:9, before:45 }),
      wordParagraph("Kİ: _______________________________________________", { size:9 }),
      wordParagraph("GO: ______________________________________________", { size:9 }),
      wordParagraph("PLAN: ____________________________________________", { size:9 }),
      wordParagraph("------------------------------------------------------------", { size:9, color:"64748B", before:45, after:60 })
    ].join("");
  }

  function docxBytes(records) {
    const body = wordParagraph("GENEL CERRAHİ YATIŞ VİZİT", { size:14, bold:true, after:70 }) + records.map(wordPatient).join("");
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

  async function exportWord() {
    const records = selectedRecords();
    if (!records.length) return alert("Önce en az bir yatış verilen hasta seçin.");
    state.busy = true;
    render();
    try {
      await enrichRecords(records);
      downloadBytes(docxBytes(records), `Genel-Cerrahi-Yatis-Vizit-${new Date().toISOString().slice(0,10)}.docx`, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      const failedSections = [...new Set(records.flatMap((record) => record.detailErrors || []))];
      setMessage(`${records.length} hasta için Word indirildi.${failedSections.length ? ` Alınamayan bölümler: ${failedSections.join(", ")}.` : ""}`);
    } finally {
      state.busy = false;
      render();
    }
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
