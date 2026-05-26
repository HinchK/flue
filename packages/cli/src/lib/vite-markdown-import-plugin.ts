import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plugin } from 'vite';
import { transformWithOxc } from 'vite';

const MARKDOWN_MODULE_PREFIX = '\0flue-markdown:';

export function markdownImportPlugin(): Plugin {
	let root = '';
	return {
		name: 'flue-markdown-import',
		enforce: 'pre',
		configResolved(config) {
			root = config.root;
		},
		async transform(code, id) {
			if (!/\.[cm]?[jt]sx?(?:\?|$)/i.test(id)) return null;
			const importerPath = id.split('?')[0] ?? id;
			const parseableCode = /\.[cm]?tsx?(?:\?|$)/i.test(id)
				? (await transformWithOxc(code, importerPath, {})).code
				: code;
			const ast = this.parse(parseableCode) as unknown as ModuleAst;
			const declarations = collectAttributedMarkdownImports(ast);
			if (declarations.length === 0) return null;
			let transformed = parseableCode;
			for (const declaration of declarations.sort((a, b) => b.start - a.start)) {
				const rootRelativePath = declaration.specifier.startsWith('/')
					? path.resolve(root, declaration.specifier.slice(1))
					: undefined;
				const resolved = rootRelativePath
					? { id: rootRelativePath, external: false }
					: await this.resolve(declaration.specifier, importerPath, { skipSelf: true });
				if (!resolved || resolved.external) {
					throw new Error(`[flue] Unable to resolve markdown import: ${declaration.specifier}`);
				}
				if (isSkillMarkdownPath(resolved.id)) {
					throw new Error(`[flue] SKILL.md imports must use an import attribute: with { type: 'skill' }.`);
				}
				transformed = `${transformed.slice(0, declaration.start)}${JSON.stringify(`${MARKDOWN_MODULE_PREFIX}${resolved.id}`)}${transformed.slice(declaration.end)}`;
			}
			return { code: transformed, map: null };
		},
		resolveId(source) {
			if (source.startsWith(MARKDOWN_MODULE_PREFIX)) return source;
			return null;
		},
		async load(id) {
			if (!id.startsWith(MARKDOWN_MODULE_PREFIX)) return null;
			const markdownPath = id.slice(MARKDOWN_MODULE_PREFIX.length);
			this.addWatchFile(markdownPath);
			return `export default ${JSON.stringify(await fs.promises.readFile(markdownPath, 'utf8'))};`;
		},
	};
}

interface ModuleAst {
	body: unknown[];
}

interface AstNode {
	type?: string;
	source?: { value?: unknown; start?: number; end?: number };
	attributes?: Array<{ key?: { name?: unknown; value?: unknown }; value?: { value?: unknown } }>;
}

interface AttributedMarkdownImport {
	specifier: string;
	start: number;
	end: number;
}

function collectAttributedMarkdownImports(ast: ModuleAst): AttributedMarkdownImport[] {
	const imports: AttributedMarkdownImport[] = [];
	for (const entry of ast.body) {
		const declaration = entry as AstNode;
		if (declaration.type !== 'ImportDeclaration' && declaration.type !== 'ExportNamedDeclaration' && declaration.type !== 'ExportAllDeclaration') continue;
		const specifier = declaration.source?.value;
		if (typeof specifier !== 'string') continue;
		const markdownAttribute = declaration.attributes?.some((attribute) => {
			const key = attribute.key?.name ?? attribute.key?.value;
			return key === 'type' && attribute.value?.value === 'markdown';
		});
		if (!markdownAttribute) continue;
		if (isSkillMarkdownPath(specifier)) {
			throw new Error(`[flue] SKILL.md imports must use an import attribute: with { type: 'skill' }.`);
		}
		if (!/\.md$/i.test(specifier)) {
			throw new Error(`[flue] Markdown imports must target a .md file: ${specifier}`);
		}
		const start = declaration.source?.start;
		const end = declaration.source?.end;
		if (typeof start !== 'number' || typeof end !== 'number') {
			throw new Error(`[flue] Unable to transform markdown import: ${specifier}`);
		}
		imports.push({ specifier, start, end });
	}
	return imports;
}

function isSkillMarkdownPath(specifier: string): boolean {
	return path.basename(specifier.split(/[?#]/, 1)[0] ?? '') === 'SKILL.md';
}
