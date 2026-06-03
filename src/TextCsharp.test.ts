import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextCsharp from "./TextCsharp.ts";

const metadata = {
    mimetype: "text/x-csharp",
    glyph: "#️⃣",
    extensions: [".cs"] as const,
};

describe("TextCsharp — instantiation", () => {
    it("instantiates with metadata", () => {
        const h = new TextCsharp(metadata);
        assert.equal(h.mimetype, "text/x-csharp");
        assert.equal(h.glyph, "#️⃣");
    });
});

describe("TextCsharp — extract", () => {
    it("extracts a namespace, class, and methods with parameters", () => {
        const h = new TextCsharp(metadata);
        const src = [
            "namespace Plurnk.Parsers {",
            "    public class Parser {",
            "        public int Version;",
            "        public string Name { get; set; }",
            "",
            "        public Parser(string name) {",
            "            Name = name;",
            "        }",
            "",
            "        public string Parse(string source) {",
            "            return source;",
            "        }",
            "",
            "        public void Load(string path, bool strict) {",
            "        }",
            "    }",
            "}",
        ].join("\n");
        const syms = h.extractRaw(src);

        const ns = syms.find((s) => s.name === "Plurnk.Parsers" && s.kind === "module");
        assert.ok(ns, "namespace surfaces as module");

        const cls = syms.find((s) => s.name === "Parser" && s.kind === "class");
        assert.ok(cls);

        const ctor = syms.find((s) => s.name === "Parser" && s.kind === "method");
        assert.ok(ctor);
        assert.deepEqual(ctor.params, ["name"]);

        const parse = syms.find((s) => s.name === "Parse");
        assert.ok(parse);
        assert.equal(parse.kind, "method");
        assert.deepEqual(parse.params, ["source"]);

        const load = syms.find((s) => s.name === "Load");
        assert.ok(load);
        assert.equal(load.kind, "method");
        assert.deepEqual(load.params, ["path", "strict"]);

        const ver = syms.find((s) => s.name === "Version");
        assert.ok(ver);
        assert.equal(ver.kind, "field");

        const name = syms.find((s) => s.name === "Name");
        assert.ok(name, "property surfaces as field");
        assert.equal(name.kind, "field");
    });

    it("extracts structs as class kind", () => {
        const h = new TextCsharp(metadata);
        const src = [
            "public struct Point {",
            "    public int X;",
            "    public int Y;",
            "}",
        ].join("\n");
        const syms = h.extractRaw(src);
        const pt = syms.find((s) => s.name === "Point");
        assert.ok(pt);
        assert.equal(pt.kind, "class");
    });

    it("extracts interfaces and their abstract members", () => {
        const h = new TextCsharp(metadata);
        const src = [
            "public interface ICodec {",
            "    string Encode(string input);",
            "    int Version { get; }",
            "}",
        ].join("\n");
        const syms = h.extractRaw(src);
        const t = syms.find((s) => s.name === "ICodec" && s.kind === "interface");
        assert.ok(t);
        const encode = syms.find((s) => s.name === "Encode");
        assert.ok(encode);
        assert.equal(encode.kind, "method");
        assert.deepEqual(encode.params, ["input"]);
        const ver = syms.find((s) => s.name === "Version");
        assert.ok(ver);
        assert.equal(ver.kind, "field");
    });

    it("extracts enums", () => {
        const h = new TextCsharp(metadata);
        const src = [
            "public enum Color {",
            "    Red,",
            "    Green,",
            "    Blue",
            "}",
        ].join("\n");
        const syms = h.extractRaw(src);
        const c = syms.find((s) => s.name === "Color");
        assert.ok(c);
        assert.equal(c.kind, "enum");
    });

    it("extracts delegates as function kind", () => {
        const h = new TextCsharp(metadata);
        const src = "public delegate int Comparer(string a, string b);";
        const syms = h.extractRaw(src);
        const c = syms.find((s) => s.name === "Comparer");
        assert.ok(c);
        assert.equal(c.kind, "function");
        assert.deepEqual(c.params, ["a", "b"]);
    });

    it("extracts constants and field constants", () => {
        const h = new TextCsharp(metadata);
        const src = [
            "public class Config {",
            "    public const int MaxRetries = 3;",
            "    public const string DefaultName = \"plurnk\";",
            "    public int retryCount;",
            "}",
        ].join("\n");
        const syms = h.extractRaw(src);
        const m = syms.find((s) => s.name === "MaxRetries");
        assert.ok(m);
        assert.equal(m.kind, "constant");
        const d = syms.find((s) => s.name === "DefaultName");
        assert.ok(d);
        assert.equal(d.kind, "constant");
        const r = syms.find((s) => s.name === "retryCount");
        assert.ok(r);
        assert.equal(r.kind, "field");
    });

    it("excludes using directives (SPEC §3)", () => {
        const h = new TextCsharp(metadata);
        const src = [
            "using System;",
            "using System.Collections.Generic;",
            "",
            "public class Empty {}",
        ].join("\n");
        const syms = h.extractRaw(src);
        const names = syms.map((s) => s.name);
        // No System/Collections leaking in
        assert.ok(!names.includes("System"));
        assert.ok(!names.includes("System.Collections.Generic"));
        assert.ok(names.includes("Empty"));
    });

    it("excludes local variables inside method bodies (gateBody)", () => {
        const h = new TextCsharp(metadata);
        const src = [
            "public class C {",
            "    public int Compute() {",
            "        int x = 1;",
            "        int y = 2;",
            "        const int LOCAL_CONST = 42;",
            "        return x + y;",
            "    }",
            "}",
        ].join("\n");
        const syms = h.extractRaw(src);
        const names = syms.map((s) => s.name);
        assert.deepEqual(names.toSorted(), ["C", "Compute"]);
    });

    it("returns empty array for empty input", () => {
        const h = new TextCsharp(metadata);
        assert.deepEqual(h.extractRaw(""), []);
    });

    it("does not throw on malformed source (graceful)", () => {
        const h = new TextCsharp(metadata);
        assert.doesNotThrow(() => h.extractRaw("class { broken"));
        assert.doesNotThrow(() => h.extractRaw("@@ totally bogus"));
    });
});

describe("TextCsharp — framework integration", () => {
    it("renders extracted hierarchy via format()", async () => {
        const h = new TextCsharp(metadata);
        const out = await h.symbolsRaw("public class C { public void Answer() {} }");
        assert.ok(out.includes("class C"));
        assert.ok(out.includes("method Answer"));
    });

    it("jsonpath dispatches against the deep-json ANTLR parse tree (issue #10)", async () => {
        // Every ANTLR deep tree has a root with a `type` field — verify
        // jsonpath reaches it via the deep-channel dispatch.
        const h = new TextCsharp(metadata);
        const roots = await h.query("class Probe {}", "jsonpath", "$.type");
        assert.equal(roots.length, 1);
        assert.equal(typeof roots[0].matched, "string");
    });
});

// Real-world smoke against a representative C# file. Shape adapted from a
// generic Dictionary<TKey, TValue>-style implementation — the kind of code
// agents see in everyday .NET traffic.
describe("TextCsharp — real-world smoke (Dictionary-ish shape)", () => {
    const SRC = [
        "using System;",
        "using System.Collections.Generic;",
        "",
        "namespace Plurnk.Collections {",
        "    public interface IStorage<TKey, TValue> {",
        "        TValue Get(TKey key);",
        "        void Put(TKey key, TValue value);",
        "        int Count { get; }",
        "    }",
        "",
        "    public class Dictionary<TKey, TValue> : IStorage<TKey, TValue> {",
        "        private const int DefaultCapacity = 16;",
        "        private TKey[] keys;",
        "        private TValue[] values;",
        "        private int count;",
        "",
        "        public Dictionary() {",
        "            keys = new TKey[DefaultCapacity];",
        "            values = new TValue[DefaultCapacity];",
        "            count = 0;",
        "        }",
        "",
        "        public Dictionary(int capacity) {",
        "            keys = new TKey[capacity];",
        "            values = new TValue[capacity];",
        "            count = 0;",
        "        }",
        "",
        "        public int Count { get { return count; } }",
        "",
        "        public TValue Get(TKey key) {",
        "            return default(TValue);",
        "        }",
        "",
        "        public void Put(TKey key, TValue value) {",
        "        }",
        "    }",
        "",
        "    public enum LookupStrategy {",
        "        Linear,",
        "        Hash,",
        "        Tree",
        "    }",
        "}",
    ].join("\n");

    it("surfaces namespace, interface, class, methods, properties, fields, constants, enum", () => {
        const h = new TextCsharp(metadata);
        const syms = h.extractRaw(SRC);
        const names = new Set(syms.map((s) => s.name));

        assert.ok(names.has("Plurnk.Collections"));
        assert.ok(names.has("IStorage"));
        assert.ok(names.has("Dictionary"));
        assert.ok(names.has("LookupStrategy"));

        // Members
        assert.ok(names.has("DefaultCapacity"));
        assert.ok(names.has("keys"));
        assert.ok(names.has("values"));
        assert.ok(names.has("count"));
        assert.ok(names.has("Count"));
        assert.ok(names.has("Get"));
        assert.ok(names.has("Put"));
    });

    it("kind discrimination across the file", () => {
        const h = new TextCsharp(metadata);
        const syms = h.extractRaw(SRC);
        const byNameKind = new Map(syms.map((s) => [`${s.name}:${s.kind}`, s]));
        assert.ok(byNameKind.has("Plurnk.Collections:module"));
        assert.ok(byNameKind.has("IStorage:interface"));
        assert.ok(byNameKind.has("Dictionary:class"));
        assert.ok(byNameKind.has("LookupStrategy:enum"));
        assert.ok(byNameKind.has("Get:method"));
        assert.ok(byNameKind.has("Count:field"));
        assert.ok(byNameKind.has("DefaultCapacity:constant"));
    });
});
