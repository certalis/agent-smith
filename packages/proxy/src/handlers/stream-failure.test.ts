import { describe, expect, it } from "bun:test";
import { inspectStreamHead } from "./stream-failure";

const encoder = new TextEncoder();

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

describe("inspectStreamHead", () => {
	it("stops inspecting a stream when the ten-second head deadline elapses", async () => {
		const timeouts: number[] = [];
		const response = new Response(
			new ReadableStream<Uint8Array>({ start: () => undefined }),
		);

		const inspection = await inspectStreamHead(response, true, {
			sleep: async (milliseconds) => {
				timeouts.push(milliseconds);
			},
		});

		expect(inspection.failure).toBeFalse();
		expect(timeouts).toEqual([10_000]);
		await inspection.response.body?.cancel();
	});

	it("provides a way to discard a replayable failure stream before a sibling hop", async () => {
		let cancelReason: unknown;
		const response = new Response(
			new ReadableStream<Uint8Array>({
				cancel(reason) {
					cancelReason = reason;
				},
				start(controller) {
					controller.enqueue(
						encoder.encode(
							'event: error\ndata: {"error":{"type":"overloaded_error"}}\n\n',
						),
					);
				},
			}),
		);

		const inspection = await inspectStreamHead(response, true);

		expect(inspection.failure).toBeTrue();
		await inspection.discard?.();
		expect(cancelReason).toBe("retrying on a sibling account");
	});

	it("replays a Responses stream once its created event confirms normal output", async () => {
		let releaseDeadline: (() => void) | undefined;
		const deadline = new Promise<undefined>((resolve) => {
			releaseDeadline = () => resolve(undefined);
		});
		const response = new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(
						encoder.encode(
							'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
						),
					);
				},
			}),
		);

		let inspection: Awaited<ReturnType<typeof inspectStreamHead>> | undefined;
		const inspectionPromise = inspectStreamHead(response, true, {
			sleep: () => deadline,
		}).then((value) => {
			inspection = value;
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		const observedInspection = inspection;
		releaseDeadline?.();
		await inspectionPromise;
		await inspection?.response.body?.cancel();
		expect(observedInspection?.failure).toBeFalse();
	});

	it("replays exactly the bounded head when it reaches the byte limit", async () => {
		const response = new Response(streamFrom(["ab", "cd", "ef"]));

		const inspection = await inspectStreamHead(response, true, { maxBytes: 4 });

		expect(await inspection.response.text()).toBe("abcdef");
	});

	it("does not inspect an overload beyond the byte bound of one chunk", async () => {
		const overload =
			'event: error\ndata: {"error":{"type":"overloaded_error"}}\n\n';
		const response = new Response(streamFrom([`abcd${overload}`]));

		const inspection = await inspectStreamHead(response, true, { maxBytes: 4 });

		expect(inspection.failure).toBeFalse();
		expect(await inspection.response.text()).toBe(`abcd${overload}`);
	});
});
