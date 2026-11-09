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
	delete childEnvironment.AGENT_SMITH_ADMIN_KEY;
	delete childEnvironment.AGENT_SMITH_PROXY_KEY;
	delete childEnvironment.ANTHROPIC_AUTH_TOKEN;

	return {
		...childEnvironment,
		ANTHROPIC_API_KEY: proxyKey,
		ANTHROPIC_BASE_URL: claudeProxyBaseUrl(port, usePool),
	};
}

export function requireProxyKey(proxyKey: string): string {
	if (!proxyKey) {
		throw new Error(
			"agent-smith run requires AGENT_SMITH_PROXY_KEY to authenticate its local proxy",
		);
	}
	return proxyKey;
}
