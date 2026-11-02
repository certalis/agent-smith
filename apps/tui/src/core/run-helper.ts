export function claudeProxyBaseUrl(
	port: number,
	usePool: boolean = false,
): string {
	return usePool
		? `http://127.0.0.1:${port}/v1/pool/anthropic-messages`
		: `http://127.0.0.1:${port}/v1/claude-code`;
}

export function claudeRunEnvironment(
	port: number,
	proxyKey: string,
	environment: NodeJS.ProcessEnv = process.env,
	usePool: boolean = false,
): NodeJS.ProcessEnv {
	const childEnvironment = { ...environment };
	delete childEnvironment.CF_ADMIN_KEY;
	delete childEnvironment.CF_PROXY_KEY;

	return {
		...childEnvironment,
		ANTHROPIC_API_KEY: proxyKey,
		ANTHROPIC_AUTH_TOKEN: proxyKey,
		ANTHROPIC_BASE_URL: claudeProxyBaseUrl(port, usePool),
	};
}

export function requireProxyKey(proxyKey: string): string {
	if (!proxyKey) {
		throw new Error(
			"ccflare run requires CF_PROXY_KEY to authenticate its local proxy",
		);
	}
	return proxyKey;
}
