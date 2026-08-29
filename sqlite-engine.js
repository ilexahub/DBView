/* SQLite format 3 helpers. Needs sql.js Database instance. Attaches to globalThis.SQLITE */
(function (root) {
  const MAGIC = "SQLite format 3";

  function isSqlite(buffer) {
    const b = new Uint8Array(buffer);
    if (b.length < 100) return false;
    for (let i = 0; i < 15; i++) {
      if (b[i] !== MAGIC.charCodeAt(i)) return false;
    }
    return b[15] === 0;
  }

  function headerInfo(buffer) {
    const b = new Uint8Array(buffer);
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let pageSize = view.getUint16(16, false);
    if (pageSize === 1) pageSize = 65536;
    const pageCount = view.getUint32(28, false);
    const freelist = view.getUint32(36, false);
    const textEnc = view.getUint32(56, false);
    const userVersion = view.getUint32(60, false);
    const sqliteVersion = view.getUint32(96, false);
    const encName = textEnc === 1 ? "UTF-8" : textEnc === 2 ? "UTF-16le" : textEnc === 3 ? "UTF-16be" : "?";
    return {
      pageSize,
      pageCount,
      freelist,
      textEnc,
      encName,
      userVersion,
      sqliteVersion,
      fileSize: b.length
    };
  }

  function qId(name) {
    return '"' + String(name).replace(/"/g, '""') + '"';
  }

  function exec1(db, sql) {
    const r = db.exec(sql);
    if (!r.length || !r[0].values.length) return null;
    return r[0].values[0][0];
  }

  function pragmas(db) {
    const pageSize = Number(exec1(db, "PRAGMA page_size")) || 4096;
    const pageCount = Number(exec1(db, "PRAGMA page_count")) || 0;
    const freelist = Number(exec1(db, "PRAGMA freelist_count")) || 0;
    const encoding = String(exec1(db, "PRAGMA encoding") || "UTF-8");
    const userVersion = Number(exec1(db, "PRAGMA user_version")) || 0;
    const version = String(exec1(db, "SELECT sqlite_version()") || "");
    return {
      pageSize,
      pageCount,
      freelist,
      encoding,
      userVersion,
      version,
      fileSize: pageCount * pageSize,
      freeBytes: freelist * pageSize
    };
  }

  function listTables(db) {
    const r = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name COLLATE NOCASE"
    );
    if (!r.length) return [];
    return r[0].values.map((v) => v[0]);
  }

  function tableMeta(db, table) {
    const info = db.exec("PRAGMA table_info(" + qId(table) + ")");
    const fields = [];
    if (info.length) {
      for (const row of info[0].values) {
        fields.push({
          name: row[1],
          type: row[2] || "BLOB",
          notnull: !!row[3],
          dflt: row[4],
          pk: row[5] | 0,
          length: 0,
          decimal: 0
        });
      }
    }
    let withoutRowid = false;
    try {
      const list = db.exec("PRAGMA table_list");
      if (list.length) {
        const cols = list[0].columns;
        const nameIdx = cols.indexOf("name");
        const wrIdx = cols.indexOf("wr");
        for (const row of list[0].values) {
          if (row[nameIdx] === table) withoutRowid = !!row[wrIdx];
        }
      }
    } catch (_) { /* older sqlite */ }
    return { fields, withoutRowid };
  }

  function loadRecords(db, table, fields, withoutRowid) {
    if (!fields.length) return [];
    const cols = fields.map((f) => qId(f.name)).join(", ");
    const sql = withoutRowid
      ? "SELECT " + cols + " FROM " + qId(table)
      : "SELECT rowid AS _editor_rowid, " + cols + " FROM " + qId(table);
    const stmt = db.prepare(sql);
    const records = [];
    while (stmt.step()) {
      const obj = stmt.getAsObject();
      const values = fields.map((f) => obj[f.name]);
      records.push({
        deleted: false,
        rowid: withoutRowid ? null : obj._editor_rowid,
        pk: withoutRowid
          ? Object.fromEntries(fields.filter((f) => f.pk).map((f) => [f.name, obj[f.name]]))
          : null,
        values
      });
    }
    stmt.free();
    return records;
  }

  function shortType(type) {
    const t = String(type || "").toUpperCase();
    if (!t) return "?";
    if (t.includes("INT")) return "INT";
    if (t.includes("CHAR") || t.includes("CLOB") || t.includes("TEXT")) return "TEXT";
    if (t.includes("BLOB") || t === "") return "BLOB";
    if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB")) return "REAL";
    if (t.includes("NUM") || t.includes("DEC") || t.includes("BOOL") || t.includes("DATE")) return "NUM";
    return t.slice(0, 8);
  }

  function isBlobValue(v) {
    return v instanceof Uint8Array;
  }

  function displayValue(v) {
    if (v == null) return { text: "NULL", nullish: true, blob: false };
    if (isBlobValue(v)) return { text: "BLOB " + v.length + " Б", nullish: false, blob: true };
    if (typeof v === "bigint") return { text: String(v), nullish: false, blob: false };
    return { text: String(v), nullish: false, blob: false };
  }

  function bindValue(field, text) {
    const s = text == null ? "" : String(text);
    const t = String(field.type || "").toUpperCase();
    const isText = t.includes("TEXT") || t.includes("CHAR") || t.includes("CLOB") || t.includes("DATE") || t.includes("TIME");
    if (s.toUpperCase() === "NULL") return null;
    if (s === "") return isText ? "" : null;
    if (t.includes("BLOB") && !isText) throw new Error("BLOB в этом редакторе не правится");
    if ((t.includes("INT") && !t.includes("POINT")) || t.includes("BOOL")) {
      const n = Number(s.replace(",", "."));
      if (!Number.isFinite(n)) throw new Error("Не целое: " + text);
      return Math.trunc(n);
    }
    if (t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB") || t.includes("NUM") || t.includes("DEC")) {
      const n = Number(s.replace(",", "."));
      if (!Number.isFinite(n)) throw new Error("Не число: " + text);
      return n;
    }
    return s;
  }

  function whereRow(rec, withoutRowid, fields) {
    if (!withoutRowid) {
      if (rec.rowid == null) throw new Error("У строки нет rowid");
      return { sql: "rowid = ?", params: [rec.rowid] };
    }
    const pk = fields.filter((f) => f.pk);
    if (!pk.length) throw new Error("Таблица WITHOUT ROWID без PRIMARY KEY");
    return {
      sql: pk.map((f) => qId(f.name) + " = ?").join(" AND "),
      params: pk.map((f) => rec.pk[f.name])
    };
  }

  function updateCell(db, table, rec, field, text, withoutRowid, fields) {
    const val = bindValue(field, text);
    const w = whereRow(rec, withoutRowid, fields);
    db.run(
      "UPDATE " + qId(table) + " SET " + qId(field.name) + " = ? WHERE " + w.sql,
      [val].concat(w.params)
    );
  }

  function deleteMarked(db, table, records, withoutRowid, fields) {
    const marked = records.filter((r) => r.deleted);
    if (!marked.length) return 0;
    db.run("BEGIN");
    try {
      for (const rec of marked) {
        const w = whereRow(rec, withoutRowid, fields);
        db.run("DELETE FROM " + qId(table) + " WHERE " + w.sql, w.params);
      }
      db.run("COMMIT");
    } catch (e) {
      try { db.run("ROLLBACK"); } catch (_) { /* ignore */ }
      throw e;
    }
    return marked.length;
  }

  function dropColumn(db, table, col) {
    db.run("ALTER TABLE " + qId(table) + " DROP COLUMN " + qId(col));
  }

  function addRow(db, table, fields) {
    try {
      db.run("INSERT INTO " + qId(table) + " DEFAULT VALUES");
      return;
    } catch (_) { /* NOT NULL without default */ }
    const names = fields.map((f) => qId(f.name)).join(", ");
    const qs = fields.map(() => "?").join(", ");
    const vals = fields.map((f) => {
      const t = String(f.type || "").toUpperCase();
      if (f.pk && t.includes("INT")) return null;
      if (f.notnull && f.dflt == null) {
        if (t.includes("INT") || t.includes("REAL") || t.includes("FLOA") || t.includes("DOUB") || t.includes("NUM")) return 0;
        return "";
      }
      return null;
    });
    db.run("INSERT INTO " + qId(table) + " (" + names + ") VALUES (" + qs + ")", vals);
  }

  function vacuum(db) {
    db.run("VACUUM");
  }

  function createDemo(SQL) {
    const db = new SQL.Database();
    db.run(`CREATE TABLE people (
      name TEXT NOT NULL,
      city TEXT,
      born TEXT,
      summa REAL,
      ok INTEGER
    )`);
    db.run(`CREATE TABLE notes (
      id INTEGER PRIMARY KEY,
      title TEXT,
      body TEXT
    )`);
    const people = [
      ["Иванов", "Казань", "1980-03-12", 1200.5, 1],
      ["Петрова", "Москва", "1991-11-02", 0, 0],
      ["Сидоров", "Томск", "1975-07-22", 880, 1],
      ["Кузнецов", "Омск", "1988-01-30", 15.4, 1]
    ];
    for (const row of people) {
      db.run("INSERT INTO people (name, city, born, summa, ok) VALUES (?,?,?,?,?)", row);
    }
    db.run("INSERT INTO notes (title, body) VALUES (?, ?)", ["Черновик", "удали меня"]);
    db.run("INSERT INTO notes (title, body) VALUES (?, ?)", ["Важно", "VACUUM пересобирает файл и забирает свободные страницы"]);
    db.run("DELETE FROM people WHERE name = ?", ["Петрова"]);
    db.run("DELETE FROM notes WHERE title = ?", ["Черновик"]);
    db.run("CREATE TABLE _waste(x TEXT)");
    db.run("INSERT INTO _waste VALUES (?)", ["#".repeat(8000)]);
    db.run("INSERT INTO _waste VALUES (?)", ["#".repeat(8000)]);
    db.run("DROP TABLE _waste");
    return db;
  }

  function attachTable(db, table) {
    const meta = tableMeta(db, table);
    const records = loadRecords(db, table, meta.fields, meta.withoutRowid);
    const info = pragmas(db);
    return {
      table,
      fields: meta.fields,
      withoutRowid: meta.withoutRowid,
      records,
      info,
      tables: listTables(db)
    };
  }

  root.SQLITE = {
    isSqlite,
    headerInfo,
    qId,
    pragmas,
    listTables,
    tableMeta,
    loadRecords,
    shortType,
    isBlobValue,
    displayValue,
    bindValue,
    updateCell,
    deleteMarked,
    dropColumn,
    addRow,
    vacuum,
    createDemo,
    attachTable
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
