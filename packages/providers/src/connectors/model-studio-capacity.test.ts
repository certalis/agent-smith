import { expect, test } from "bun:test";
import { classifyModelStudioCapacityBlock } from "./model-studio-capacity";

test("keeps Model Studio capacity parsing in the connector layer", async () => {
	const response = new Response(
		JSON.stringify({ code: "Throttling.AllocationQuota" }),
		{ headers: { "content-type": "application/json" }, status: 429 },
	);

	expect(await classifyModelStudioCapacityBlock(response, 0)).toEqual({
		category: "token-allocation",
	});
});
