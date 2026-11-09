type Resource = { stop(): void | Promise<void> } | undefined;

export async function stopAll(resources: Resource[]): Promise<void> {
	const results = await Promise.allSettled(
		resources.map((resource) => Promise.resolve().then(() => resource?.stop())),
	);
	const errors = results.flatMap((result) =>
		result.status === "rejected" ? [result.reason] : [],
	);
	if (errors.length)
		throw new AggregateError(errors, "Scenario resource cleanup failed");
}
