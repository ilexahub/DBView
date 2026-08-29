/* DBF parse / serialize — no DOM. Attaches to globalThis.DBF */
(function (root) {
  const VERSIONS = {
    0x02: "FoxBASE",
    0x03: "dBase III",
    0x04: "dBase IV",
    0x05: "dBase 5",
    0x30: "Visual FoxPro",
    0x31: "Visual FoxPro (autoinc)",
    0x32: "Visual FoxPro (varchar)",
    0x43: "dBase IV SQL",
    0x7B: "dBase IV memo",
    0x83: "dBase III + memo",
    0x8B: "dBase IV + memo",
    0x8E: "dBase IV SQL + memo",
    0xF5: "FoxPro 2 + memo",
    0xFB: "FoxBASE"
  };
  const LD_ENC = {
    0x01: "ibm437", 0x03: "windows-1252", 0x26: "ibm866", 0x66: "ibm866",
    0x57: "windows-1252", 0xC8: "windows-1252", 0xC9: "windows-1251"
  };
  const ENC_LD = {
    ibm866: 0x26, "windows-1251": 0xC9, "windows-1252": 0x03,
    ibm437: 0x01, "iso-8859-1": 0x03, "utf-8": 0x00
  };

  function ascii(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function versionName(v) {
    return VERSIONS[v] || "версия 0x" + v.toString(16).toUpperCase();
  }

  function makeCodec(label) {
    let dec;
    try { dec = new TextDecoder(label); }
    catch { dec = new TextDecoder("ibm866"); label = "ibm866"; }
    const chars = [];
    for (let i = 0; i < 256; i++) chars[i] = dec.decode(Uint8Array.of(i));
    const map = new Map();
    for (let i = 0; i < 256; i++) {
      if (!map.has(chars[i])) map.set(chars[i], i);
    }
    return {
      label,
      decode(bytes) {
        let s = "";
        for (let i = 0; i < bytes.length; i++) s += chars[bytes[i]];
        return s;
      },
      encodeChar(ch) {
        if (map.has(ch)) return map.get(ch);
        const code = ch.charCodeAt(0);
        if (code < 128) return code;
        return 0x3F;
      }
    };
  }

  function fieldNameFromRaw(raw, codec) {
    let nEnd = 0;
    while (nEnd < 11 && raw[nEnd] !== 0) nEnd++;
    const bytes = raw.subarray(0, nEnd);
    if (codec) return codec.decode(bytes).replace(/[\s\0]+$/g, "");
    return ascii(bytes).trim();
  }

  function layoutFields(fields) {
    let off = 1;
    for (const f of fields) {
      f.offset = off;
      off += f.length;
    }
    return off;
  }

  function parseDbf(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 33) throw new Error("Файл слишком короткий, это не DBF.");
    const view = new DataView(buffer instanceof ArrayBuffer ? buffer : bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = bytes[0];
    const yy = bytes[1], mm = bytes[2], dd = bytes[3];
    const recCountHdr = view.getUint32(4, true);
    const headerLength = view.getUint16(8, true);
    const recordLength = view.getUint16(10, true);
    if (headerLength < 33 || headerLength > bytes.length) throw new Error("Повреждён заголовок (header length).");
    if (recordLength < 1) throw new Error("Нулевая длина записи.");

    const fields = [];
    let off = 32;
    while (off + 32 <= headerLength && bytes[off] !== 0x0D && bytes[off] !== 0x00) {
      const type = String.fromCharCode(bytes[off + 11] || 0x3F);
      const length = bytes[off + 16];
      const decimal = bytes[off + 17];
      if (!length && type !== "C") break;
      const raw = bytes.slice(off, off + 32);
      fields.push({
        name: fieldNameFromRaw(raw, null) || ("FIELD" + (fields.length + 1)),
        type,
        length: length || 1,
        decimal,
        raw
      });
      off += 32;
      if (fields.length > 1024) throw new Error("Слишком много полей.");
    }
    if (!fields.length) throw new Error("В заголовке нет ни одного поля.");

    const term = 32 + fields.length * 32;
    const extraHeader = bytes.slice(Math.min(term + 1, headerLength), headerLength);
    const headerMeta = bytes.slice(12, 32);

    const maxRec = Math.max(0, Math.floor((bytes.length - headerLength) / recordLength));
    const count = Math.min(recCountHdr, maxRec);
    const records = [];
    for (let i = 0; i < count; i++) {
      const start = headerLength + i * recordLength;
      records.push({
        deleted: bytes[start] === 0x2A,
        data: bytes.slice(start, start + recordLength)
      });
    }

    const recOff = layoutFields(fields);
    if (recOff > recordLength) {
      throw new Error("Сумма длин полей больше длины записи. Файл повреждён или это не классический DBF.");
    }

    return {
      version,
      yy, mm, dd,
      languageDriver: bytes[29],
      headerMeta,
      extraHeader,
      fields,
      records,
      recordLength,
      originalSize: bytes.length,
      recCountHdr,
      maxRec,
      headerLength
    };
  }

  function refreshFieldNames(db, codec) {
    for (const f of db.fields) {
      if (f.raw) f.name = fieldNameFromRaw(f.raw, codec) || f.name;
    }
  }

  function encodeField(field, text, codec) {
    const out = new Uint8Array(field.length);
    out.fill(0x20);
    const putAscii = (s, alignRight) => {
      const b = [];
      for (const ch of s) b.push(codec.encodeChar(ch));
      if (b.length > field.length) {
        out.fill(0x2A);
        return;
      }
      const start = alignRight ? field.length - b.length : 0;
      for (let i = 0; i < b.length; i++) out[start + i] = b[i];
    };
    switch (field.type) {
      case "N":
      case "F": {
        let s = String(text).trim().replace(",", ".");
        if (!s) return out;
        const n = Number(s);
        if (!Number.isFinite(n)) throw new Error("Не число: " + text);
        s = field.decimal > 0 ? n.toFixed(field.decimal) : String(Math.round(n));
        putAscii(s, true);
        return out;
      }
      case "D": {
        const s = String(text).trim().replace(/[./]/g, "-");
        if (!s) return out;
        let ymd = s.replace(/-/g, "");
        if (!/^\d{8}$/.test(ymd)) throw new Error("Дата нужна в виде ГГГГ-ММ-ДД");
        putAscii(ymd, false);
        return out;
      }
      case "L": {
        const v = String(text).trim().toUpperCase();
        let ch = " ";
        if (["T", "Y", "1", "TRUE", "ДА", "ИСТИНА", "+"].includes(v)) ch = "T";
        else if (["F", "N", "0", "FALSE", "НЕТ", "ЛОЖЬ", "-"].includes(v)) ch = "F";
        else if (v) ch = v[0];
        out[0] = ch.charCodeAt(0);
        return out;
      }
      case "I": {
        const n = Number(String(text).trim() || "0");
        if (!Number.isFinite(n)) throw new Error("Не целое");
        new DataView(out.buffer).setInt32(0, n | 0, true);
        return out;
      }
      default: {
        putAscii(String(text), false);
        return out;
      }
    }
  }

  function decodeField(field, rec, codec) {
    const bytes = rec.data.subarray(field.offset, field.offset + field.length);
    switch (field.type) {
      case "C":
      case "V":
      case "W":
        return codec.decode(bytes).replace(/[\s\0]+$/g, "");
      case "N":
      case "F":
        return ascii(bytes).trim();
      case "D": {
        const s = ascii(bytes);
        if (!s.trim() || /^0+$/.test(s.trim()) || /^[\s*]+$/.test(s)) return "";
        if (/^\d{8}$/.test(s)) return s.slice(0, 4) + "-" + s.slice(4, 6) + "-" + s.slice(6, 8);
        return s.trim();
      }
      case "L": {
        const c = String.fromCharCode(bytes[0] || 32).toUpperCase();
        if ("TY".includes(c)) return "T";
        if ("FN".includes(c)) return "F";
        return "";
      }
      case "I": {
        if (bytes.length < 4) return ascii(bytes).trim();
        return String(new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, true));
      }
      case "M":
      case "G":
      case "P":
        return ascii(bytes).trim();
      case "B":
        if (bytes.length === 8) {
          return String(new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true));
        }
        return ascii(bytes).trim();
      default:
        return codec.decode(bytes).replace(/[\s\0]+$/g, "");
    }
  }

  function serializeDbf(db, encoding) {
    const codec = makeCodec(encoding || "ibm866");
    const fields = db.fields;
    const recordLength = layoutFields(fields);
    const extra = db.extraHeader || new Uint8Array(0);
    const headerLength = 32 + fields.length * 32 + 1 + extra.length;
    const n = db.records.length;
    const out = new Uint8Array(headerLength + n * recordLength + 1);
    const view = new DataView(out.buffer);

    let version = db.version || 0x03;
    const memo = fields.some((f) => "MGP".includes(f.type));
    if (!memo && version === 0x83) version = 0x03;
    if (!memo && version === 0x8B) version = 0x04;
    out[0] = version;

    const now = new Date();
    out[1] = now.getFullYear() - 1900;
    out[2] = now.getMonth() + 1;
    out[3] = now.getDate();
    view.setUint32(4, n, true);
    view.setUint16(8, headerLength, true);
    view.setUint16(10, recordLength, true);
    if (db.headerMeta && db.headerMeta.length >= 20) out.set(db.headerMeta, 12);
    out[28] = out[28] & ~0x01;
    out[29] = ENC_LD[encoding] ?? db.languageDriver ?? 0x26;

    let p = 32;
    let disp = 1;
    for (const f of fields) {
      const raw = new Uint8Array(32);
      if (f.raw) raw.set(f.raw.subarray(0, 32));
      raw.fill(0, 0, 11);
      const name = String(f.name).toUpperCase().slice(0, 10);
      for (let i = 0; i < name.length; i++) raw[i] = codec.encodeChar(name[i]);
      raw[11] = f.type.charCodeAt(0);
      new DataView(raw.buffer).setUint32(12, disp, true);
      raw[16] = f.length & 0xFF;
      raw[17] = f.decimal & 0xFF;
      out.set(raw, p);
      p += 32;
      disp += f.length;
    }
    out[p] = 0x0D;
    if (extra.length) out.set(extra, p + 1);

    let ro = headerLength;
    for (const rec of db.records) {
      const row = new Uint8Array(recordLength);
      row.fill(0x20);
      const copy = Math.min(rec.data.length, recordLength);
      row.set(rec.data.subarray(0, copy));
      row[0] = rec.deleted ? 0x2A : 0x20;
      out.set(row, ro);
      ro += recordLength;
    }
    out[ro] = 0x1A;
    return out;
  }

  function estimatedSize(db) {
    const recLen = 1 + db.fields.reduce((s, f) => s + f.length, 0);
    const hdr = 32 + db.fields.length * 32 + 1 + (db.extraHeader ? db.extraHeader.length : 0);
    return hdr + db.records.length * recLen + 1;
  }

  function setDeleted(rec, flag) {
    rec.deleted = flag;
    rec.data[0] = flag ? 0x2A : 0x20;
  }

  function packRecords(db) {
    const removed = db.records.filter((r) => r.deleted).length;
    db.records = db.records.filter((r) => !r.deleted);
    return removed;
  }

  function deleteField(db, index) {
    if (index < 0 || index >= db.fields.length || db.fields.length <= 1) {
      throw new Error("Нельзя удалить последнее поле");
    }
    const keep = db.fields.filter((_, i) => i !== index);
    const newLen = 1 + keep.reduce((s, x) => s + x.length, 0);
    db.records = db.records.map((rec) => {
      const data = new Uint8Array(newLen);
      data.fill(0x20);
      data[0] = rec.data[0];
      let w = 1;
      db.fields.forEach((field, i) => {
        if (i === index) return;
        data.set(rec.data.subarray(field.offset, field.offset + field.length), w);
        w += field.length;
      });
      return { deleted: rec.deleted, data };
    });
    const removed = db.fields[index];
    db.fields = keep;
    layoutFields(db.fields);
    return removed;
  }

  function addBlankRecord(db) {
    const len = 1 + db.fields.reduce((s, f) => s + f.length, 0);
    const data = new Uint8Array(len);
    data.fill(0x20);
    db.records.push({ deleted: false, data });
  }

  function buildDemo(codec) {
    const c = codec || makeCodec("ibm866");
    const fields = [
      { name: "NAME", type: "C", length: 18, decimal: 0 },
      { name: "CITY", type: "C", length: 14, decimal: 0 },
      { name: "BORN", type: "D", length: 8, decimal: 0 },
      { name: "SUMMA", type: "N", length: 10, decimal: 2 },
      { name: "OK", type: "L", length: 1, decimal: 0 }
    ];
    layoutFields(fields);
    const recLen = 1 + fields.reduce((s, f) => s + f.length, 0);
    const rows = [
      ["Иванов", "Казань", "1980-03-12", "1200.50", "T"],
      ["Петрова", "Москва", "1991-11-02", "0.00", "F"],
      ["Сидоров", "Томск", "1975-07-22", "880.00", "T"],
      ["Кузнецов", "Омск", "1988-01-30", "15.40", "T"]
    ];
    const records = rows.map((vals, idx) => {
      const data = new Uint8Array(recLen);
      data.fill(0x20);
      data[0] = idx === 1 ? 0x2A : 0x20;
      fields.forEach((f, i) => data.set(encodeField(f, vals[i], c), f.offset));
      return { deleted: idx === 1, data };
    });
    return {
      version: 0x03,
      yy: 126, mm: 8, dd: 28,
      languageDriver: 0x26,
      headerMeta: new Uint8Array(20),
      extraHeader: new Uint8Array(0),
      fields, records, recordLength: recLen,
      originalSize: 0, recCountHdr: records.length, maxRec: records.length
    };
  }

  root.DBF = {
    VERSIONS, LD_ENC, ENC_LD,
    ascii, versionName, makeCodec, fieldNameFromRaw, layoutFields,
    parseDbf, refreshFieldNames, encodeField, decodeField, serializeDbf,
    estimatedSize, setDeleted, packRecords, deleteField, addBlankRecord, buildDemo
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
