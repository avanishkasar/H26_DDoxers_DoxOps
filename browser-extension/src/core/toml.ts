// A minimal, tolerant TOML reader: enough for pyproject.toml dependency sections.
// It understands tables, arrays of tables, dotted keys, basic/literal (multi-line) strings,
// arrays, inline tables, booleans, numbers and dates (kept as raw strings).
// A malformed statement is recorded in `errors` and skipped up to the end of its line, so one
// bad line never hides the rest of the file.

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

export interface TomlResult {
  data: TomlTable;
  errors: string[];
}

class TomlError extends Error {}

export function parseToml(source: string): TomlResult {
  const p = new Parser(source.replace(/^﻿/, "").replace(/\r\n/g, "\n"));
  return p.parseDocument();
}

class Parser {
  private pos = 0;
  private readonly errors: string[] = [];

  constructor(private readonly s: string) {}

  parseDocument(): TomlResult {
    const root: TomlTable = {};
    let current: TomlTable = root;
    while (this.pos < this.s.length) {
      this.skipWhitespaceAndComments(true);
      if (this.pos >= this.s.length) break;
      const lineStart = this.pos;
      try {
        if (this.s[this.pos] === "[") {
          const isArray = this.s[this.pos + 1] === "[";
          this.pos += isArray ? 2 : 1;
          this.skipInlineWs();
          const path = this.parseKey();
          this.skipInlineWs();
          if (isArray) this.expect("]]");
          else this.expect("]");
          this.endOfLine();
          current = isArray ? this.appendArrayTable(root, path) : this.ensureTable(root, path);
        } else {
          const path = this.parseKey();
          this.skipInlineWs();
          this.expect("=");
          this.skipInlineWs();
          const value = this.parseValue();
          this.endOfLine();
          this.assign(current, path, value);
        }
      } catch (err) {
        const line = this.s.slice(0, lineStart).split("\n").length;
        this.errors.push(`line ${line}: ${err instanceof Error ? err.message : String(err)}`);
        this.pos = lineStart;
        this.skipToNextStatement();
      }
    }
    return { data: root, errors: this.errors };
  }

  /** After an error: skip to the next line that looks like a header or key at column 0. */
  private skipToNextStatement(): void {
    let nl = this.s.indexOf("\n", this.pos);
    while (nl >= 0) {
      const next = this.s[nl + 1];
      if (next === undefined) break;
      if (next === "[" || /[A-Za-z0-9_"'-]/.test(next)) {
        this.pos = nl + 1;
        return;
      }
      nl = this.s.indexOf("\n", nl + 1);
    }
    this.pos = this.s.length;
  }

  private ensureTable(root: TomlTable, path: string[]): TomlTable {
    let t = root;
    for (const key of path) {
      const existing = t[key];
      if (existing === undefined) {
        const next: TomlTable = {};
        t[key] = next;
        t = next;
      } else if (Array.isArray(existing)) {
        const last = existing[existing.length - 1];
        if (!isTable(last)) throw new TomlError(`key '${key}' is not a table`);
        t = last;
      } else if (isTable(existing)) {
        t = existing;
      } else {
        throw new TomlError(`key '${key}' is not a table`);
      }
    }
    return t;
  }

  private appendArrayTable(root: TomlTable, path: string[]): TomlTable {
    const parent = this.ensureTable(root, path.slice(0, -1));
    const key = path[path.length - 1]!;
    const existing = parent[key];
    const table: TomlTable = {};
    if (existing === undefined) parent[key] = [table];
    else if (Array.isArray(existing)) existing.push(table);
    else throw new TomlError(`key '${key}' is not an array of tables`);
    return table;
  }

  private assign(table: TomlTable, path: string[], value: TomlValue): void {
    const parent = path.length > 1 ? this.ensureTable(table, path.slice(0, -1)) : table;
    const key = path[path.length - 1]!;
    if (Object.prototype.hasOwnProperty.call(parent, key)) throw new TomlError(`duplicate key '${key}'`);
    parent[key] = value;
  }

  private parseKey(): string[] {
    const parts: string[] = [];
    for (;;) {
      this.skipInlineWs();
      const c = this.s[this.pos];
      if (c === '"') parts.push(this.parseBasicString());
      else if (c === "'") parts.push(this.parseLiteralString());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(this.s.slice(this.pos, this.pos + 256));
        if (!m) throw new TomlError("expected a key");
        parts.push(m[0]);
        this.pos += m[0].length;
      }
      this.skipInlineWs();
      if (this.s[this.pos] === ".") {
        this.pos++;
        continue;
      }
      return parts;
    }
  }

  private parseValue(): TomlValue {
    const c = this.s[this.pos];
    if (c === '"') return this.s.startsWith('"""', this.pos) ? this.parseMultilineBasic() : this.parseBasicString();
    if (c === "'") return this.s.startsWith("'''", this.pos) ? this.parseMultilineLiteral() : this.parseLiteralString();
    if (c === "[") return this.parseArray();
    if (c === "{") return this.parseInlineTable();
    const m = /^[^\s,\]}#]+/.exec(this.s.slice(this.pos, this.pos + 128));
    if (!m) throw new TomlError("expected a value");
    this.pos += m[0].length;
    const raw = m[0];
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (/^[+-]?(\d[\d_]*)(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(raw)) return Number(raw.replace(/_/g, ""));
    // Dates, times, hex/octal numbers, inf/nan: keep the raw text; nothing here needs them.
    if (/^[0-9+\-:.TZa-z_]+$/i.test(raw)) {
      // Local date-time with a space separator: "1979-05-27 07:32:00".
      const tail = /^ \d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})?/.exec(this.s.slice(this.pos, this.pos + 40));
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw) && tail) this.pos += tail[0].length;
      return raw;
    }
    throw new TomlError(`invalid value '${raw.slice(0, 40)}'`);
  }

  private parseArray(): TomlValue[] {
    this.expect("[");
    const out: TomlValue[] = [];
    for (;;) {
      this.skipWhitespaceAndComments(true);
      if (this.s[this.pos] === "]") {
        this.pos++;
        return out;
      }
      out.push(this.parseValue());
      this.skipWhitespaceAndComments(true);
      const c = this.s[this.pos];
      if (c === ",") {
        this.pos++;
        continue;
      }
      if (c === "]") {
        this.pos++;
        return out;
      }
      throw new TomlError("expected ',' or ']' in array");
    }
  }

  private parseInlineTable(): TomlTable {
    this.expect("{");
    const table: TomlTable = {};
    this.skipWhitespaceAndComments(true);
    if (this.s[this.pos] === "}") {
      this.pos++;
      return table;
    }
    for (;;) {
      this.skipWhitespaceAndComments(true);
      const path = this.parseKey();
      this.skipInlineWs();
      this.expect("=");
      this.skipInlineWs();
      this.assign(table, path, this.parseValue());
      this.skipWhitespaceAndComments(true);
      const c = this.s[this.pos];
      if (c === ",") {
        this.pos++;
        this.skipWhitespaceAndComments(true);
        if (this.s[this.pos] === "}") {
          this.pos++;
          return table;
        }
        continue;
      }
      if (c === "}") {
        this.pos++;
        return table;
      }
      throw new TomlError("expected ',' or '}' in inline table");
    }
  }

  private parseBasicString(): string {
    this.expect('"');
    let out = "";
    while (this.pos < this.s.length) {
      const c = this.s[this.pos]!;
      if (c === '"') {
        this.pos++;
        return out;
      }
      if (c === "\n") throw new TomlError("unterminated string");
      if (c === "\\") {
        out += this.parseEscape();
        continue;
      }
      out += c;
      this.pos++;
    }
    throw new TomlError("unterminated string");
  }

  private parseMultilineBasic(): string {
    this.expect('"""');
    if (this.s[this.pos] === "\n") this.pos++;
    let out = "";
    while (this.pos < this.s.length) {
      if (this.s.startsWith('"""', this.pos)) {
        // A run of 4 or 5 quotes: the first one or two belong to the content.
        let run = 0;
        while (this.s[this.pos + run] === '"' && run < 5) run++;
        out += '"'.repeat(run - 3);
        this.pos += run;
        return out;
      }
      const c = this.s[this.pos]!;
      if (c === "\\") {
        if (/^\\[ \t]*\n/.test(this.s.slice(this.pos, this.pos + 64))) {
          this.pos++;
          while (/[ \t\n]/.test(this.s[this.pos] ?? "")) this.pos++;
          continue;
        }
        out += this.parseEscape();
        continue;
      }
      out += c;
      this.pos++;
    }
    throw new TomlError("unterminated multi-line string");
  }

  private parseLiteralString(): string {
    this.expect("'");
    const end = this.s.indexOf("'", this.pos);
    const nl = this.s.indexOf("\n", this.pos);
    if (end < 0 || (nl >= 0 && nl < end)) throw new TomlError("unterminated literal string");
    const out = this.s.slice(this.pos, end);
    this.pos = end + 1;
    return out;
  }

  private parseMultilineLiteral(): string {
    this.expect("'''");
    if (this.s[this.pos] === "\n") this.pos++;
    const end = this.s.indexOf("'''", this.pos);
    if (end < 0) throw new TomlError("unterminated multi-line literal string");
    let close = end;
    while (this.s[close + 3] === "'" && close - end < 2) close++;
    const out = this.s.slice(this.pos, close);
    this.pos = close + 3;
    return out;
  }

  private parseEscape(): string {
    const e = this.s[this.pos + 1];
    this.pos += 2;
    switch (e) {
      case "b":
        return "\b";
      case "t":
        return "\t";
      case "n":
        return "\n";
      case "f":
        return "\f";
      case "r":
        return "\r";
      case "e":
        return "\u001b";
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "u":
      case "U": {
        const len = e === "u" ? 4 : 8;
        const hex = this.s.slice(this.pos, this.pos + len);
        if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len) throw new TomlError("invalid unicode escape");
        this.pos += len;
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff) throw new TomlError("invalid unicode escape");
        return String.fromCodePoint(cp);
      }
      default:
        throw new TomlError(`invalid escape '\\${e ?? ""}'`);
    }
  }

  private expect(token: string): void {
    if (!this.s.startsWith(token, this.pos)) throw new TomlError(`expected '${token}'`);
    this.pos += token.length;
  }

  private skipInlineWs(): void {
    while (this.s[this.pos] === " " || this.s[this.pos] === "\t") this.pos++;
  }

  private skipWhitespaceAndComments(newlines: boolean): void {
    while (this.pos < this.s.length) {
      const c = this.s[this.pos];
      if (c === " " || c === "\t" || (newlines && (c === "\n" || c === "\r"))) this.pos++;
      else if (c === "#") {
        const nl = this.s.indexOf("\n", this.pos);
        this.pos = nl < 0 ? this.s.length : nl;
      } else break;
    }
  }

  private endOfLine(): void {
    this.skipWhitespaceAndComments(false);
    if (this.pos < this.s.length && this.s[this.pos] !== "\n" && this.s[this.pos] !== "\r") {
      throw new TomlError("unexpected text after value");
    }
  }
}

export function isTable(v: unknown): v is TomlTable {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
