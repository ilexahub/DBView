(() => {
  if (!window.DBF) {
    document.body.innerHTML = "<p style='padding:2rem;font:16px sans-serif'>Не найден dbf-engine.js — положите его рядом с index.html.</p>";
    return;
  }
  if (!window.SQLITE) {
    document.body.innerHTML = "<p style='padding:2rem;font:16px sans-serif'>Не найден sqlite-engine.js — положите его рядом с index.html.</p>";
    return;
  }

  const {
    LD_ENC, versionName, makeCodec, layoutFields, parseDbf, refreshFieldNames,
    encodeField, decodeField, serializeDbf, estimatedSize, setDeleted,
    packRecords, deleteField, addBlankRecord, buildDemo
  } = window.DBF;
  const SQLITE = window.SQLITE;

  const ROW_H = 28;
  const $ = (id) => document.getElementById(id);
  const els = {
    file: $("file"), enc: $("enc"), search: $("search"), showDel: $("showDel"),
    stats: $("stats"), banner: $("banner"), empty: $("empty"), drop: $("drop"),
    gridRoot: $("gridRoot"), head: $("head"), body: $("body"),
    headCols: $("headCols"), bodyCols: $("bodyCols"),
    headTable: $("headTable"), bodyTable: $("bodyTable"),
    headScroll: $("headScroll"), bodyScroll: $("bodyScroll"),
    side: $("side"), fieldList: $("fieldList"), toast: $("toast"),
    fileLabel: $("fileLabel"),
    btnClose: $("btnClose"),
    btnSave: $("btnSave"), btnDownload: $("btnDownload"), btnAdd: $("btnAdd"),
    btnDel: $("btnDel"), btnUndel: $("btnUndel"), btnPack: $("btnPack"),
    btnUndo: $("btnUndo"), btnStruct: $("btnStruct"),
    tableWrap: $("tableWrap"), tableSel: $("tableSel"),
    encWrap: $("encWrap"), showDelWrap: $("showDelWrap"),
    structHint: $("structHint")
  };

  const state = {
    kind: null,
    db: null,
    sql: null,
    filename: "",
    fileHandle: null,
    encoding: "ibm866",
    codec: null,
    filter: "",
    showDeleted: true,
    selected: new Set(),
    dirty: false,
    undo: null,
    view: [],
    colW: []
  };

  let toastTimer = 0;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 3200);
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fmtSize(n) {
    if (n < 1024) return n + " Б";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " КБ";
    return (n / 1024 / 1024).toFixed(2) + " МБ";
  }
  function isSql() { return state.kind === "sqlite"; }
  function fields() { return isSql() ? state.sql.fields : state.db.fields; }
  function records() { return isSql() ? state.sql.records : state.db.records; }
  function openOk() { return isSql() ? !!state.sql : !!state.db; }

  function cellText(field, rec, fi) {
    if (isSql()) return SQLITE.displayValue(rec.values[fi]).text;
    return decodeField(field, rec, state.codec);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Не загрузился " + src));
      document.head.appendChild(s);
    });
  }

  async function loadWasmBinary() {
    if (window.SQL_WASM_BINARY) return window.SQL_WASM_BINARY;
    if (location.protocol !== "file:") {
      try {
        const res = await fetch("lib/sql-wasm.wasm");
        if (res.ok) return new Uint8Array(await res.arrayBuffer());
      } catch (_) { /* file:// or missing wasm — ниже JS-копия */ }
    }
    await loadScript("lib/sql-wasm-binary.js");
    if (!window.SQL_WASM_BINARY) {
      throw new Error("Нет локального SQLite: положите lib/sql-wasm.js и lib/sql-wasm-binary.js рядом с index.html");
    }
    return window.SQL_WASM_BINARY;
  }

  async function ensureSqlJs() {
    if (ensureSqlJs.mod) return ensureSqlJs.mod;
    if (!window.initSqlJs) await loadScript("lib/sql-wasm.js");
    if (!window.initSqlJs) throw new Error("Не найден lib/sql-wasm.js — папка lib должна лежать рядом с index.html");
    const wasmBinary = await loadWasmBinary();
    const SQL = await window.initSqlJs({ wasmBinary });
    ensureSqlJs.mod = SQL;
    return SQL;
  }

  function snapshot(label) {
    if (isSql()) {
      state.undo = {
        kind: "sqlite",
        label,
        bytes: state.sql.engine.export(),
        table: state.sql.table
      };
    } else if (state.db) {
      state.undo = {
        kind: "dbf",
        label,
        fields: state.db.fields.map((f) => ({ ...f, raw: f.raw && f.raw.slice() })),
        records: state.db.records.map((r) => ({ deleted: r.deleted, data: r.data.slice() })),
        extraHeader: state.db.extraHeader && state.db.extraHeader.slice()
      };
    } else return;
    els.btnUndo.disabled = false;
    els.btnUndo.textContent = "Отменить: " + label;
  }

  function markDirty(v) { state.dirty = v; }

  function applyFilter() {
    if (!openOk()) { state.view = []; return; }
    const q = state.filter.trim().toLocaleLowerCase("ru");
    const recs = records();
    const flds = fields();
    const out = [];
    recs.forEach((rec, i) => {
      if (!state.showDeleted && rec.deleted) return;
      if (q) {
        let hit = String(i + 1).includes(q);
        if (!hit) {
          for (let fi = 0; fi < flds.length; fi++) {
            if (cellText(flds[fi], rec, fi).toLocaleLowerCase("ru").includes(q)) { hit = true; break; }
          }
        }
        if (!hit) return;
      }
      out.push(i);
    });
    state.view = out;
  }

  function colWidths() {
    const flds = fields();
    const w = [36, 58, 34];
    for (const f of flds) {
      const byName = f.name.length * 9 + 48;
      const byLen = (f.length || 16) * 9 + 24;
      w.push(Math.max(88, Math.min(360, Math.max(byName, byLen))));
    }
    state.colW = w;
    const cols = w.map((x) => `<col style="width:${x}px">`).join("");
    els.headCols.innerHTML = cols;
    els.bodyCols.innerHTML = cols;
    const total = w.reduce((a, b) => a + b, 0);
    els.headTable.style.width = total + "px";
    els.bodyTable.style.width = total + "px";
  }

  function typeLabel(f) {
    if (isSql()) return SQLITE.shortType(f.type);
    return f.type;
  }

  function renderHead() {
    const flds = fields();
    const allSel = state.view.length && state.view.every((i) => state.selected.has(i));
    let html = "<tr>";
    html += `<th class="chk"><input type="checkbox" id="chkAll" ${allSel ? "checked" : ""}></th>`;
    html += '<th class="num">№</th><th class="flag">DEL</th>';
    flds.forEach((f, i) => {
      const extra = isSql()
        ? (f.pk ? " PK" : "") + (f.notnull ? " NN" : "")
        : (f.length ? String(f.length) : "") + (f.decimal ? "," + f.decimal : "");
      html += `<th data-fi="${i}">${esc(f.name)}<span class="t">${esc(typeLabel(f))}</span><span class="len">${esc(extra)}</span></th>`;
    });
    html += "</tr>";
    els.head.innerHTML = html;
  }

  function renderBody() {
    const recs = records();
    const flds = fields();
    const scroll = els.bodyScroll;
    const view = state.view;
    const y = scroll.scrollTop;
    const h = scroll.clientHeight;
    const total = view.length * ROW_H;
    const start = Math.max(0, Math.floor(y / ROW_H) - 8);
    const end = Math.min(view.length, Math.ceil((y + h) / ROW_H) + 8);
    const padTop = start * ROW_H;
    const padBot = Math.max(0, total - end * ROW_H);
    const span = 3 + flds.length;

    const parts = [];
    if (padTop) parts.push(`<tr class="pad" style="height:${padTop}px"><td colspan="${span}" style="padding:0;border:0;height:${padTop}px"></td></tr>`);
    for (let vi = start; vi < end; vi++) {
      const ri = view[vi];
      const rec = recs[ri];
      const cls = (rec.deleted ? "del " : "") + (state.selected.has(ri) ? "sel" : "");
      let row = `<tr class="${cls}" data-ri="${ri}">`;
      row += `<td class="chk"><input type="checkbox" ${state.selected.has(ri) ? "checked" : ""}></td>`;
      row += `<td class="num">${ri + 1}</td>`;
      row += `<td class="flag" title="Пометить / снять">${rec.deleted ? "*" : ""}</td>`;
      flds.forEach((f, fi) => {
        if (isSql()) {
          const d = SQLITE.displayValue(rec.values[fi]);
          const cls2 = "val" + (d.nullish ? " nullish" : "") + (d.blob ? " blob" : "");
          row += `<td class="${cls2}" data-fi="${fi}">${esc(d.text)}</td>`;
        } else {
          row += `<td class="val" data-fi="${fi}">${esc(cellText(f, rec, fi))}</td>`;
        }
      });
      row += "</tr>";
      parts.push(row);
    }
    if (padBot) parts.push(`<tr class="pad" style="height:${padBot}px"><td colspan="${span}" style="padding:0;border:0;height:${padBot}px"></td></tr>`);
    if (!view.length) {
      parts.push(`<tr><td colspan="${span}" style="color:var(--muted);padding:20px">Нет записей по текущему фильтру</td></tr>`);
    }
    els.body.innerHTML = parts.join("");
  }

  function renderStats() {
    if (!openOk()) { els.stats.innerHTML = ""; return; }
    if (isSql()) {
      const info = state.sql.info;
      const recs = state.sql.records;
      const del = recs.filter((r) => r.deleted).length;
      const free = info.freeBytes || 0;
      const pct = info.fileSize ? Math.min(100, Math.round(free / info.fileSize * 100)) : 0;
      els.stats.innerHTML = `
        <span>Формат: <b>SQLite 3</b></span>
        <span>Движок: <b>${esc(info.version)}</b></span>
        <span>Кодировка: <b>${esc(info.encoding)}</b></span>
        <span>Страница: <b>${fmtSize(info.pageSize)}</b></span>
        <span>Таблиц: <b>${state.sql.tables.length}</b></span>
        <span>Таблица: <b>${esc(state.sql.table)}</b>${state.sql.withoutRowid ? " <span style='color:var(--warn)'>WITHOUT ROWID</span>" : ""}</span>
        <span>Колонок: <b>${state.sql.fields.length}</b></span>
        <span>Записей: <b>${recs.length}</b></span>
        <span class="waste">Помечено: <b>${del}</b> · freelist <b>${info.freelist}</b> стр. (${fmtSize(free)})
          <span class="waste-bar" title="Доля свободных страниц"><i style="width:${pct}%"></i></span>
        </span>
        <span>Файл: <b>${fmtSize(info.fileSize)}</b></span>
        <span>Показано: <b>${state.view.length}</b></span>
      `;
      if (info.freelist || del) {
        els.banner.style.display = "block";
        els.banner.textContent = (del ? "Помеченные строки удалятся из таблицы при сжатии. " : "") +
          (info.freelist ? "Свободные страницы (freelist) остаются в файле, пока не сделать VACUUM." : "");
      } else {
        els.banner.style.display = "none";
      }
      return;
    }
    const db = state.db;
    const del = db.records.filter((r) => r.deleted).length;
    const recLen = 1 + db.fields.reduce((s, f) => s + f.length, 0);
    const waste = del * recLen;
    const cur = estimatedSize(db);
    const packed = estimatedSize({ ...db, records: db.records.filter((r) => !r.deleted) });
    const pct = db.records.length ? Math.round(del / db.records.length * 100) : 0;
    const date = db.yy != null ? `${1900 + db.yy}-${String(db.mm).padStart(2, "0")}-${String(db.dd).padStart(2, "0")}` : "—";
    els.stats.innerHTML = `
      <span>Формат: <b>${esc(versionName(db.version))}</b></span>
      <span>Обновлён: <b>${esc(date)}</b></span>
      <span>Полей: <b>${db.fields.length}</b></span>
      <span>Записей: <b>${db.records.length}</b>${!state.dirty && db.recCountHdr !== db.records.length ? ` <span style="color:var(--warn)">(в заголовке ${db.recCountHdr})</span>` : ""}</span>
      <span>Длина записи: <b>${recLen} Б</b></span>
      <span class="waste">Помечено: <b>${del}</b> (${pct}%) · мусор <b>${fmtSize(waste)}</b>
        <span class="waste-bar" title="Доля помеченных записей"><i style="width:${pct}%"></i></span>
      </span>
      <span>Файл: <b>${fmtSize(cur)}</b>${del ? ` → после сжатия <b>${fmtSize(packed)}</b>` : ""}</span>
      <span>Показано: <b>${state.view.length}</b></span>
    `;
    const memos = db.fields.filter((f) => "MGP".includes(f.type));
    if (memos.length) {
      els.banner.style.display = "block";
      els.banner.textContent = "Есть memo-поля (" + memos.map((f) => f.name).join(", ") +
        "). Текст мемо лежит в соседнем .dbt/.fpt — этот редактор правит только указатели в DBF.";
    } else {
      els.banner.style.display = "none";
    }
  }

  function renderFields() {
    const flds = fields();
    const recs = records();
    els.fieldList.innerHTML = flds.map((f, i) => {
      const meta = isSql()
        ? `${esc(f.type || "BLOB")}${f.pk ? " · PRIMARY KEY" : ""}${f.notnull ? " · NOT NULL" : ""}${f.dflt != null ? " · DEFAULT " + esc(String(f.dflt)) : ""}`
        : `Тип ${esc(f.type)} · длина ${f.length}${f.decimal ? " · знаков " + f.decimal : ""} · в файле ${fmtSize(f.length * recs.length)}`;
      return `<div class="field-card">
        <header>
          <span class="name">${esc(f.name)}</span>
          <button class="danger" data-del-field="${i}" ${flds.length <= 1 ? "disabled" : ""}>Удалить поле</button>
        </header>
        <div class="field-meta">${meta}</div>
      </div>`;
    }).join("");
  }

  function fillTableSelect() {
    if (!isSql()) {
      els.tableWrap.classList.add("hide");
      return;
    }
    els.tableWrap.classList.remove("hide");
    els.tableSel.innerHTML = state.sql.tables.map((t) =>
      `<option value="${esc(t)}" ${t === state.sql.table ? "selected" : ""}>${esc(t)}</option>`
    ).join("");
  }

  function canPack() {
    if (isSql()) {
      const del = state.sql.records.some((r) => r.deleted);
      return del || (state.sql.info.freelist > 0);
    }
    return state.db && state.db.records.some((r) => r.deleted);
  }

  function renderAll() {
    if (!openOk()) return;
    applyFilter();
    colWidths();
    renderHead();
    renderBody();
    renderStats();
    renderFields();
    fillTableSelect();
    ["btnClose", "btnSave", "btnDownload", "btnAdd", "btnDel", "btnUndel", "btnPack", "btnStruct"].forEach((id) => {
      $(id).disabled = false;
    });
    els.search.disabled = false;
    els.showDel.disabled = false;
    els.enc.disabled = isSql();
    els.encWrap.classList.toggle("hide", isSql());
    els.btnPack.disabled = !canPack();
    els.btnUndo.disabled = !state.undo;
    els.structHint.textContent = isSql()
      ? "ALTER TABLE DROP COLUMN. После удаления колонки индексы перестроит SQLite сам. Сжатие — VACUUM."
      : "Имена полей — до 10 символов. После удаления колонки индексы .cdx/.mdx/.idx станут недействительны.";
    const name = state.filename + (state.dirty ? " • изменён" : "");
    els.fileLabel.innerHTML = `<i class="dot${state.dirty ? " dirty" : ""}" id="dirtyDot"></i>${esc(name)}`;
  }

  function showGrid() {
    els.empty.style.display = "none";
    els.gridRoot.style.display = "flex";
  }

  function showHome(force) {
    if (!openOk() && !state.kind) return;
    if (!force && state.dirty && !confirm("Есть несохранённые изменения. Закрыть без сохранения?")) return;
    closeSql();
    state.kind = null;
    state.db = null;
    state.filename = "";
    state.fileHandle = null;
    state.undo = null;
    state.selected = new Set();
    state.filter = "";
    state.view = [];
    state.colW = [];
    markDirty(false);
    els.search.value = "";
    els.empty.style.display = "";
    els.gridRoot.style.display = "none";
    els.side.classList.remove("open");
    els.banner.style.display = "none";
    els.banner.textContent = "";
    els.stats.innerHTML = "";
    els.head.innerHTML = "";
    els.body.innerHTML = "";
    els.fieldList.innerHTML = "";
    els.tableWrap.classList.add("hide");
    els.encWrap.classList.remove("hide");
    els.enc.disabled = true;
    els.search.disabled = true;
    els.showDel.disabled = true;
    ["btnClose", "btnSave", "btnDownload", "btnAdd", "btnDel", "btnUndel", "btnPack", "btnStruct"].forEach((id) => {
      $(id).disabled = true;
    });
    els.btnUndo.disabled = true;
    els.btnUndo.textContent = "Отменить";
    els.fileLabel.innerHTML = `<i class="dot" id="dirtyDot"></i>файл не открыт`;
    toast("Файл закрыт");
  }

  function closeSql() {
    if (state.sql && state.sql.engine) {
      try { state.sql.engine.close(); } catch (_) { /* ignore */ }
    }
    state.sql = null;
  }

  function loadDbf(db, filename) {
    closeSql();
    state.kind = "dbf";
    state.db = db;
    state.filename = filename;
    state.selected = new Set();
    state.undo = null;
    state.filter = "";
    els.search.value = "";
    const guess = LD_ENC[db.languageDriver];
    if (guess) {
      state.encoding = guess;
      els.enc.value = guess;
    }
    state.codec = makeCodec(state.encoding);
    refreshFieldNames(db, state.codec);
    layoutFields(db.fields);
    markDirty(false);
    showGrid();
    requestAnimationFrame(() => renderAll());
    toast("Открыто: " + filename + " · " + db.records.length + " записей");
  }

  function bindSqlite(engine, filename, table, quiet) {
    const tables = SQLITE.listTables(engine);
    if (!tables.length) throw new Error("В базе нет пользовательских таблиц");
    const use = table && tables.includes(table) ? table : tables[0];
    const attached = SQLITE.attachTable(engine, use);
    state.kind = "sqlite";
    state.db = null;
    state.sql = { engine, ...attached };
    state.filename = filename;
    state.selected = new Set();
    state.filter = "";
    els.search.value = "";
    markDirty(false);
    showGrid();
    requestAnimationFrame(() => renderAll());
    if (!quiet) toast("Открыто: " + filename + " · SQLite 3 · таблица " + use);
  }

  function reloadSqlTable(table) {
    const attached = SQLITE.attachTable(state.sql.engine, table || state.sql.table);
    state.sql = { engine: state.sql.engine, ...attached };
    state.selected = new Set();
  }

  function openDemo() {
    state.fileHandle = null;
    state.encoding = "ibm866";
    els.enc.value = "ibm866";
    state.codec = makeCodec("ibm866");
    loadDbf(buildDemo(state.codec), "primer.dbf");
  }

  async function openDemoSql() {
    const SQL = await ensureSqlJs();
    closeSql();
    state.fileHandle = null;
    state.undo = null;
    bindSqlite(SQLITE.createDemo(SQL), "primer.sqlite", "people");
  }

  async function openSqliteBuffer(buf, filename, handle) {
    const SQL = await ensureSqlJs();
    closeSql();
    state.fileHandle = handle || null;
    state.undo = null;
    const engine = new SQL.Database(new Uint8Array(buf));
    bindSqlite(engine, filename);
  }

  async function openFromFile(file, handle) {
    let buf;
    try {
      buf = await file.arrayBuffer();
    } catch (e) {
      toast("Не удалось прочитать файл: " + errText(e));
      return;
    }
    if (SQLITE.isSqlite(buf)) {
      try {
        await openSqliteBuffer(buf, file.name, handle);
      } catch (e) {
        toast(errText(e));
      }
      return;
    }
    try {
      const db = parseDbf(buf);
      state.fileHandle = handle || null;
      loadDbf(db, file.name);
    } catch (e) {
      toast("Не DBF и не SQLite format 3: " + errText(e));
    }
  }

  function pickFile() {
    els.file.click();
  }

  function binaryAccept(exts) {
    return { "application/octet-stream": exts };
  }

  function errText(e) {
    if (e == null) return "неизвестная ошибка";
    if (typeof e === "string") return e;
    const name = e.name && e.name !== "Error" ? e.name + ": " : "";
    return name + (e.message || String(e));
  }

  function bytesToSave() {
    if (isSql()) {
      try {
        const raw = state.sql.engine.export();
        if (!raw || !raw.byteLength) throw new Error("export вернул пустой буфер");
        return raw;
      } catch (e) {
        throw new Error("Не удалось собрать SQLite: " + errText(e));
      }
    }
    return serializeDbf(state.db, state.encoding);
  }

  function copyBytes(bytes) {
    const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const out = new Uint8Array(src.byteLength);
    out.set(src);
    return out;
  }

  function extOf(name) {
    const n = String(name || "");
    const i = n.lastIndexOf(".");
    return i >= 0 ? n.slice(i).toLowerCase() : "";
  }

  function defaultName() {
    if (state.filename) return state.filename;
    return isSql() ? "data.sqlite" : "data.dbf";
  }

  function saveTypes() {
    if (isSql()) {
      const ext = extOf(defaultName());
      const exts = [".db", ".sqlite", ".sqlite3"];
      const primary = exts.includes(ext) ? ext : ".db";
      return [{
        description: "SQLite",
        accept: binaryAccept([primary].concat(exts.filter((e) => e !== primary)))
      }];
    }
    return [{ description: "dBase DBF", accept: binaryAccept([".dbf"]) }];
  }

  function canUseSavePicker() {
    return typeof window.showSaveFilePicker === "function" && location.protocol !== "file:";
  }

  function anchorDownload(bytes) {
    const payload = copyBytes(bytes);
    const blob = new Blob([payload], { type: "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = defaultName() || (isSql() ? "data.db" : "data.dbf");
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 4000);
    markDirty(false);
    if (openOk()) renderAll();
    toast("Скачан файл " + a.download + " · " + fmtSize(payload.length));
  }

  async function writeHandle(handle, bytes) {
    const payload = copyBytes(bytes);
    const w = await handle.createWritable();
    try {
      await w.write(payload.buffer);
      await w.truncate(payload.byteLength);
      await w.close();
    } catch (e) {
      try { await w.abort(); } catch (_) { /* ignore */ }
      throw e;
    }
  }

  function buildSavePayload() {
    return copyBytes(bytesToSave());
  }

  async function chooseSaveHandle() {
    const base = {
      suggestedName: defaultName(),
      excludeAcceptAllOption: false,
      id: "dbase-save"
    };
    if (state.fileHandle) base.startIn = state.fileHandle;
    try {
      return await window.showSaveFilePicker({ ...base, types: saveTypes() });
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      if (e && e.name === "TypeError") {
        return await window.showSaveFilePicker({
          suggestedName: defaultName(),
          excludeAcceptAllOption: false
        });
      }
      throw e;
    }
  }

  async function saveAs() {
    if (!openOk()) return;
    if (!canUseSavePicker()) {
      anchorDownload(buildSavePayload());
      return;
    }
    let handle;
    try {
      handle = await chooseSaveHandle();
    } catch (e) {
      if (e && e.name === "AbortError") return;
      throw e;
    }
    const payload = buildSavePayload();
    await writeHandle(handle, payload);
    state.fileHandle = handle;
    state.filename = handle.name || state.filename;
    markDirty(false);
    renderAll();
    toast("Сохранено: " + state.filename + " · " + fmtSize(payload.length));
  }

  function hasWriteGrant(handle) {
    if (!handle || typeof handle.queryPermission !== "function") return Promise.resolve(false);
    return handle.queryPermission({ mode: "readwrite" }).then((s) => s === "granted").catch(() => false);
  }

  async function saveReplace() {
    if (!openOk()) return;
    const handle = state.fileHandle;
    if (handle && typeof handle.createWritable === "function" && await hasWriteGrant(handle)) {
      try {
        const payload = buildSavePayload();
        await writeHandle(handle, payload);
        markDirty(false);
        renderAll();
        toast("Записано в " + state.filename + " (" + fmtSize(payload.length) + ")");
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;
        toast("Не удалось перезаписать файл: " + errText(e));
      }
    }
    await saveAs();
  }

  function pack() {
    if (isSql()) {
      const n = state.sql.records.filter((r) => r.deleted).length;
      const free = state.sql.info.freelist;
      if (!n && !free) { toast("Нечего сжимать"); return; }
      const msg = [
        n ? `Удалить из таблицы ${n} помеченных строк.` : "Помеченных строк нет.",
        free ? `VACUUM уберёт ${free} свободных страниц (~${fmtSize(state.sql.info.freeBytes)}).` : "Freelist пуст — VACUUM всё равно пересоберёт файл, если были удаления.",
        "До сохранения можно отменить."
      ].join("\n");
      if (!confirm(msg)) return;
      snapshot("сжатие");
      try {
        if (n) SQLITE.deleteMarked(state.sql.engine, state.sql.table, state.sql.records, state.sql.withoutRowid, state.sql.fields);
        SQLITE.vacuum(state.sql.engine);
        reloadSqlTable(state.sql.table);
        markDirty(true);
        renderAll();
        toast("VACUUM готов. Сохраните файл, чтобы записать на диск.");
      } catch (e) {
        toast(e.message || String(e));
      }
      return;
    }
    const n = state.db.records.filter((r) => r.deleted).length;
    if (!n) { toast("Помеченных записей нет"); return; }
    const before = estimatedSize(state.db);
    const after = estimatedSize({ ...state.db, records: state.db.records.filter((r) => !r.deleted) });
    if (!confirm(`Физически удалить ${n} помеченных записей?\n\nФайл уменьшится примерно с ${fmtSize(before)} до ${fmtSize(after)}.\nВ памяти это можно отменить до сохранения.`)) return;
    snapshot("сжатие");
    packRecords(state.db);
    state.selected = new Set();
    markDirty(true);
    renderAll();
    toast("Сжато: убрано " + n + " записей. Сохраните файл, чтобы записать на диск.");
  }

  function removeField(index) {
    const f = fields()[index];
    if (fields().length <= 1) return;
    if (isSql()) {
      if (!confirm(`Удалить колонку «${f.name}» (${f.type || "BLOB"}) из таблицы ${state.sql.table}?`)) return;
      snapshot("поле " + f.name);
      try {
        SQLITE.dropColumn(state.sql.engine, state.sql.table, f.name);
        reloadSqlTable(state.sql.table);
        markDirty(true);
        renderAll();
        toast("Колонка " + f.name + " удалена. Сжатие (VACUUM) заберёт место в файле.");
      } catch (e) {
        toast(e.message || String(e));
      }
      return;
    }
    if (!confirm(`Удалить поле «${f.name}» (${f.type}, ${f.length}) из всех записей?\nКолонка пропадёт из файла, он станет короче примерно на ${fmtSize(f.length * state.db.records.length)}.`)) return;
    snapshot("поле " + f.name);
    deleteField(state.db, index);
    markDirty(true);
    renderAll();
    toast("Поле " + f.name + " удалено. После сохранения файл станет короче.");
  }

  function addRecord() {
    snapshot("запись");
    if (isSql()) {
      try {
        SQLITE.addRow(state.sql.engine, state.sql.table, state.sql.fields);
        reloadSqlTable(state.sql.table);
        markDirty(true);
        renderAll();
        els.bodyScroll.scrollTop = els.bodyScroll.scrollHeight;
      } catch (e) {
        toast(e.message || String(e));
      }
      return;
    }
    addBlankRecord(state.db);
    markDirty(true);
    renderAll();
    els.bodyScroll.scrollTop = els.bodyScroll.scrollHeight;
  }

  function toggleSelected(flag) {
    if (!state.selected.size) {
      toast("Сначала отметьте строки слева");
      return;
    }
    snapshot(flag ? "пометка" : "снятие пометок");
    const recs = records();
    for (const i of state.selected) {
      if (isSql()) recs[i].deleted = flag;
      else setDeleted(recs[i], flag);
    }
    markDirty(true);
    renderAll();
  }

  function startEdit(td, ri, fi) {
    if (td.querySelector("input")) return;
    const flds = fields();
    const rec = records()[ri];
    const field = flds[fi];
    if (isSql() && SQLITE.isBlobValue(rec.values[fi])) {
      toast("BLOB в этом редакторе только для просмотра");
      return;
    }
    const input = document.createElement("input");
    if (isSql()) {
      const d = SQLITE.displayValue(rec.values[fi]);
      input.value = d.nullish ? "" : d.text;
    } else {
      input.value = cellText(field, rec, fi);
    }
    td.classList.add("editing");
    td.textContent = "";
    td.appendChild(input);
    input.focus();
    input.select();
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      td.classList.remove("editing");
      renderBody();
    };
    const commit = () => {
      if (cancelled) return;
      try {
        if (isSql()) {
          SQLITE.updateCell(state.sql.engine, state.sql.table, rec, field, input.value, state.sql.withoutRowid, flds);
          const attached = SQLITE.attachTable(state.sql.engine, state.sql.table);
          const keepDel = new Map(state.sql.records.map((r, i) => [r.rowid, r.deleted]));
          state.sql.fields = attached.fields;
          state.sql.records = attached.records;
          state.sql.info = attached.info;
          if (!state.sql.withoutRowid) {
            for (const r of state.sql.records) {
              if (keepDel.get(r.rowid)) r.deleted = true;
            }
          }
        } else {
          const encoded = encodeField(field, input.value, state.codec);
          rec.data.set(encoded, field.offset);
        }
        markDirty(true);
        td.classList.remove("editing");
        renderAll();
      } catch (e) {
        toast(e.message);
        input.focus();
      }
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
  }

  async function undoLast() {
    if (!state.undo) return;
    if (state.undo.kind === "sqlite") {
      const SQL = await ensureSqlJs();
      closeSql();
      const engine = new SQL.Database(state.undo.bytes);
      const table = state.undo.table;
      state.undo = null;
      bindSqlite(engine, state.filename, table, true);
      markDirty(true);
      renderAll();
      toast("Отменено");
      return;
    }
    state.db.fields = state.undo.fields;
    state.db.records = state.undo.records;
    state.db.extraHeader = state.undo.extraHeader;
    layoutFields(state.db.fields);
    state.undo = null;
    markDirty(true);
    renderAll();
    toast("Отменено");
  }

  $("btnOpen").onclick = pickFile;
  $("btnOpen2").onclick = pickFile;
  els.btnClose.onclick = () => showHome(false);
  $("btnDemo").onclick = openDemo;
  $("btnDemoSql").onclick = () => openDemoSql().catch((e) => toast(e.message || String(e)));
  els.file.onchange = () => {
    const f = els.file.files[0];
    if (f) openFromFile(f, null).catch((e) => toast("Не удалось открыть: " + errText(e)));
    els.file.value = "";
  };
  els.btnSave.onclick = () => saveReplace().catch((e) => toast("Сохранение: " + errText(e)));
  els.btnDownload.onclick = () => saveAs().catch((e) => toast("Сохранить как: " + errText(e)));
  els.btnAdd.onclick = addRecord;
  els.btnDel.onclick = () => toggleSelected(true);
  els.btnUndel.onclick = () => toggleSelected(false);
  els.btnPack.onclick = pack;
  els.btnUndo.onclick = () => undoLast().catch((e) => toast(e.message || String(e)));
  els.btnStruct.onclick = () => els.side.classList.toggle("open");
  $("btnCloseSide").onclick = () => els.side.classList.remove("open");
  els.tableSel.onchange = () => {
    if (!isSql()) return;
    reloadSqlTable(els.tableSel.value);
    state.undo = null;
    renderAll();
  };
  els.enc.onchange = () => {
    if (isSql()) return;
    state.encoding = els.enc.value;
    state.codec = makeCodec(state.encoding);
    refreshFieldNames(state.db, state.codec);
    markDirty(true);
    renderAll();
  };
  els.search.oninput = () => {
    state.filter = els.search.value;
    state.selected = new Set();
    renderAll();
  };
  els.showDel.onchange = () => {
    state.showDeleted = els.showDel.checked;
    renderAll();
  };

  els.fieldList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-del-field]");
    if (btn) removeField(Number(btn.dataset.delField));
  });

  els.head.addEventListener("change", (e) => {
    if (e.target.id === "chkAll") {
      if (e.target.checked) state.view.forEach((i) => state.selected.add(i));
      else state.view.forEach((i) => state.selected.delete(i));
      renderBody();
      renderHead();
    }
  });

  els.body.addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-ri]");
    if (!tr) return;
    const ri = Number(tr.dataset.ri);
    if (e.target.classList.contains("flag")) {
      snapshot("пометка");
      const rec = records()[ri];
      if (isSql()) rec.deleted = !rec.deleted;
      else setDeleted(rec, !rec.deleted);
      markDirty(true);
      renderAll();
      return;
    }
    const td = e.target.closest("td.val");
    if (td) startEdit(td, ri, Number(td.dataset.fi));
  });
  els.body.addEventListener("change", (e) => {
    const tr = e.target.closest("tr[data-ri]");
    if (!tr || e.target.type !== "checkbox") return;
    const ri = Number(tr.dataset.ri);
    if (e.target.checked) state.selected.add(ri); else state.selected.delete(ri);
    tr.classList.toggle("sel", e.target.checked);
  });

  els.bodyScroll.addEventListener("scroll", () => {
    els.headScroll.scrollLeft = els.bodyScroll.scrollLeft;
    renderBody();
  });

  const drop = els.drop;
  ["dragenter", "dragover"].forEach((ev) => {
    document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
  });
  document.addEventListener("dragleave", (e) => {
    if (e.target === document.documentElement) drop.classList.remove("over");
  });
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const f = e.dataTransfer.files[0];
    if (f) openFromFile(f, null);
  });

  window.addEventListener("beforeunload", (e) => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
  });
  window.addEventListener("resize", () => { if (openOk()) renderBody(); });

  const params = new URLSearchParams(location.search);
  if (params.get("demo") === "sqlite") openDemoSql().catch((e) => toast(e.message || String(e)));
  else if (params.has("demo")) openDemo();
})();
