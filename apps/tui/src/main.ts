#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { Config } from "@ccflare/config";
import { container, NETWORK, SERVICE_KEYS, shutdown } from "@ccflare/core";
import { DatabaseFactory } from "@ccflare/database";
import { Logger } from "@ccflare/logger";
import startServer, { type ServerHandle } from "@ccflare/runtime-server";
import type { AccountDisplay } from "@ccflare/ui";
import * as tuiCore from "./core";
import { parseArgs } from "./core";
import { POC_NOTICE } from "./poc-notice";

function printPocNotice() {
	console.error(`\n${POC_NOTICE}\n`);
}

// Global singleton for auto-started server
let runningServer: ServerHandle | null = null;

async function ensureServer(port: number) {
	if (!runningServer) {
		runningServer = startServer({ port, withDashboard: true });
	}
	return runningServer;
}

function runClaude(
	args: string[],
	environment: NodeJS.ProcessEnv,
): Promise<number> {
	const child = spawn("claude", args, {
		env: environment,
		stdio: "inherit",
	});

	return new Promise((resolve, reject) => {
		child.once("error", () => {
			reject(new Error("Claude Code was not found in PATH"));
		});
		child.once("exit", (code) => {
			resolve(code ?? 1);
		});
	});
}

function printAccountsTable(accounts: AccountDisplay[]) {
	const header =
		"Name".padEnd(20) +
		"Provider".padEnd(14) +
		"Auth Method".padEnd(14) +
		"Weight".padEnd(8) +
		"Status";
	const separator = "─".repeat(header.length);

	console.log("\nAccounts:");
	console.log(header);
	console.log(separator);
	for (const account of accounts) {
		console.log(
			account.name.padEnd(20) +
				account.provider.padEnd(14) +
				account.auth_method.padEnd(14) +
				account.weightDisplay.padEnd(8) +
				account.rateLimitStatus,
		);
	}
}

async function main() {
	// Initialize DI container and services
	container.registerInstance(SERVICE_KEYS.Config, new Config());
	container.registerInstance(SERVICE_KEYS.Logger, new Logger("TUI"));

	// Initialize database factory
	DatabaseFactory.initialize();
	const dbOps = DatabaseFactory.getInstance();
	container.registerInstance(SERVICE_KEYS.Database, dbOps);

	const args = process.argv.slice(2);
	const parsed = parseArgs(args);

	// Handle help
	if (parsed.help) {
		console.log(`
🎯 agent-smith - Local proxy and provider pool for Claude Code and Codex

${POC_NOTICE}

Usage: agent-smith [options]
       agent-smith run [--port <number>] -- [claude arguments]
       agent-smith install-client

Options:
  --serve              Start API server with dashboard
  --port <number>      Server port (default: 8080, or PORT env var)
  --logs [N]           Stream latest N lines then follow
  --stats              Show statistics (JSON output)
  --add-account <name> Add a new account
    --provider <anthropic|openai|claude-code|codex>  Account provider (required)
  --list               List all accounts
  --remove <name>      Remove an account
  --pause <name>       Pause an account
  --resume <name>      Resume an account
  --analyze            Analyze database performance
  --reset-stats        Reset usage statistics
  --clear-history      Clear request history
  --theme <name>       Set color theme (e.g. tokyo-night, catppuccin-mocha)
  --help, -h           Show this help message

Interactive Mode:
  agent-smith      Launch interactive TUI (default)

Examples:
  agent-smith                    # Interactive mode
  agent-smith --serve            # Start server
  agent-smith --add-account work --provider anthropic      # Add Anthropic API key account
  agent-smith --add-account team --provider openai         # Add OpenAI API key account
  agent-smith --pause work       # Pause account
  agent-smith --analyze          # Run performance analysis
  agent-smith --stats            # View stats
  agent-smith install-client     # Configure Claude Code and Codex for this Agent-smith server
`);
		process.exit(0);
	}

	// Handle non-interactive commands
	if (parsed.serve) {
		printPocNotice();
		const config = new Config();
		const port =
			parsed.port || config.getRuntime().port || NETWORK.DEFAULT_PORT;
		startServer({ port, withDashboard: true });
		// Keep process alive
		await new Promise(() => {});
		return;
	}

	if (parsed.installClient) {
		const config = new Config();
		const client = config.getClientRouting();
		if (!client.baseUrl || !client.proxyKeyFile) {
			throw new Error(
				"client.base_url and client.proxy_key_file are required before installing client wrappers",
			);
		}
		const port = config.getRuntime().port || NETWORK.DEFAULT_PORT;
		await tuiCore.enableLocalClientRouting({
			port,
			baseUrl: client.baseUrl,
			proxyKeyFile: client.proxyKeyFile,
		});
		console.log(`Claude Code and Codex now route through ${client.baseUrl}`);
		return;
	}

	if (parsed.run) {
		printPocNotice();
		const config = new Config();
		const port =
			parsed.port || config.getRuntime().port || NETWORK.DEFAULT_PORT;
		const proxyKey = tuiCore.requireProxyKey(process.env.CF_PROXY_KEY ?? "");
		const proxyServer = startServer({ port, withDashboard: false });
		let exitCode: number;
		try {
			exitCode = await runClaude(
				parsed.run,
				tuiCore.claudeRunEnvironment(
					proxyServer.port,
					proxyKey,
					process.env,
					config.getProviderPool("anthropic-messages").length > 0,
				),
			);
		} finally {
			await proxyServer.stop();
		}
		process.exit(exitCode);
	}

	if (parsed.logs !== undefined) {
		const limit = typeof parsed.logs === "number" ? parsed.logs : 100;

		// First print historical logs if limit was specified
		if (typeof parsed.logs === "number") {
			const history = await tuiCore.getLogHistory(limit);
			for (const log of history) {
				console.log(`[${log.level}] ${log.msg}`);
			}
			console.log("--- Live logs ---");
		}

		// Then stream live logs
		await tuiCore.streamLogs((log) => {
			console.log(`[${log.level}] ${log.msg}`);
		});
		return;
	}

	if (parsed.stats) {
		const stats = await tuiCore.getStats();
		console.log(JSON.stringify(stats, null, 2));
		return;
	}

	if (parsed.addAccount) {
		if (!parsed.provider) {
			console.error(
				"Error: Provider is required. Use --provider with an enabled configured provider.",
			);
			process.exit(1);
		}

		printPocNotice();
		await tuiCore.addAccount({
			name: parsed.addAccount,
			provider: parsed.provider,
		});
		console.log(`✅ Account "${parsed.addAccount}" added successfully`);
		return;
	}

	if (parsed.list) {
		const accounts = await tuiCore.getAccounts();
		if (accounts.length === 0) {
			console.log("No accounts configured");
		} else {
			printAccountsTable(accounts);
		}
		return;
	}

	if (parsed.remove) {
		await tuiCore.removeAccount(parsed.remove);
		console.log(`✅ Account "${parsed.remove}" removed successfully`);
		return;
	}

	if (parsed.resetStats) {
		await tuiCore.resetStats();
		console.log("✅ Statistics reset successfully");
		return;
	}

	if (parsed.clearHistory) {
		await tuiCore.clearHistory();
		console.log("✅ Request history cleared successfully");
		return;
	}

	if (parsed.pause) {
		const result = await tuiCore.pauseAccount(parsed.pause);
		console.log(result.message);
		if (!result.success) {
			process.exit(1);
		}
		return;
	}

	if (parsed.resume) {
		const result = await tuiCore.resumeAccount(parsed.resume);
		console.log(result.message);
		if (!result.success) {
			process.exit(1);
		}
		return;
	}

	if (parsed.analyze) {
		await tuiCore.analyzePerformance();
		return;
	}

	// Default: Launch interactive TUI with auto-started server
	printPocNotice();
	const config = new Config();
	const port = parsed.port || config.getRuntime().port || NETWORK.DEFAULT_PORT;

	// Apply theme from CLI flag (overrides persisted config)
	if (parsed.theme) {
		const { setTuiTheme } = await import("./theme.ts");
		setTuiTheme(parsed.theme);
	}

	await ensureServer(port);

	const { createCliRenderer } = await import("@opentui/core");
	const { createRoot } = await import("@opentui/react");
	const { App } = await import("./App.tsx");
	const { createElement } = await import("react");

	const renderer = await createCliRenderer({ exitOnCtrlC: false });

	const handleQuit = async () => {
		renderer.destroy();
		if (runningServer) {
			try {
				await runningServer.stop();
			} catch {}
		}
		try {
			await shutdown();
		} catch {}
		process.exit(0);
	};

	createRoot(renderer).render(createElement(App, { port, onQuit: handleQuit }));
}

// Run main and handle errors
main().catch(async (error) => {
	console.error("Error:", error.message);
	try {
		await shutdown();
	} catch (shutdownError) {
		console.error("Error during shutdown:", shutdownError);
	}
	process.exit(1);
});

// Handle process termination (for non-TUI mode)
process.on("SIGINT", async () => {
	try {
		await shutdown();
	} catch (error) {
		console.error("Error during shutdown:", error);
	}
	process.exit(0);
});

process.on("SIGTERM", async () => {
	try {
		await shutdown();
	} catch (error) {
		console.error("Error during shutdown:", error);
	}
	process.exit(0);
});
