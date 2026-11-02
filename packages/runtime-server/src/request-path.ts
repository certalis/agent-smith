function decodeSegment(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

/**
 * Detect path segments which an HTTP URL parser can turn into traversal after
 * the request has already been classified by its original spelling.
 */
export function hasDotSegment(pathname: string): boolean {
	return pathname
		.split("/")
		.flatMap((segment) =>
			decodeSegment(segment).replaceAll("\\", "/").split("/"),
		)
		.some((segment) => segment === "." || segment === "..");
}
