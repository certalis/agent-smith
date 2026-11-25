import { describe, expect, it } from "bun:test";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
	collectSourceFiles,
	extractImports,
	getAgentSmithDependencies,
	getWorkspaceManifests,
	REPO_ROOT,
	type Workspace,
} from "./test-helpers/workspace";

function findImportViolations(
	workspaceRoot: string,
	isViolation: (specifier: string, sourceFile: string) => boolean,
): string[] {
	const violations: string[] = [];

	for (const sourceFile of collectSourceFiles(workspaceRoot)) {
		for (const specifier of extractImports(sourceFile)) {
			if (isViolation(specifier, sourceFile)) {
				violations.push(
					`${relative(REPO_ROOT, sourceFile)} imports ${specifier}`,
				);
			}
		}
	}

	return violations.sort();
}

function violatesPackageBoundary(
	specifier: string,
	sourceFile: string,
	forbidden: string[],
): boolean {
	return forbidden.some((entry) => {
		if (specifier === entry || specifier.startsWith(`${entry}/`)) return true;
		if (!specifier.startsWith(".")) return false;
		const target = resolve(dirname(sourceFile), specifier);
		const forbiddenRoot = join(
			REPO_ROOT,
			"packages",
			entry.slice("@agent-smith/".length),
		);
		return (
			target === forbiddenRoot || target.startsWith(`${forbiddenRoot}${sep}`)
		);
	});
}

function findWorkspaceCycles(workspaces: Workspace[]): string[] {
	const workspaceNames = new Set(
		workspaces.map(({ manifest }) => manifest.name),
	);
	const graph = new Map<string, string[]>();

	for (const { manifest } of workspaces) {
		const dependencies = getAgentSmithDependencies(manifest).filter(
			(dependency) => workspaceNames.has(dependency),
		);
		graph.set(manifest.name, dependencies);
	}

	const visited = new Set<string>();
	const inStack = new Set<string>();
	const path: string[] = [];
	const cycles = new Set<string>();

	function visit(node: string) {
		visited.add(node);
		inStack.add(node);
		path.push(node);

		for (const dependency of graph.get(node) ?? []) {
			if (!visited.has(dependency)) {
				visit(dependency);
				continue;
			}

			if (inStack.has(dependency)) {
				const cycleStart = path.indexOf(dependency);
				const cycle = [...path.slice(cycleStart), dependency].join(" -> ");
				cycles.add(cycle);
			}
		}

		path.pop();
		inStack.delete(node);
	}

	for (const node of graph.keys()) {
		if (!visited.has(node)) {
			visit(node);
		}
	}

	return [...cycles].sort();
}

describe("workspace package boundaries", () => {
	it("keeps workspace dependency edges acyclic", () => {
		expect(findWorkspaceCycles(getWorkspaceManifests())).toEqual([]);
	});

	it("keeps leaf workspaces free of @agent-smith dependencies", () => {
		const leafWorkspaceNames = new Set(["@agent-smith/types"]);
		const violations: string[] = [];

		for (const workspace of getWorkspaceManifests()) {
			if (!leafWorkspaceNames.has(workspace.manifest.name)) {
				continue;
			}

			const manifestDependencies = getAgentSmithDependencies(
				workspace.manifest,
			);
			if (manifestDependencies.length > 0) {
				violations.push(
					`${relative(REPO_ROOT, workspace.manifestPath)} declares ${manifestDependencies.join(", ")}`,
				);
			}

			violations.push(
				...findImportViolations(workspace.root, (specifier) =>
					specifier.startsWith("@agent-smith/"),
				),
			);
		}

		expect(violations).toEqual([]);
	});

	it("blocks the audited layer violations", () => {
		const workspaces = getWorkspaceManifests();
		const workspaceByName = new Map(
			workspaces.map((workspace) => [workspace.manifest.name, workspace]),
		);
		const violations = [
			...findImportViolations(
				workspaceByName.get("@agent-smith/proxy")?.root ??
					join(REPO_ROOT, "packages/proxy"),
				(specifier) => specifier === "@agent-smith/ui",
			),
			...findImportViolations(
				workspaceByName.get("@agent-smith/types")?.root ??
					join(REPO_ROOT, "packages/types"),
				(specifier) =>
					specifier === "@agent-smith/config" ||
					specifier === "@agent-smith/database",
			),
			...findImportViolations(
				workspaceByName.get("agent-smith")?.root ?? join(REPO_ROOT, "apps/tui"),
				(specifier) => specifier === "@agent-smith/server",
			),
		];

		expect(violations.sort()).toEqual([]);
	});

	it("keeps routing and pool dependencies pointed toward the provider interface", () => {
		const workspaces = getWorkspaceManifests();
		const workspaceByName = new Map(
			workspaces.map((workspace) => [workspace.manifest.name, workspace]),
		);
		const restrictions = [
			{
				name: "@agent-smith/routing",
				forbidden: [
					"@agent-smith/pool",
					"@agent-smith/database",
					"@agent-smith/providers",
					"@agent-smith/proxy",
				],
			},
			{
				name: "@agent-smith/pool",
				forbidden: ["@agent-smith/routing", "@agent-smith/proxy"],
			},
		];
		const violations: string[] = [];
		for (const { name, forbidden } of restrictions) {
			const workspace = workspaceByName.get(name);
			if (!workspace) continue;
			const isForbidden = (specifier: string, sourceFile: string) =>
				violatesPackageBoundary(specifier, sourceFile, forbidden);
			violations.push(
				...getAgentSmithDependencies(workspace.manifest)
					.filter((dependency) =>
						isForbidden(dependency, workspace.manifestPath),
					)
					.map((dependency) => `${name} declares ${dependency}`),
			);
			violations.push(...findImportViolations(workspace.root, isForbidden));
		}
		expect(violations.sort()).toEqual([]);
	});

	it("detects package subpaths and relative imports across a forbidden boundary", () => {
		const sourceFile = join(REPO_ROOT, "packages/routing/src/route.ts");
		const forbidden = ["@agent-smith/pool"];
		expect(
			violatesPackageBoundary(
				"@agent-smith/pool/internal",
				sourceFile,
				forbidden,
			),
		).toBe(true);
		expect(
			violatesPackageBoundary("../../pool/src/internal", sourceFile, forbidden),
		).toBe(true);
		expect(violatesPackageBoundary("./local", sourceFile, forbidden)).toBe(
			false,
		);
	});
});
