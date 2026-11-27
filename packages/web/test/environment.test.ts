import type { WorktreeInfo } from "@omp-web/protocol";
import { describe, expect, test } from "bun:test";
import { ackedProject, ackedSessionId } from "../src/lib/ack";
import {
	EMPTY_SELECTION,
	displayPath,
	loadSelection,
	newSessionTarget,
	resolveSelection,
	saveSelection,
	scopeSessions,
	selectMachine,
	selectProject,
	worktreeLabel,
} from "../src/lib/environment";
import { parseSessionHash, sessionHash } from "../src/lib/route";
import { gatewaySession, machineSummary, project, worktree } from "./fixtures";

describe("displayPath", () => {
	test("uses only the source machine's known home and respects POSIX boundaries and case", () => {
		const mac = { platform: "darwin", home: "/Users/Alice/" };
		expect(displayPath("/Users/Alice", mac)).toBe("~");
		expect(displayPath("/Users/Alice/dev/repo", mac)).toBe("~/dev/repo");
		expect(displayPath("/Users/Alice2/dev", mac)).toBe("/Users/Alice2/dev");
		expect(displayPath("/users/Alice/dev", mac)).toBe("/users/Alice/dev");
		expect(displayPath("/Users/Alice\\dev", mac)).toBe("/Users/Alice\\dev");
		expect(displayPath("/Users/Alice/dev", undefined)).toBe("/Users/Alice/dev");
		expect(displayPath("/Users/Alice/dev", { platform: "darwin", home: "/Users/Bob" })).toBe("/Users/Alice/dev");
		expect(displayPath("/work", { platform: "linux", home: "/" })).toBe("~/work");
	});
	test("matches Windows drive paths case-insensitively across separators, without matching siblings", () => {
		const win = { platform: "win32", home: "C:\\Users\\Alice\\" };
		expect(displayPath("c:/users/ALICE/", win)).toBe("~");
		expect(displayPath("c:\\users\\alice\\dev\\repo", win)).toBe("~/dev/repo");
		expect(displayPath("C:\\Users\\Alice2\\repo", win)).toBe("C:\\Users\\Alice2\\repo");
		expect(displayPath("D:\\Users\\Alice\\repo", win)).toBe("D:\\Users\\Alice\\repo");
		expect(displayPath("C:\\repo", { platform: "win32", home: "C:\\" })).toBe("~/repo");
	});
});

describe("scopeSessions", () => {
	const inMain = gatewaySession({ id: "main", projectRoot: "/p/app", worktreeRoot: "/p/app" });
	const inFeature = gatewaySession({ id: "feature", projectRoot: "/p/app", worktreeRoot: "/wt/app-feature" });
	const other = gatewaySession({ id: "other", projectRoot: "/p/application", worktreeRoot: "/p/application" });
	const outside = gatewaySession({ id: "outside" });
	const all = [inMain, inFeature, other, outside];
	const ids = (sessions: readonly { id: string }[]): string[] => sessions.map(s => s.id);

	test("all projects shows every session of the machine, including those outside every project", () => {
		expect(ids(scopeSessions(all, "", ""))).toEqual(["main", "feature", "other", "outside"]);
	});

	test("a project shows the sessions of all its worktrees, matching the root exactly", () => {
		expect(ids(scopeSessions(all, "/p/app", ""))).toEqual(["main", "feature"]);
	});

	test("a worktree narrows the project's sessions", () => {
		expect(ids(scopeSessions(all, "/p/app", "/wt/app-feature"))).toEqual(["feature"]);
		expect(ids(scopeSessions(all, "/p/app", "/p/app"))).toEqual(["main"]);
		expect(scopeSessions(all, "/p/gone", "")).toEqual([]);
	});
});

describe("resolveSelection", () => {
	const app = project("/p/app", [worktree("/p/app", { main: true }), worktree("/wt/app-x", { branch: "x" })]);
	const solo = project("/p/solo");
	const home = machineSummary({ id: "home", gateway: true, projects: [app, project("/p/other")] });
	const laptop = machineSummary({ id: "laptop", projects: [solo] });
	const machines = [laptop, home];

	test("starts on the gateway's own machine, falling back to the first one", () => {
		expect(resolveSelection(machines, null, "home").machine).toBe("home");
		expect(resolveSelection(machines, null, "unknown").machine).toBe("laptop");
		expect(resolveSelection(machines, null, null).machine).toBe("laptop");
		expect(resolveSelection([], null, "home")).toEqual(EMPTY_SELECTION);
	});

	test("a lone project and its lone worktree are preselected; several are not", () => {
		expect(resolveSelection(machines, { machine: "laptop", project: "", worktree: "" }, null)).toEqual({
			machine: "laptop",
			project: "",
			worktree: "",
		}); // the user chose "all projects" explicitly
		expect(resolveSelection(machines, null, "laptop")).toEqual({
			machine: "laptop",
			project: "/p/solo",
			worktree: "/p/solo",
		});
		expect(resolveSelection(machines, null, "home")).toEqual({ machine: "home", project: "", worktree: "" });
	});

	test("a valid stored choice is kept", () => {
		const stored = { machine: "home", project: "/p/app", worktree: "/wt/app-x" };
		expect(resolveSelection(machines, stored, "laptop")).toEqual(stored);
	});

	test("a vanished machine falls back to the gateway's, with that machine's defaults", () => {
		const stored = { machine: "gone", project: "/p/app", worktree: "/wt/app-x" };
		expect(resolveSelection(machines, stored, "home")).toEqual({ machine: "home", project: "", worktree: "" });
	});

	test("a vanished project or worktree falls back to the defaults of what is left", () => {
		expect(resolveSelection(machines, { machine: "laptop", project: "/p/gone", worktree: "/x" }, null)).toEqual({
			machine: "laptop",
			project: "/p/solo",
			worktree: "/p/solo",
		});
		expect(resolveSelection(machines, { machine: "home", project: "/p/app", worktree: "/wt/gone" }, null)).toEqual({
			machine: "home",
			project: "/p/app",
			worktree: "",
		});
	});

	test("the stored choice is kept for a machine that is offline (its cached projects still count)", () => {
		const offline = [{ ...home, online: false }];
		const stored = { machine: "home", project: "/p/app", worktree: "/p/app" };
		expect(resolveSelection(offline, stored, null)).toEqual(stored);
	});
});

describe("selecting", () => {
	const app = project("/p/app", [worktree("/p/app"), worktree("/wt/x")]);
	test("a machine starts from its defaults, a project brings its single worktree along", () => {
		expect(selectMachine(machineSummary({ id: "m", projects: [app] }))).toEqual({
			machine: "m",
			project: "/p/app",
			worktree: "",
		});
		expect(selectMachine(machineSummary({ id: "m", projects: [project("/p/a"), app] }))).toEqual({
			machine: "m",
			project: "",
			worktree: "",
		});
		expect(selectProject("m", project("/p/solo"))).toEqual({ machine: "m", project: "/p/solo", worktree: "/p/solo" });
		expect(selectProject("m", null)).toEqual({ machine: "m", project: "", worktree: "" });
	});

	test("switching machines keeps the same repository (by root commit, at another path) and the worktree's branch", () => {
		const repo = (root: string, worktrees: WorktreeInfo[]) => ({ ...project(root, worktrees), id: "c0ffee" });
		const desk = machineSummary({
			id: "desk",
			projects: [repo("/d/app", [worktree("/d/app", { main: true }), worktree("/d/wt-x", { branch: "x" })])],
		});
		const lap = machineSummary({
			id: "lap",
			projects: [
				project("/l/other"),
				repo("/l/code/app", [worktree("/l/code/app", { main: true }), worktree("/l/wt/x", { branch: "x" })]),
			],
		});
		const from = (worktree: string) => ({
			machine: desk,
			selection: { machine: "desk", project: "/d/app", worktree },
		});
		expect(selectMachine(lap, from("/d/wt-x"))).toEqual({
			machine: "lap",
			project: "/l/code/app",
			worktree: "/l/wt/x",
		});
		expect(selectMachine(lap, from("/d/app"))).toEqual({
			machine: "lap",
			project: "/l/code/app",
			worktree: "/l/code/app",
		});
		expect(selectMachine(lap, from(""))).toEqual({ machine: "lap", project: "/l/code/app", worktree: "" });
		// the branch is missing there: the main worktree
		const lapMainOnly = machineSummary({
			id: "lap",
			projects: [repo("/l/app", [worktree("/l/app", { main: true })])],
		});
		expect(selectMachine(lapMainOnly, from("/d/wt-x"))).toEqual({
			machine: "lap",
			project: "/l/app",
			worktree: "/l/app",
		});
		// a repository the other machine lacks: its defaults
		expect(
			selectMachine(machineSummary({ id: "lap", projects: [project("/l/a"), project("/l/b")] }), from("/d/app")),
		).toEqual({ machine: "lap", project: "", worktree: "" });
	});

	test("all projects stays all projects across machine switches, even onto a single-project machine", () => {
		const desk = machineSummary({ id: "desk", projects: [project("/d/a"), project("/d/b")] });
		const lap = machineSummary({ id: "lap", projects: [project("/l/solo")] });
		const all = { machine: "desk", project: "", worktree: "" };
		const there = selectMachine(lap, { machine: desk, selection: all });
		expect(there).toEqual({ machine: "lap", project: "", worktree: "" });
		expect(selectMachine(desk, { machine: lap, selection: there })).toEqual(all);
	});
});

describe("newSessionTarget", () => {
	const online = machineSummary({ id: "m", name: "Mac", projects: [project("/p/app")] });
	const pick = { machine: "m", project: "/p/app", worktree: "/p/app" };

	test("creates in the selected worktree", () => {
		expect(newSessionTarget(online, pick)).toEqual({ ok: true, cwd: "/p/app" });
	});

	test("explains what is missing", () => {
		expect(newSessionTarget(undefined, EMPTY_SELECTION)).toMatchObject({ ok: false });
		expect(newSessionTarget({ ...online, online: false }, pick)).toEqual({ ok: false, reason: "Mac is offline." });
		expect(newSessionTarget(online, { ...pick, project: "", worktree: "" })).toEqual({
			ok: false,
			reason: "Pick a project.",
		});
		expect(newSessionTarget({ ...online, projects: [] }, { ...pick, project: "", worktree: "" })).toEqual({
			ok: false,
			reason: "Add a project first.",
		});
		expect(newSessionTarget(online, { ...pick, worktree: "" })).toEqual({ ok: false, reason: "Pick a worktree." });
	});
});

describe("worktreeLabel", () => {
	test("names the branch, marks the main worktree and hints the location", () => {
		expect(worktreeLabel(worktree("/home/me/src/app", { branch: "main", main: true }))).toBe(
			"main (main) — …/src/app",
		);
		expect(worktreeLabel(worktree("/wt/app-x", { branch: "feature/x" }))).toBe("feature/x — /wt/app-x");
	});

	test("a detached HEAD is named by its directory", () => {
		expect(worktreeLabel(worktree("/wt/app-y", { branch: null }))).toBe("app-y (detached) — /wt/app-y");
	});
});

describe("selection storage", () => {
	const memory = (initial?: string) => {
		const values = new Map<string, string>(initial === undefined ? [] : [["omp-web.selection", initial]]);
		return {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => void values.set(key, value),
		};
	};

	test("round-trips", () => {
		const storage = memory();
		const selection = { machine: "m", project: "/p", worktree: "/w" };
		saveSelection(storage, selection);
		expect(loadSelection(storage)).toEqual(selection);
	});

	test("anything that is not a selection loads as none", () => {
		expect(loadSelection(memory())).toBeNull();
		expect(loadSelection(memory("not json"))).toBeNull();
		expect(loadSelection(memory('{"machine":1,"project":"","worktree":""}'))).toBeNull();
		expect(loadSelection(memory('{"project":"","worktree":""}'))).toBeNull();
		expect(loadSelection(memory("null"))).toBeNull();
	});

	test("unavailable storage does not break the app", () => {
		const broken = {
			getItem: () => {
				throw new Error("denied");
			},
			setItem: () => {
				throw new Error("denied");
			},
		};
		expect(loadSelection(broken)).toBeNull();
		expect(() => saveSelection(broken, EMPTY_SELECTION)).not.toThrow();
	});
});

describe("session route", () => {
	test("round-trips machine and session ids, including characters that need encoding", () => {
		const ref = { machine: "mac/book #1", id: "a b?c" };
		const hash = sessionHash(ref);
		expect(hash).toBe("#/m/mac%2Fbook%20%231/s/a%20b%3Fc");
		expect(parseSessionHash(hash)).toEqual(ref);
	});

	test("anything else is no session", () => {
		expect(parseSessionHash("")).toBeNull();
		expect(parseSessionHash("#/s/abc")).toBeNull(); // the pre-gateway form names no machine
		expect(parseSessionHash("#/m/only")).toBeNull();
		expect(parseSessionHash("#/m/%E0%A4%A/s/x")).toBeNull();
	});
});

describe("ack data", () => {
	test("reads the session id of create / fork / resume", () => {
		expect(ackedSessionId({ sessionId: "s1" })).toBe("s1");
		expect(ackedSessionId({ sessionId: 1 })).toBeNull();
		expect(ackedSessionId(undefined)).toBeNull();
		expect(ackedSessionId("s1")).toBeNull();
	});

	test("reads the project of project.add", () => {
		const added = project("/p/app");
		expect(ackedProject(added)).toEqual(added);
		expect(ackedProject({ root: "/p/app" })).toBeNull();
		expect(ackedProject(null)).toBeNull();
	});
});
