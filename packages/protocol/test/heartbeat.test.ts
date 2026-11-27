import { describe, expect, test } from "bun:test";
import { Heartbeat, PING_FRAME, PONG_FRAME } from "../src";

function make(timeoutMs = 25_000) {
	let now = 0;
	const sent: string[] = [];
	let dead = 0;
	const beat = new Heartbeat({
		send: f => sent.push(f),
		onDead: () => dead++,
		intervalMs: 10_000,
		timeoutMs,
		now: () => now,
	});
	return {
		beat,
		sent,
		advance: (ms: number) => {
			now += ms;
		},
		get dead() {
			return dead;
		},
	};
}

describe("heartbeat", () => {
	test("pings on every interval while the peer is heard from", () => {
		const t = make();
		for (let i = 0; i < 5; i++) {
			t.advance(10_000);
			t.beat.tick();
			t.beat.receive('{"t":"events"}'); // any frame proves the peer is alive
		}
		expect(t.sent).toEqual(Array(5).fill(PING_FRAME));
		expect(t.dead).toBe(0);
	});

	test("a ping is answered with a pong and consumed; a pong is consumed; other frames are not", () => {
		const t = make();
		expect(t.beat.receive(PING_FRAME)).toBe(true);
		expect(t.sent).toEqual([PONG_FRAME]);
		expect(t.beat.receive(PONG_FRAME)).toBe(true);
		expect(t.beat.receive('{"t":"ack"}')).toBe(false);
		expect(t.sent).toEqual([PONG_FRAME]);
	});

	test("silence longer than the timeout declares the link dead without pinging again", () => {
		const t = make(25_000);
		t.advance(10_000);
		t.beat.tick();
		t.advance(10_000);
		t.beat.tick();
		expect(t.dead).toBe(0); // 20 s of silence is within the timeout
		t.advance(10_000);
		t.beat.tick(); // 30 s
		expect(t.dead).toBe(1);
		expect(t.sent).toHaveLength(2); // no ping on the tick that gave up
	});

	test("hearing from the peer resets the silence clock", () => {
		const t = make(25_000);
		t.advance(20_000);
		t.beat.receive(PONG_FRAME);
		t.advance(20_000);
		t.beat.tick();
		expect(t.dead).toBe(0);
	});

	test("with real timers: start() pings on its interval and reports a silent peer; stop() ends it", async () => {
		const sent: string[] = [];
		const dead = Promise.withResolvers<void>();
		const beat = new Heartbeat({
			send: f => sent.push(f),
			onDead: () => dead.resolve(),
			intervalMs: 5,
			timeoutMs: 30,
		});
		beat.start();
		await dead.promise;
		expect(sent.length).toBeGreaterThan(0);
		const count = sent.length;
		beat.stop();
		await Bun.sleep(30); // negative: nothing is sent after stop
		expect(sent.length).toBe(count);
	});
});
