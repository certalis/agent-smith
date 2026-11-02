export function normalizeTrackedModel(model: unknown): string | undefined {
	if (typeof model !== "string") {
		return undefined;
	}

	const trimmed = model.trim();
	return trimmed || undefined;
}

const MODEL_FIELD_RE = /"model"\s*:\s*"([^"]+)"/;

export function extractTrackedModelFromRequestBody(
	encodedBody: string | null,
): string | undefined {
	if (!encodedBody) {
		return undefined;
	}

	try {
		// The model field is always near the start of the JSON object.
		// Decode only the first 700 base64 chars and extract via regex to avoid
		// a full JSON.parse of potentially multi-MB request bodies.
		const slice = encodedBody.slice(0, 700);
		const decoded = Buffer.from(slice, "base64").toString("utf-8");
		const match = decoded.match(MODEL_FIELD_RE);
		return match ? normalizeTrackedModel(match[1]) : undefined;
	} catch {
		return undefined;
	}
}
