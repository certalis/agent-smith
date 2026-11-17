import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import {
	Config,
	readClientRouting,
	resolveConfigPath,
} from "@agent-smith/config";
import {
	configClientWrappersInstalled,
	enableLocalClientRouting,
	getLocalRoutingStatus,
	validateProxyKeyFile,
} from "./local-routing";

export async function runClientCommand(argv: string[]): Promise<void> {
	const { positionals, values } = parseArgs({
		args: argv,
		options: { raw: { type: "boolean" } },
		allowPositionals: true,
		strict: true,
	});
	const [command] = positionals;
	if (
		positionals.length !== 1 ||
		!["on", "off", "status"].includes(command ?? "")
	)
		throw new Error("usage: agent-smith client on|off|status [--raw]");
	const configPath = resolveConfigPath();
	const client = existsSync(configPath)
		? readClientRouting(configPath)
		: { enabled: false };
	let installed = configClientWrappersInstalled();
	if (command !== "status") {
		const enabled = command === "on";
		if (enabled) {
			if (!client.baseUrl || !client.proxyKeyFile)
				throw new Error(
					"Set client.base_url and client.proxy_key_file before enabling the pool",
				);
			validateProxyKeyFile(client.proxyKeyFile);
		}
		if (!installed && (enabled || getLocalRoutingStatus().enabled)) {
			await enableLocalClientRouting({
				port: 8080,
				clientConfigPath: configPath,
			});
			installed = true;
		}
		new Config(configPath).setClientRoutingEnabled(enabled);
		client.enabled = enabled;
	}
	const status = {
		enabled: client.enabled,
		installed,
		...(client.baseUrl && { baseUrl: client.baseUrl }),
		...(client.usageLabel && { usageLabel: client.usageLabel }),
	};
	if (values.raw) console.log(JSON.stringify(status));
	else {
		console.log(`Shared pool: ${status.enabled ? "on" : "off"}`);
		if (status.usageLabel)
			console.log(`Usage label: ${status.usageLabel} (self-reported)`);
		console.log(
			`Launchers: ${installed ? "installed" : "not configured; use client on to set up"}`,
		);
		if (command !== "status")
			console.log(
				"Restart existing Claude/Codex sessions to use this setting. After first setup, open a new terminal.",
			);
	}
}
