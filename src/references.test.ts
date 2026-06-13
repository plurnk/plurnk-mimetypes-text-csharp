import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextCsharp from "./TextCsharp.ts";
import type { MimeRef } from "@plurnk/plurnk-mimetypes";

const metadata = {
    mimetype: "text/x-csharp",
    glyph: "#️⃣",
    extensions: [".cs"] as const,
};

// Fixture exercising every applicable RefKind plus string/comment decoys.
// Decoy tokens (StringDecoy, CommentDecoy, BlockDecoy, and the fake calls/new
// inside them) must never surface as refs — the parser separates string and
// comment lexemes from identifier/type nodes, so leakage is impossible by
// construction; the decoys prove it.
const SRC = [
    "using System;",
    "using System.Collections.Generic;",
    "using Alias = System.Text.StringBuilder;",
    "",
    "namespace App.Core {",
    "    public class Base { }",
    "    public interface IRunnable { void Run(); }",
    "",
    "    public class Worker : Base, IRunnable {",
    "        private Helper helper;",
    "        public Config Settings { get; set; }",
    "        public List<string> names;",
    "",
    "        public Worker(Config cfg) {",
    "            helper = new Helper();",
    "            int decoy = 1;",
    "        }",
    "",
    "        public void Run(Config cfg) {",
    '            var s = "StringDecoy( new Foo() Bar()";',
    "            // CommentDecoy new Baz() Qux()",
    "            /* BlockDecoy new Zap() */",
    "            Helper local = new Helper();",
    "            helper.DoWork(cfg);",
    "            Process();",
    "        }",
    "",
    "        private void Process() { }",
    "    }",
    "",
    "    public class Helper {",
    "        public string Name;",
    "        public void DoWork(Config c) { }",
    "    }",
    "",
    "    public class Config { }",
    "}",
].join("\n");

const h = new TextCsharp(metadata);
const refs = h.references(SRC);
const find = (kind: MimeRef["kind"], name: string): MimeRef | undefined =>
    refs.find((r) => r.kind === kind && r.name === name);

describe("TextCsharp references — kinds", () => {
    it("import: using directives capture the dotted namespace/type", () => {
        assert.ok(find("import", "System"));
        assert.ok(find("import", "System.Collections.Generic"));
    });

    it("import: aliased using captures the target (original), not the alias", () => {
        assert.ok(find("import", "System.Text.StringBuilder"));
        assert.ok(!find("import", "Alias"), "alias name is not an import");
    });

    it("inherit: base class and interfaces of `class C : Base, IRunnable`", () => {
        assert.ok(find("inherit", "Base"));
        assert.ok(find("inherit", "IRunnable"));
    });

    it("call: invocations capture the callee name only (not the receiver)", () => {
        assert.ok(find("call", "DoWork"), "member call DoWork");
        assert.ok(find("call", "Process"), "bare call Process");
        assert.ok(!refs.some((r) => r.kind === "call" && r.name === "helper"),
            "receiver `helper` is not a call");
    });

    it("instantiate: `new Helper()` object creation", () => {
        const insts = refs.filter((r) => r.kind === "instantiate");
        assert.equal(insts.length, 2, "two `new Helper()` sites (ctor + Run)");
        assert.ok(insts.every((r) => r.name === "Helper"));
    });

    it("type: field/property/parameter/local declared types (named types only)", () => {
        assert.ok(find("type", "Helper"), "field/local type Helper");
        assert.ok(find("type", "Config"), "param/property type Config");
        assert.ok(find("type", "List"), "generic outer type List");
        // Predefined types never surface as refs.
        assert.ok(!find("type", "string"));
        assert.ok(!find("type", "int"));
        assert.ok(!find("type", "void"));
    });
});

describe("TextCsharp references — containers (SPEC §16)", () => {
    it("class-level refs carry the class path", () => {
        assert.equal(find("inherit", "Base")?.container, "App.Core.Worker");
        assert.equal(find("type", "List")?.container, "App.Core.Worker");
    });

    it("method-body refs carry the method-level path = class.method", () => {
        assert.equal(find("call", "DoWork")?.container, "App.Core.Worker.Run");
        assert.equal(find("call", "Process")?.container, "App.Core.Worker.Run");
        const runInst = refs.find(
            (r) => r.kind === "instantiate" && r.container === "App.Core.Worker.Run",
        );
        assert.ok(runInst, "instantiate inside Run carries Worker.Run");
    });

    it("top-level using imports omit the container key", () => {
        assert.equal(find("import", "System")?.container, undefined);
    });
});

describe("TextCsharp references — conformance invariants (SPEC §16)", () => {
    it("no string-literal or comment decoy leaks into any ref", () => {
        const decoy = /Decoy|Foo|Bar|Baz|Qux|Zap/;
        assert.ok(!refs.some((r) => decoy.test(r.name)),
            `decoy leaked: ${refs.filter((r) => decoy.test(r.name)).map((r) => r.name)}`);
    });

    it("no ref names a definition the same entry emits (refs are uses, not defs)", () => {
        const syms = h.extractRaw(SRC);
        // A ref must never BE the def at its own position — e.g. the class's
        // own name, a method's own name. Check no ref shares a def's exact
        // (name, line, column) identity.
        const defAt = new Set(syms.map((s) => `${s.name}@${s.line}:${s.column}`));
        for (const r of refs) {
            assert.ok(!defAt.has(`${r.name}@${r.line}:${r.column}`),
                `ref ${r.name} at ${r.line}:${r.column} collides with a def`);
        }
        // The Worker class's own name is never a ref.
        assert.ok(!refs.some((r) => r.name === "Worker" && r.kind !== "instantiate"));
    });

    it("every container names an enclosing definition emitted by the symbols channel", () => {
        const syms = h.extractRaw(SRC);
        const paths = new Set(
            syms.map((s) => (s.container ? `${s.container}.` : "") + s.name),
        );
        for (const r of refs) {
            if (r.container === undefined) continue;
            assert.ok(paths.has(r.container),
                `container ${r.container} has no matching def`);
        }
    });

    it("positions are 1-indexed and well-formed", () => {
        for (const r of refs) {
            assert.ok(r.line >= 1 && r.column >= 1);
            assert.ok(r.endLine >= r.line);
            assert.equal(typeof r.column, "number");
            assert.equal(typeof r.endColumn, "number");
        }
    });

    it("deterministic document order (sorted by line then column)", () => {
        for (let i = 1; i < refs.length; i++) {
            const a = refs[i - 1];
            const b = refs[i];
            const ok = a.line < b.line || (a.line === b.line && a.column <= b.column);
            assert.ok(ok, `out of order at ${i}: ${a.line}:${a.column} then ${b.line}:${b.column}`);
        }
    });
});

describe("TextCsharp references — joins to local defs", () => {
    it("ref names resolve to ≥2 locally-defined symbols (name-join)", () => {
        const syms = h.extractRaw(SRC);
        const defNames = new Set(syms.map((s) => s.name));
        const joined = new Set(
            refs.filter((r) => defNames.has(r.name)).map((r) => r.name),
        );
        // new Helper() → class Helper; DoWork() → method DoWork;
        // Config type → class Config; inherit Base → class Base.
        assert.ok(joined.has("Helper"), "instantiate Helper joins to local class Helper");
        assert.ok(joined.has("DoWork"), "call DoWork joins to local method DoWork");
        assert.ok(joined.size >= 2, `expected ≥2 joins, got ${[...joined]}`);
    });

    it("the new-expression edge joins to the class it constructs", () => {
        const syms = h.extractRaw(SRC);
        const helperDef = syms.find((s) => s.name === "Helper" && s.kind === "class");
        const helperInst = find("instantiate", "Helper");
        assert.ok(helperDef);
        assert.ok(helperInst);
        assert.equal(helperInst.name, helperDef.name);
    });
});

describe("TextCsharp references — degradation", () => {
    it("returns [] for empty input", () => {
        assert.deepEqual(h.references(""), []);
    });

    it("does not throw on malformed source", () => {
        assert.doesNotThrow(() => h.references("class { broken"));
    });

    it("a refs-free file yields no references", () => {
        assert.deepEqual(h.references("public enum E { A, B }"), []);
    });
});
