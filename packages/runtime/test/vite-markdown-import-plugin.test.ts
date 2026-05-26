import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build as viteBuild, createServer } from 'vite';
import { describe, expect, it } from 'vitest';
import { markdownImportPlugin } from '../../cli/src/lib/vite-markdown-import-plugin.ts';
import { skillReferencePlugin } from '../../cli/src/lib/vite-skill-reference-plugin.ts';

describe('Vite markdown import plugin', () => {
	it('imports attributed markdown as text in production builds', async () => {
		const root = createFixtureRoot();
		writeModule(root, 'instructions/proposal.md', '# Proposal\n\nWrite carefully.\n');
		writeModule(root, 'src/entry.ts', `import instructions from '../instructions/proposal.md' with { type: 'markdown' };\nexport { instructions };\n`);

		const module = await importBuiltFixture(await buildFixture(root));

		expect(module.instructions).toBe('# Proposal\n\nWrite carefully.\n');
	});

	it('handles attributed markdown imports in authored TypeScript modules', async () => {
		const root = createFixtureRoot();
		writeModule(root, 'instructions/proposal.md', 'Typed instructions.\n');
		writeModule(root, 'src/entry.ts', `import instructions from '../instructions/proposal.md' with { type: 'markdown' };\nexport const content: string = instructions;\n`);

		const module = await importBuiltFixture(await buildFixture(root));

		expect(module.content).toBe('Typed instructions.\n');
	});

	it('resolves root-relative attributed markdown through Vite', async () => {
		const root = createFixtureRoot();
		writeModule(root, 'instructions/proposal.md', 'Root-relative instructions.\n');
		writeModule(root, 'src/entry.ts', `import instructions from '/instructions/proposal.md' with { type: 'markdown' };\nexport { instructions };\n`);

		const module = await importBuiltFixture(await buildFixture(root));

		expect(module.instructions).toBe('Root-relative instructions.\n');
	});

	it('resolves aliased attributed markdown through Vite', async () => {
		const root = createFixtureRoot();
		writeModule(root, 'instructions/proposal.md', 'Aliased instructions.\n');
		writeModule(root, 'src/entry.ts', `import instructions from '@instructions/proposal.md' with { type: 'markdown' };\nexport { instructions };\n`);

		const module = await importBuiltFixture(await buildFixture(root, false, { '@instructions': path.join(root, 'instructions') }));

		expect(module.instructions).toBe('Aliased instructions.\n');
	});

	it('supports attributed markdown barrel re-exports', async () => {
		const root = createFixtureRoot();
		writeModule(root, 'instructions/proposal.md', 'Re-exported instructions.\n');
		writeModule(root, 'src/content.ts', `export { default as instructions } from '../instructions/proposal.md' with { type: 'markdown' };\n`);
		writeModule(root, 'src/entry.ts', `export { instructions } from './content.ts';\n`);

		const module = await importBuiltFixture(await buildFixture(root));

		expect(module.instructions).toBe('Re-exported instructions.\n');
	});

	it('loads attributed markdown imports through Vite development', async () => {
		const root = createFixtureRoot();
		writeModule(root, 'instructions/proposal.md', 'Development instructions.\n');
		writeModule(root, 'src/entry.ts', `import instructions from '../instructions/proposal.md' with { type: 'markdown' };\nexport { instructions };\n`);
		const server = await createServer({
			configFile: false,
			root,
			logLevel: 'silent',
			plugins: [markdownImportPlugin()],
			server: { middlewareMode: true },
		});
		try {
			const module = (await server.ssrLoadModule('/src/entry.ts')) as { instructions: string };
			expect(module.instructions).toBe('Development instructions.\n');
		} finally {
			await server.close();
		}
	});

	it('rejects non-markdown attributed imports', async () => {
		const root = createFixtureRoot();
		writeModule(root, 'instructions/proposal.txt', 'Instructions.\n');
		writeModule(root, 'src/entry.ts', `import instructions from '../instructions/proposal.txt' with { type: 'markdown' };\nexport { instructions };\n`);

		await expect(buildFixture(root)).rejects.toThrow('Markdown imports must target a .md file');
	});

	it('reserves SKILL.md for skill-reference imports', async () => {
		const root = createFixtureRoot();
		writeModule(root, 'skills/review/SKILL.md', 'Review it.\n');
		writeModule(root, 'src/entry.ts', `import instructions from '../skills/review/SKILL.md' with { type: 'markdown' };\nexport { instructions };\n`);

		await expect(buildFixture(root, true)).rejects.toThrow("SKILL.md imports must use an import attribute: with { type: 'skill' }");
	});

	it.each(['skill.md', 'NOTSKILL.md'])('imports noncanonical %s files as markdown text', async (filename) => {
		const root = createFixtureRoot();
		writeModule(root, `instructions/${filename}`, 'Ordinary markdown.\n');
		writeModule(root, 'src/entry.ts', `import instructions from '../instructions/${filename}' with { type: 'markdown' };\nexport { instructions };\n`);

		const module = await importBuiltFixture(await buildFixture(root, true));

		expect(module.instructions).toBe('Ordinary markdown.\n');
	});
});

function createFixtureRoot(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'flue-vite-markdown-import-'));
}

function writeModule(root: string, relativePath: string, content: string): void {
	const absolutePath = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
	fs.writeFileSync(absolutePath, content);
}

async function buildFixture(root: string, includeSkillPlugin = false, alias: Record<string, string> = {}): Promise<string> {
	const outDir = path.join(root, 'dist');
	await viteBuild({
		configFile: false,
		root,
		logLevel: 'silent',
		resolve: { alias },
		plugins: [markdownImportPlugin(), ...(includeSkillPlugin ? [skillReferencePlugin({ root })] : [])],
		build: {
			outDir,
			emptyOutDir: true,
			minify: false,
			lib: {
				entry: path.join(root, 'src/entry.ts'),
				formats: ['es'],
				fileName: () => 'entry.mjs',
			},
		},
	});
	return path.join(outDir, 'entry.mjs');
}

async function importBuiltFixture(absolutePath: string): Promise<Record<string, string>> {
	return (await import(`${pathToFileURL(absolutePath).href}?time=${Date.now()}`)) as Record<string, string>;
}
