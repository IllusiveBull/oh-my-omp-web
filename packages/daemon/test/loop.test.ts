import { describe, expect, test } from "bun:test";
import type { LoopConditionVerdict } from "@oh-my-pi/pi-coding-agent/modes/loop-condition";
import type { LoopWire } from "@omp-web/protocol";
import { type LoopHost, LoopMode } from "../src/loop";

function harness(verdicts: LoopConditionVerdict[] = []) {
	const submitted: string[] = [];
	const notices: string[] = [];
	const states: (LoopWire | undefined)[] = [];
	const conditions: string[] = [];
	let busy = false;
	const host: LoopHost = {
		cwd: "/w",
		sessionId: () => "s1",
		isBusy: async () => busy,
		submit: async prompt => {
			submitted.push(prompt);
		},
		notify: (_level, message) => notices.push(message),
		changed: loop => states.push(loop),
	};
	const loop = new LoopMode(host, {
		delayMs: 0,
		evaluate: async condition => {
			conditions.push(condition.command);
			return verdicts.shift() ?? { kind: "continue" };
		},
	});
	/** One settle and the iteration it schedules. */
	const settle = (): Promise<void> => loop.settled();
	return {
		loop,
		submitted,
		notices,
		states,
		conditions,
		settle,
		setBusy: (value: boolean) => {
			busy = value;
		},
	};
}

describe("loop mode run by the daemon", () => {
	test("an inline prompt repeats after each settled run until the count runs out", async () => {
		const h = harness();
		const prompt = h.loop.toggle("2 fix the failing tests");
		expect(prompt).toBe("fix the failing tests");
		expect(h.loop.wire).toEqual({ state: "waiting", limit: { kind: "iterations", remaining: 2, initial: 2 } });
		h.loop.recordPrompt(prompt!); // the session sent it: the first run
		expect(h.loop.wire?.state).toBe("running");

		await h.settle();
		await h.settle();
		expect(h.submitted).toEqual(["fix the failing tests", "fix the failing tests"]);
		await h.settle();
		expect(h.submitted).toHaveLength(2);
		expect(h.loop.enabled).toBe(false);
		expect(h.notices.at(-1)).toBe("Loop limit reached. Loop mode disabled.");
		expect(h.states.at(-1)).toBeUndefined();
	});

	test("without a prompt it waits for the next one sent; a stop pauses it and the next prompt resumes it", async () => {
		const h = harness();
		expect(h.loop.toggle("")).toBeUndefined();
		await h.settle(); // nothing to repeat yet
		expect(h.submitted).toEqual([]);

		h.loop.recordPrompt("one");
		h.loop.pause();
		expect(h.loop.wire).toEqual({ state: "paused" });
		await h.settle();
		expect(h.submitted).toEqual([]);

		h.loop.recordPrompt("two");
		await h.settle();
		expect(h.submitted).toEqual(["two"]);
	});

	test("a settle scheduled before a stop does not fire after it", async () => {
		const submitted: string[] = [];
		const loop = new LoopMode(
			{
				cwd: "/w",
				sessionId: () => "s1",
				isBusy: async () => false,
				submit: async prompt => {
					submitted.push(prompt);
				},
				notify: () => {},
				changed: () => {},
			},
			{ delayMs: 20 },
		);
		loop.toggle("again");
		loop.recordPrompt("again");
		const iteration = loop.settled();
		loop.pause();
		await iteration;
		expect(submitted).toEqual([]);
	});

	test("a busy session (another client's prompt) is not sent the loop prompt", async () => {
		const h = harness();
		h.loop.toggle("go");
		h.loop.recordPrompt("go");
		h.setBusy(true);
		await h.settle();
		expect(h.submitted).toEqual([]);
		h.setBusy(false);
		await h.settle();
		expect(h.submitted).toEqual(["go"]);
	});

	test("--until runs its command before each repeat and stops the loop once it is satisfied", async () => {
		const h = harness([
			{ kind: "continue" },
			{ kind: "halt", message: "Loop condition `bun test` is now satisfied. Loop mode disabled." },
		]);
		h.loop.toggle("--until 'bun test' fix it");
		expect(h.loop.wire?.condition).toEqual({ command: "bun test", until: true });
		h.loop.recordPrompt("fix it");
		await h.settle();
		await h.settle();
		expect(h.conditions).toEqual(["bun test", "bun test"]);
		expect(h.submitted).toEqual(["fix it"]);
		expect(h.loop.enabled).toBe(false);
		expect(h.notices.at(-1)).toBe("Loop condition `bun test` is now satisfied. Loop mode disabled.");
	});

	test("/loop again turns it off; arguments omp cannot parse are refused with its usage", () => {
		const h = harness();
		expect(() => h.loop.toggle("10x")).toThrow("Loop duration unit must be seconds, minutes, or hours.");
		expect(h.loop.enabled).toBe(false);
		h.loop.toggle("5m");
		expect(h.loop.enabled).toBe(true);
		h.loop.toggle("ignored");
		expect(h.loop.enabled).toBe(false);
		expect(h.notices.at(-1)).toBe("Loop mode disabled.");
	});
});
