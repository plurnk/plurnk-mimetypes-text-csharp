import { AntlrExtractor, withExtractor } from "@plurnk/plurnk-mimetypes";
import type { ExtractionVisitor } from "@plurnk/plurnk-mimetypes";
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
class TextCsharpVisitor extends withExtractor(CSharpParserVisitor) {
    visitNamespace_declaration = (ctx: any): null => {
        if (this.inBody) return null;
        const qi = ctx.qualified_identifier?.();
        const name = qi?.getText?.();
        if (name) this.addSymbol("module", name, ctx);
        this.visitChildren(ctx);
        return null;
    };

    visitClass_definition = (ctx: any): null => {
        if (this.inBody) return null;
        const id = ctx.identifier?.()?.getText?.();
        if (id) this.addSymbol("class", id, ctx);
        this.visitChildren(ctx);
        return null;
    };

    visitStruct_definition = (ctx: any): null => {
        if (this.inBody) return null;
        const id = ctx.identifier?.()?.getText?.();
        if (id) this.addSymbol("class", id, ctx);
        this.visitChildren(ctx);
        return null;
    };

    visitInterface_definition = (ctx: any): null => {
        if (this.inBody) return null;
        const id = ctx.identifier?.()?.getText?.();
        if (id) this.addSymbol("interface", id, ctx);
        this.visitChildren(ctx);
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
        return null;
    };

    visitMethod_declaration = (ctx: any): null => {
        if (this.inBody) return null;
        const mmn = ctx.method_member_name?.();
        const name = lastIdentifierText(mmn);
        if (!name) return null;
        const params = extractCsharpParams(ctx.formal_parameter_list?.());
        this.addSymbol("method", name, ctx, params);
        const body = ctx.method_body?.();
        if (body) this.gateBody(body);
        return null;
    };

    visitConstructor_declaration = (ctx: any): null => {
        if (this.inBody) return null;
        const id = ctx.identifier?.()?.getText?.();
        if (!id) return null;
        const params = extractCsharpParams(ctx.formal_parameter_list?.());
        this.addSymbol("method", id, ctx, params);
        const body = ctx.body?.();
        if (body) this.gateBody(body);
        return null;
    };

    visitDestructor_definition = (ctx: any): null => {
        if (this.inBody) return null;
        const id = ctx.identifier?.()?.getText?.();
        if (!id) return null;
        this.addSymbol("method", `~${id}`, ctx);
        const body = ctx.body?.();
        if (body) this.gateBody(body);
        return null;
    };

    visitProperty_declaration = (ctx: any): null => {
        if (this.inBody) return null;
        const mn = ctx.member_name?.();
        const name = mn?.getText?.();
        if (name) this.addSymbol("field", name, ctx);
        return null;
    };

    visitEvent_declaration = (ctx: any): null => {
        if (this.inBody) return null;
        const vds = ctx.variable_declarators?.();
        if (vds) {
            for (const name of variableDeclaratorNames(vds)) {
                this.addSymbol("field", name, ctx);
            }
            return null;
        }
        const mn = ctx.member_name?.();
        const name = mn?.getText?.();
        if (name) this.addSymbol("field", name, ctx);
        return null;
    };

    visitField_declaration = (ctx: any): null => {
        if (this.inBody) return null;
        const vds = ctx.variable_declarators?.();
        if (!vds) return null;
        for (const name of variableDeclaratorNames(vds)) {
            this.addSymbol("field", name, ctx);
        }
        return null;
    };

    visitConstant_declaration = (ctx: any): null => {
        if (this.inBody) return null;
        const cds = ctx.constant_declarators?.();
        if (!cds) return null;
        for (const name of constantDeclaratorNames(cds)) {
            this.addSymbol("constant", name, ctx);
        }
        return null;
    };

    visitUsing_directive = (_ctx: any): null => {
        return null;
    };

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
        } else {
            this.addSymbol("field", idText, ctx);
        }
        return null;
    };
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
