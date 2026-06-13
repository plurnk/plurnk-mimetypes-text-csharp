import { AntlrExtractor, withExtractor } from "@plurnk/plurnk-mimetypes";
import type { ExtractionVisitor, HandlerContent, MimeRef } from "@plurnk/plurnk-mimetypes";
import { CharStream, CommonTokenStream } from "antlr4ng";
import { CSharpLexer } from "./generated/CSharpLexer.ts";
import { CSharpParser } from "./generated/CSharpParser.ts";
import { CSharpParserVisitor } from "./generated/CSharpParserVisitor.ts";

// text/x-csharp handler. ANTLR grammar from grammars-v4/csharp/v7.
//
// Parser entry rule: compilation_unit
//   compilation_unit:
//     BOM? extern_aliases? using_directives? global_attribute_section*
//     namespace_member_declarations? EOF
//
// Note: the grammar uses snake_case rule names (atypical for C# but standard
// in this grammar), so visitor handlers are named visit<Snake_case>.
export default class TextCsharp extends AntlrExtractor {
    protected parseTree(content: string): unknown {
        const lexer = new CSharpLexer(CharStream.fromString(content));
        const tokens = new CommonTokenStream(lexer);
        const parser = new CSharpParser(tokens);
        parser.removeErrorListeners();
        return parser.compilation_unit();
    }

    protected createVisitor(): ExtractionVisitor {
        return new TextCsharpVisitor() as unknown as ExtractionVisitor;
    }

    // The visitor emits refs in handler-visit order (class-level before each
    // method's pruned-body walk), which is stable but not strictly source
    // order. SPEC §16 requires document order — sort by (line, column).
    override references(content: HandlerContent): MimeRef[] {
        const refs = super.references(content);
        return refs.toSorted((a, b) => a.line - b.line || a.column - b.column);
    }
}

// SPEC §3 mapping for C#:
//   namespace_declaration            → module
//   class_definition                 → class
//   struct_definition                → class (value-type "class" semantically)
//   interface_definition             → interface
//   enum_definition                  → enum
//   delegate_definition              → function (a delegate is a typed function sig)
//   method_declaration               → method
//   constructor_declaration          → method
//   destructor_definition            → method
//   property_declaration             → field
//   event_declaration                → field
//   field_declaration                → field (variable_declarators inside)
//   constant_declaration             → constant
//   using_directive                  → excluded
//   local_variable_declaration       → excluded (gateBody)
//
// SPEC §16 references mapping (FROZEN RefKind):
//   using_directive                  → import     (full dotted namespace/type)
//   class_base bases + interfaces    → inherit
//   field/property/parameter/return/
//     local/constant type uses       → type       (named types only)
//   method_invocation callee         → call        (callee name, not receiver)
//   new TypeName(...)                → instantiate
//
// Container threading (issue #18): named declarations recurse via
// gateContainer, so member defs carry container = the enclosing class path.
// `#path` mirrors that stack so refs emitted from pruned method bodies can
// compute the same container = "<class path>.<method>" — the join key §16
// requires. Refs are gathered by collectDescendants over the def subtree
// (string/comment tokens never parse into a Type_/identifier ref node, so the
// "no string/comment leakage" invariant holds by construction).
class TextCsharpVisitor extends withExtractor(CSharpParserVisitor) {
    #path: string[] = [];

    #container(): string | undefined {
        return this.#path.length > 0 ? this.#path.join(".") : undefined;
    }

    visitNamespace_declaration = (ctx: any): null => {
        if (this.inBody) return null;
        const qi = ctx.qualified_identifier?.();
        const name = qi?.getText?.();
        if (!name) {
            this.visitChildren(ctx);
            return null;
        }
        this.addSymbol("module", name, ctx);
        this.#path.push(name);
        try {
            this.gateContainer(name, ctx);
        } finally {
            this.#path.pop();
        }
        return null;
    };

    visitClass_definition = (ctx: any): null => {
        if (this.inBody) return null;
        const id = ctx.identifier?.()?.getText?.();
        if (!id) {
            this.visitChildren(ctx);
            return null;
        }
        this.addSymbol("class", id, ctx);
        this.#refInherit(ctx.class_base?.(), [...this.#path, id].join("."));
        this.#path.push(id);
        try {
            this.gateContainer(id, ctx);
        } finally {
            this.#path.pop();
        }
        return null;
    };

    visitStruct_definition = (ctx: any): null => {
        if (this.inBody) return null;
        const id = ctx.identifier?.()?.getText?.();
        if (!id) {
            this.visitChildren(ctx);
            return null;
        }
        this.addSymbol("class", id, ctx);
        this.#path.push(id);
        try {
            this.gateContainer(id, ctx);
        } finally {
            this.#path.pop();
        }
        return null;
    };

    visitInterface_definition = (ctx: any): null => {
        if (this.inBody) return null;
        const id = ctx.identifier?.()?.getText?.();
        if (!id) {
            this.visitChildren(ctx);
            return null;
        }
        this.addSymbol("interface", id, ctx);
        this.#refInherit(ctx.interface_base?.(), [...this.#path, id].join("."));
        this.#path.push(id);
        try {
            this.gateContainer(id, ctx);
        } finally {
            this.#path.pop();
        }
        return null;
    };

    visitEnum_definition = (ctx: any): null => {
        if (this.inBody) return null;
        const id = ctx.identifier?.()?.getText?.();
        if (id) this.addSymbol("enum", id, ctx);
        // Don't recurse: enum members aren't symbols we surface per SPEC §3.
        return null;
    };

    visitDelegate_definition = (ctx: any): null => {
        if (this.inBody) return null;
        const id = ctx.identifier?.()?.getText?.();
        if (!id) return null;
        const params = extractCsharpParams(ctx.formal_parameter_list?.());
        this.addSymbol("function", id, ctx, params);
        // A delegate is a typed signature: return type + parameter types are
        // type uses, owned by the delegate (the def composing the path).
        this.#refTypes(ctx, [...this.#path, id].join("."));
        return null;
    };

    visitMethod_declaration = (ctx: any): null => {
        if (this.inBody) return null;
        const mmn = ctx.method_member_name?.();
        const name = lastIdentifierText(mmn);
        if (!name) return null;
        const params = extractCsharpParams(ctx.formal_parameter_list?.());
        this.addSymbol("method", name, ctx, params);
        const container = [...this.#path, name].join(".");
        // Return type (typed_member_declaration's type_, a parent sibling) +
        // parameter types + body refs (call, instantiate, local types).
        // method_body is pruned for symbols (gateBody) but walked here for refs
        // with the method-level container.
        this.#refMemberType(ctx, container);
        this.#refParamTypes(ctx.formal_parameter_list?.(), container);
        const body = ctx.method_body?.();
        if (body) {
            this.#refBody(body, container);
            this.gateBody(body);
        }
        return null;
    };

    visitConstructor_declaration = (ctx: any): null => {
        if (this.inBody) return null;
        const id = ctx.identifier?.()?.getText?.();
        if (!id) return null;
        const params = extractCsharpParams(ctx.formal_parameter_list?.());
        this.addSymbol("method", id, ctx, params);
        const container = [...this.#path, id].join(".");
        this.#refParamTypes(ctx.formal_parameter_list?.(), container);
        const body = ctx.body?.();
        if (body) {
            this.#refBody(body, container);
            this.gateBody(body);
        }
        return null;
    };

    visitDestructor_definition = (ctx: any): null => {
        if (this.inBody) return null;
        const id = ctx.identifier?.()?.getText?.();
        if (!id) return null;
        const name = `~${id}`;
        this.addSymbol("method", name, ctx);
        const container = [...this.#path, name].join(".");
        const body = ctx.body?.();
        if (body) {
            this.#refBody(body, container);
            this.gateBody(body);
        }
        return null;
    };

    visitProperty_declaration = (ctx: any): null => {
        if (this.inBody) return null;
        const mn = ctx.member_name?.();
        const name = mn?.getText?.();
        if (!name) return null;
        this.addSymbol("field", name, ctx);
        // Property type lives on the enclosing typed_member_declaration's
        // type_ (sibling) — capture it owned by the class path.
        this.#refMemberType(ctx, this.#container());
        return null;
    };

    visitEvent_declaration = (ctx: any): null => {
        if (this.inBody) return null;
        const container = this.#container();
        const vds = ctx.variable_declarators?.();
        if (vds) {
            for (const name of variableDeclaratorNames(vds)) {
                this.addSymbol("field", name, ctx);
            }
            this.#refTypes(ctx.type_?.(), container);
            return null;
        }
        const mn = ctx.member_name?.();
        const name = mn?.getText?.();
        if (name) this.addSymbol("field", name, ctx);
        this.#refTypes(ctx.type_?.(), container);
        return null;
    };

    visitField_declaration = (ctx: any): null => {
        if (this.inBody) return null;
        const vds = ctx.variable_declarators?.();
        if (!vds) return null;
        for (const name of variableDeclaratorNames(vds)) {
            this.addSymbol("field", name, ctx);
        }
        // Field type is the typed_member_declaration's type_ (parent sibling).
        this.#refMemberType(ctx, this.#container());
        return null;
    };

    visitConstant_declaration = (ctx: any): null => {
        if (this.inBody) return null;
        const cds = ctx.constant_declarators?.();
        if (!cds) return null;
        for (const name of constantDeclaratorNames(cds)) {
            this.addSymbol("constant", name, ctx);
        }
        this.#refTypes(ctx.type_?.(), this.#container());
        return null;
    };

    // The grammar labels using_directive alternatives, so the visitor
    // dispatches to per-alt methods (there is no visitUsing_directive). All
    // three carry a namespace_or_type_name; SPEC §16 import captures it. For
    // `using X = A.B.C` (alias) that target is the original, not the alias.
    visitUsingNamespaceDirective = (ctx: any): null => this.#refImport(ctx);
    visitUsingStaticDirective = (ctx: any): null => this.#refImport(ctx);
    visitUsingAliasDirective = (ctx: any): null => this.#refImport(ctx);

    #refImport(ctx: any): null {
        const nt = ctx.namespace_or_type_name?.();
        const name = nt?.getText?.();
        if (name) this.addRef("import", name, nt, { container: this.#container() });
        return null;
    }

    visitInterface_member_declaration = (ctx: any): null => {
        if (this.inBody) return null;
        // The grammar inlines methods, properties, events, indexers directly
        // into interface_member_declaration rather than re-using the named
        // rules. Use the presence of `(` to discriminate method vs property.
        const id = ctx.identifier?.();
        if (!id) return null;
        const idText = id.getText();
        const hasParens = !!ctx.OPEN_PARENS?.();
        if (hasParens) {
            const params = extractCsharpParams(ctx.formal_parameter_list?.());
            this.addSymbol("method", idText, ctx, params);
            const container = [...this.#path, idText].join(".");
            this.#refTypes(ctx.type_?.(), container);
            this.#refParamTypes(ctx.formal_parameter_list?.(), container);
        } else {
            this.addSymbol("field", idText, ctx);
            this.#refTypes(ctx.type_?.(), this.#container());
        }
        return null;
    };

    // --- reference helpers (SPEC §16) -----------------------------------

    // Bases + interfaces in `class C : Base, IFoo` / `interface I : IBar`.
    #refInherit(base: unknown, container: string): void {
        if (!base) return;
        for (const nt of collectDescendants(base, "Namespace_or_type_nameContext")) {
            const name = typeName(nt);
            if (name) this.addRef("inherit", name, nt as never, { container });
        }
    }

    // The shared type_ of a typed_member_declaration (field/property): it sits
    // on the parent context, a sibling of this member context.
    #refMemberType(ctx: any, container: string | undefined): void {
        const parent = ctx.parent;
        const type = (parent as { type_?: () => unknown })?.type_?.();
        this.#refTypes(type, container);
    }

    // Named type uses under `node` (a type_ ctx or any subtree), excluding the
    // type of a `new T(...)` (that is instantiate, emitted separately) and the
    // bases of a class_base (that is inherit).
    #refTypes(node: unknown, container: string | undefined): void {
        if (!node) return;
        for (const t of typeContexts(node)) {
            if (underObjectCreation(t)) continue;
            const name = typeName(t);
            if (name) this.addRef("type", name, t as never, { container });
        }
    }

    // Parameter types: arg_declaration's type_ (and parameter_array's type).
    #refParamTypes(formalList: unknown, container: string): void {
        if (!formalList) return;
        for (const t of collectDescendants(formalList, "Type_Context")) {
            if (underObjectCreation(t)) continue;
            const name = typeName(t);
            if (name) this.addRef("type", name, t as never, { container });
        }
    }

    // Method/constructor body: call (method_invocation callee) + instantiate
    // (object creation) + named types in local declarations.
    #refBody(body: unknown, container: string): void {
        for (const pe of collectDescendants(body, "Primary_expressionContext")) {
            this.#refCallsAndNew(pe, container);
        }
        // Local-declaration named types — type_ outside object-creation.
        for (const decl of collectDescendants(body, "Local_variable_typeContext")) {
            const type = (decl as { type_?: () => unknown }).type_?.();
            if (type && !underObjectCreation(type)) {
                const name = typeName((type as { namespace_or_type_name?: () => unknown }));
                if (name) this.addRef("type", name, type as never, { container });
            }
        }
    }

    // A primary_expression is `start op*`; an op that is a method_invocation
    // makes a call — the callee name is the immediately preceding sibling
    // (member_access property name, or the simpleName start). An
    // objectCreationExpression start is an instantiate.
    #refCallsAndNew(pe: any, container: string): void {
        const children = pe.children;
        if (!Array.isArray(children)) return;
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            const cn = child?.constructor?.name;
            if (cn === "ObjectCreationExpressionContext") {
                const type = (child as { type_?: () => unknown }).type_?.();
                // Only the constructor form `new T(...)` — array/initializer
                // forms lack an object_creation_expression child.
                const isCtor = !!(child as { object_creation_expression?: () => unknown })
                    .object_creation_expression?.();
                const name = type ? typeName((type as { namespace_or_type_name?: () => unknown })) : null;
                if (isCtor && name) this.addRef("instantiate", name, type as never, { container });
                continue;
            }
            if (cn !== "Method_invocationContext") continue;
            const prev = children[i - 1];
            const prevCn = prev?.constructor?.name;
            // Member call `recv.Name(...)` — callee is the member_access name;
            // bare call `Name(...)` — callee is the simpleName start. Both
            // expose a single `identifier()`. The receiver is NOT captured.
            if (prevCn === "Member_accessContext" || prevCn === "SimpleNameExpressionContext") {
                const idNode = prev.identifier?.();
                const name = idNode?.getText?.();
                if (name) this.addRef("call", name, idNode, { container });
            }
        }
    }
}

// First identifier of a namespace_or_type_name (or a type_'s), stripping
// generic arguments — `List<string>` → `List`, `System.Text.X` → keeps the
// full dotted name for join symmetry with how type defs are named. Predefined
// types (int, string) have no namespace_or_type_name and yield null.
function typeName(node: unknown): string | null {
    if (!node) return null;
    const nt = resolveNamespaceOrType(node);
    if (!nt) return null;
    const ids = (nt as { identifier?: () => unknown }).identifier?.();
    const arr = Array.isArray(ids) ? ids : ids ? [ids] : [];
    const parts = arr
        .map((id) => (id as { getText?: () => string }).getText?.())
        .filter((t): t is string => !!t);
    return parts.length > 0 ? parts.join(".") : null;
}

// Resolve to the nearest namespace_or_type_name: the node may already be one,
// or be a type_/class_type wrapping one.
function resolveNamespaceOrType(node: unknown): unknown {
    const cn = (node as { constructor?: { name?: string } })?.constructor?.name;
    if (cn === "Namespace_or_type_nameContext") return node;
    const found = collectDescendants(node, "Namespace_or_type_nameContext");
    return found.length > 0 ? found[0] : null;
}

// True if `type` (a Type_Context) is the type of a `new T(...)` — its parent
// chain reaches an ObjectCreationExpressionContext before any declaration.
function underObjectCreation(type: unknown): boolean {
    const parent = (type as { parent?: unknown }).parent;
    return (parent as { constructor?: { name?: string } })?.constructor?.name
        === "ObjectCreationExpressionContext";
}

// Type_Context nodes at or under `node` (collectDescendants only finds strict
// descendants; a type_ passed directly — a field/return type — must count too).
function typeContexts(node: unknown): unknown[] {
    const out = collectDescendants(node, "Type_Context");
    if ((node as { constructor?: { name?: string } })?.constructor?.name === "Type_Context") {
        out.unshift(node);
    }
    return out;
}

// Recursive descendant collection by ANTLR context class name. Method bodies
// are pruned for symbols (gateBody), so refs are gathered by walking the def
// subtree directly — same pattern as the SQLite handler.
function collectDescendants(ctx: unknown, className: string): unknown[] {
    const out: unknown[] = [];
    const walk = (node: unknown): void => {
        const children = (node as { children?: unknown[] }).children;
        if (!Array.isArray(children)) return;
        for (const child of children) {
            if ((child as { constructor?: { name?: string } })?.constructor?.name === className) {
                out.push(child);
            }
            walk(child);
        }
    };
    walk(ctx);
    return out;
}

// method_member_name: identifier ('.' identifier)* — last segment is the
// method's local name. Explicit interface implementations like `IFoo.Bar`
// surface as `Bar` since the surrounding type structure already places them.
function lastIdentifierText(mmn: unknown): string | null {
    if (!mmn) return null;
    const node = mmn as {
        identifier?: () => Array<{ getText?: () => string }> | { getText?: () => string };
    };
    const raw = node.identifier?.();
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (arr.length === 0) return null;
    const last = arr[arr.length - 1];
    return last?.getText?.() ?? null;
}

function variableDeclaratorNames(vds: unknown): string[] {
    const node = vds as {
        variable_declarator?: () =>
            | Array<{ identifier?: () => { getText?: () => string } | null }>
            | { identifier?: () => { getText?: () => string } | null };
    };
    const raw = node.variable_declarator?.();
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const out: string[] = [];
    for (const vd of arr) {
        const t = vd.identifier?.()?.getText?.();
        if (t) out.push(t);
    }
    return out;
}

function constantDeclaratorNames(cds: unknown): string[] {
    const node = cds as {
        constant_declarator?: () =>
            | Array<{ identifier?: () => { getText?: () => string } | null }>
            | { identifier?: () => { getText?: () => string } | null };
    };
    const raw = node.constant_declarator?.();
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const out: string[] = [];
    for (const cd of arr) {
        const t = cd.identifier?.()?.getText?.();
        if (t) out.push(t);
    }
    return out;
}

// formal_parameter_list: parameter_array | fixed_parameters (',' parameter_array)?
//   fixed_parameters: fixed_parameter (',' fixed_parameter)*
//   fixed_parameter: attributes? parameter_modifier? arg_declaration | ARGLIST
//   arg_declaration: type_ identifier ('=' expression)?
//   parameter_array: attributes? PARAMS array_type identifier
function extractCsharpParams(formalList: unknown): string[] {
    if (!formalList) return [];
    const node = formalList as {
        fixed_parameters?: () => unknown;
        parameter_array?: () => unknown;
    };
    const out: string[] = [];
    const fixed = node.fixed_parameters?.();
    if (fixed) {
        const fp = fixed as {
            fixed_parameter?: () => Array<unknown> | unknown;
        };
        const raw = fp.fixed_parameter?.();
        const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
        for (const p of arr) {
            const pNode = p as {
                arg_declaration?: () => { identifier?: () => { getText?: () => string } | null } | null;
            };
            const id = pNode.arg_declaration?.()?.identifier?.()?.getText?.();
            if (id) out.push(id);
        }
    }
    const pa = node.parameter_array?.();
    if (pa) {
        const id = (pa as { identifier?: () => { getText?: () => string } | null })
            .identifier?.()?.getText?.();
        if (id) out.push(id);
    }
    return out;
}
