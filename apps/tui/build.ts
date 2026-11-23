#!/usr/bin/env bun
import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

// Runtime dependencies stay in node_modules; workspace packages are bundled in.
const EXTERNAL = [
	"@dqbd/tiktoken",
	"@opentui/core",
	"@opentui/react",
	"@opentui/react/*",
	"open",
	"react",
	"react/*",
];

const tuiDir = import.meta.dir;
const distDir = join(tuiDir, "dist");
const webDir = join(tuiDir, "../web");

await rm(distDir, { recursive: true, force: true });

const web = Bun.spawnSync(["bun", "run", "build"], {
	cwd: webDir,
	stdio: ["inherit", "inherit", "inherit"],
});
if (web.exitCode !== 0) {
	process.exit(web.exitCode ?? 1);
}

const result = await Bun.build({
	entrypoints: [
		join(tuiDir, "src/bin.ts"),
		join(tuiDir, "src/server.ts"),
		join(tuiDir, "src/pool.ts"),
		join(tuiDir, "src/pool-status.ts"),
		join(tuiDir, "src/core/client-launcher.ts"),
		join(tuiDir, "../../packages/proxy/src/post-processor.worker.ts"),
	],
	outdir: distDir,
	target: "bun",
	external: EXTERNAL,
	naming: "[name].[ext]",
	define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!result.success) {
	for (const log of result.logs) {
		console.error(log);
	}
	process.exit(1);
}

const edge = await Bun.build({
	entrypoints: [join(tuiDir, "src/edge.ts"), join(tuiDir, "src/https.ts")],
	outdir: distDir,
	target: "node",
});
if (!edge.success) throw new Error("Failed to build the HTTP proxy edge");

await cp(join(webDir, "dist"), join(distDir, "dashboard"), { recursive: true });
const claudeCompanionDir = join(tuiDir, "src", "claude-companion");
const bundledClaudeCompanionDir = join(distDir, "claude-companion");
await Promise.all([
	mkdir(join(bundledClaudeCompanionDir, ".claude-plugin"), {
		recursive: true,
	}),
	mkdir(join(bundledClaudeCompanionDir, "hooks"), { recursive: true }),
]);
await Promise.all([
	cp(
		join(claudeCompanionDir, ".claude-plugin", "plugin.json"),
		join(bundledClaudeCompanionDir, ".claude-plugin", "plugin.json"),
	),
	cp(
		join(claudeCompanionDir, "hooks", "hooks.json"),
		join(bundledClaudeCompanionDir, "hooks", "hooks.json"),
	),
	cp(
		join(claudeCompanionDir, "hooks", "provider-choice.js"),
		join(bundledClaudeCompanionDir, "hooks", "provider-choice.js"),
	),
	cp(
		join(claudeCompanionDir, "hooks", "register.js"),
		join(bundledClaudeCompanionDir, "hooks", "register.js"),
	),
]);
await chmod(join(distDir, "bin.js"), 0o755);

// npm only packs a README and LICENSE that sit in the package directory.
for (const file of ["README.md", "LICENSE"]) {
	await cp(join(tuiDir, "../..", file), join(tuiDir, file));
}

console.log(`Built ${join(distDir, "bin.js")}`);
