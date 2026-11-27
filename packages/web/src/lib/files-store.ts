/**
 * State of one Files view (one worktree of one machine): directory listings, the expanded tree, git status, the open
 * file and its diff. An external store like the session stores: React subscribes with `useSyncExternalStore`.
 *
 * Everything that touches the daemon is bounded: each request kind has at most one in flight per target, polling runs
 * only while the view is started, the machine is online and the page visible, and answers that arrive after the
 * thing they were for has changed (another file opened, the view closed) are dropped.
 */
import type { FileContent, FileDiff, FileDiffMode, FileListing, GitStatus } from "@omp-web/protocol";
import {
	ancestorsOf,
	EMPTY_STATUS_INDEX,
	entryFor,
	type FilesFailure,
	indexStatus,
	PAGE_LINES,
	pageStartFor,
	signatureOf,
	type StatusIndex,
} from "./files";
import type { FilesApi } from "./files-data";

export const STATUS_POLL_MS = 5_000;
export const DIRS_POLL_MS = 15_000;
/** Listings refreshed per polling tick (the rest follow on later ticks). */
export const MAX_DIRS_PER_TICK = 25;

export type ViewMode = "source" | FileDiffMode;

export interface DirState {
	/** The last listing received; kept while a newer one loads or fails. */
	listing: FileListing | null;
	loading: boolean;
	error: FilesFailure | null;
}

export interface StatusState {
	data: GitStatus | null;
	index: StatusIndex;
	loading: boolean;
	/** At least one answer arrived. */
	loaded: boolean;
	error: FilesFailure | null;
}

export interface DiffState {
	/** Which diff this is (path, mode, rename origin): a different key is a different diff. */
	key: string;
	data: FileDiff | null;
	loading: boolean;
	error: FilesFailure | null;
}

export interface FileState {
	path: string | null;
	mode: ViewMode;
	/** A read is in flight (the previous page, if any, stays shown). */
	loading: boolean;
	content: FileContent | null;
	error: FilesFailure | null;
	/** The line to highlight and scroll to. */
	target: number | null;
	/** The file's git state when it was read; null until the first status answer. */
	signature: string | null;
	diff: DiffState | null;
}

export interface FilesSnapshot {
	showIgnored: boolean;
	/** The machine is away, or a request just found out it is. */
	offline: boolean;
	dirs: ReadonlyMap<string, DirState>;
	/** Expanded directories below the root (the root is always shown). */
	expanded: ReadonlySet<string>;
	status: StatusState;
	file: FileState;
}

export interface FilesRoute {
	path: string;
	line: number | null;
	diff: FileDiffMode | null;
}

const NO_FILE: FileState = {
	path: null,
	mode: "source",
	loading: false,
	content: null,
	error: null,
	target: null,
	signature: null,
	diff: null,
};

export class FilesStore {
	readonly #api: FilesApi;
	#snapshot: FilesSnapshot;
	readonly #listeners = new Set<() => void>();
	#online = true;
	#linkId: number | null = null;
	#offlineSeen = false;
	#visible = true;
	#started = false;
	#stopped = false;
	#statusTimer: ReturnType<typeof setInterval> | undefined;
	#dirsTimer: ReturnType<typeof setInterval> | undefined;
	#statusFlight: Promise<void> | null = null;
	readonly #dirFlights = new Map<string, Promise<void>>();
	/** Bumped when the listings in flight no longer answer the question (the ignored filter changed). */
	#dirEpoch = 0;
	#dirsRunning = false;
	#dirCursor = 0;
	#fileGen = 0;
	#diffGen = 0;
	#route: FilesRoute | null = null;

	constructor(api: FilesApi, showIgnored: boolean) {
		this.#api = api;
		this.#snapshot = {
			showIgnored,
			offline: false,
			dirs: new Map(),
			expanded: new Set(),
			status: { data: null, index: EMPTY_STATUS_INDEX, loading: false, loaded: false, error: null },
			file: NO_FILE,
		};
	}

	readonly subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	readonly getSnapshot = (): FilesSnapshot => this.#snapshot;

	get api(): FilesApi {
		return this.#api;
	}

	#set(patch: Partial<FilesSnapshot>): void {
		if (this.#stopped) return;
		this.#snapshot = { ...this.#snapshot, ...patch, offline: !this.#online || this.#offlineSeen };
		for (const listener of this.#listeners) listener();
	}

	#setFile(patch: Partial<FileState>): void {
		this.#set({ file: { ...this.#snapshot.file, ...patch } });
	}

	#setDir(path: string, state: DirState): void {
		this.#set({ dirs: new Map(this.#snapshot.dirs).set(path, state) });
	}

	/** An answer that says the machine is away, or one that proves it is back. */
	#observe(failure: FilesFailure | null): void {
		const seen = failure?.code === "offline";
		if (seen !== this.#offlineSeen) {
			this.#offlineSeen = seen;
			this.#set({});
		}
	}

	// -------------------------------------------------------------------------
	// Lifecycle

	/** Loads the root and the git status, and starts polling (while online and visible). */
	start(): void {
		if (this.#started || this.#stopped) return;
		this.#started = true;
		if (typeof document !== "undefined") {
			this.#visible = document.visibilityState !== "hidden";
			document.addEventListener("visibilitychange", this.#onVisibility);
		}
		void this.loadDir("");
		void this.refreshStatus();
		this.#sync();
	}

	/** Cancels timers and listeners and drops requests still queued. The store accepts no more changes. */
	stop(): void {
		this.#stopped = true;
		this.#clearTimers();
		if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.#onVisibility);
		this.#api.close();
		this.#listeners.clear();
	}

	readonly #onVisibility = (): void => {
		const wasActive = this.#active();
		this.#visible = document.visibilityState !== "hidden";
		this.#sync();
		if (!wasActive && this.#active()) this.#resume();
	};

	/**
	 * The machine's state as the gateway lists it. Coming back (online again, or registered under a new link) reloads
	 * what is shown; the first call only records the state.
	 */
	setMachine(online: boolean, linkId: number): void {
		const first = this.#linkId === null;
		const changed = !first && (online !== this.#online || linkId !== this.#linkId);
		const wasActive = this.#active();
		this.#online = online;
		this.#linkId = linkId;
		if (online) this.#offlineSeen = false;
		this.#set({});
		this.#sync();
		if (changed && online && this.#started) this.refresh();
		else if (!wasActive && this.#active() && !first) this.#resume();
	}

	#active(): boolean {
		return this.#started && !this.#stopped && this.#online && this.#visible;
	}

	#sync(): void {
		if (!this.#active()) {
			this.#clearTimers();
			return;
		}
		this.#statusTimer ??= setInterval(() => void this.pollStatus(), STATUS_POLL_MS);
		this.#dirsTimer ??= setInterval(() => void this.pollDirs(), DIRS_POLL_MS);
	}

	#clearTimers(): void {
		clearInterval(this.#statusTimer);
		clearInterval(this.#dirsTimer);
		this.#statusTimer = undefined;
		this.#dirsTimer = undefined;
	}

	#resume(): void {
		void this.pollStatus();
		void this.pollDirs();
	}

	// -------------------------------------------------------------------------
	// Polling (one timer tick; also what a test drives)

	/** The 5 s tick: refreshes the status unless the view is idle or the previous request is still out. */
	async pollStatus(): Promise<void> {
		if (!this.#active() || this.#statusFlight) return;
		await this.refreshStatus();
	}

	/** The 15 s tick: refreshes up to {@link MAX_DIRS_PER_TICK} expanded directories, one after the other. */
	async pollDirs(): Promise<void> {
		if (!this.#active() || this.#dirsRunning) return;
		this.#dirsRunning = true;
		try {
			const dirs = ["", ...this.#snapshot.expanded];
			const count = Math.min(MAX_DIRS_PER_TICK, dirs.length);
			const first = this.#dirCursor % dirs.length;
			for (let i = 0; i < count && this.#active(); i++) await this.loadDir(dirs[(first + i) % dirs.length]!);
			this.#dirCursor = first + count;
		} finally {
			this.#dirsRunning = false;
		}
	}

	// -------------------------------------------------------------------------
	// Directories

	loadDir(path: string): Promise<void> {
		const flying = this.#dirFlights.get(path);
		if (flying) return flying;
		const epoch = this.#dirEpoch;
		const before = this.#snapshot.dirs.get(path);
		this.#setDir(path, { listing: before?.listing ?? null, loading: true, error: before?.error ?? null });
		const flight = (async () => {
			const result = await this.#api.list(path, this.#snapshot.showIgnored);
			// Within one epoch a path has at most one flight; a flight of an older epoch was dropped from the map already.
			if (epoch === this.#dirEpoch) this.#dirFlights.delete(path);
			if (this.#stopped || epoch !== this.#dirEpoch) return;
			const listing = this.#snapshot.dirs.get(path)?.listing ?? null;
			if (result.ok) {
				this.#observe(null);
				this.#setDir(path, { listing: result.data, loading: false, error: null });
			} else if (result.failure.code !== "aborted") {
				this.#observe(result.failure);
				this.#setDir(path, { listing, loading: false, error: result.failure });
			}
		})();
		this.#dirFlights.set(path, flight);
		return flight;
	}

	toggleDir(path: string): void {
		if (this.#snapshot.expanded.has(path)) {
			const expanded = new Set(this.#snapshot.expanded);
			expanded.delete(path);
			this.#set({ expanded });
		} else this.#expand(path, true);
	}

	/** Expands `path`; its listing is requested when it has none yet or `reload` asks for a fresh one. */
	#expand(path: string, reload: boolean): void {
		if (path === "") return;
		const dir = this.#snapshot.dirs.get(path);
		if (!this.#snapshot.expanded.has(path)) this.#set({ expanded: new Set(this.#snapshot.expanded).add(path) });
		if (reload || !dir?.listing) void this.loadDir(path);
	}

	setShowIgnored(value: boolean): void {
		if (value === this.#snapshot.showIgnored) return;
		this.#dirEpoch++;
		this.#dirFlights.clear();
		this.#set({ showIgnored: value });
		for (const dir of ["", ...this.#snapshot.expanded]) void this.loadDir(dir);
	}

	// -------------------------------------------------------------------------
	// Status

	refreshStatus(): Promise<void> {
		if (this.#statusFlight) return this.#statusFlight;
		this.#set({ status: { ...this.#snapshot.status, loading: true } });
		const flight = (async () => {
			const result = await this.#api.status();
			this.#statusFlight = null;
			if (this.#stopped) return;
			if (result.ok) {
				this.#observe(null);
				const index = indexStatus(result.data);
				this.#set({ status: { data: result.data, index, loading: false, loaded: true, error: null } });
				this.#statusChanged(index);
			} else if (result.failure.code !== "aborted") {
				this.#observe(result.failure);
				this.#set({ status: { ...this.#snapshot.status, loading: false, error: result.failure } });
			}
		})();
		this.#statusFlight = flight;
		return flight;
	}

	/** The open file is read again when its own git state changed (it was edited, staged, …). */
	#statusChanged(index: StatusIndex): void {
		const file = this.#snapshot.file;
		if (file.path === null) return;
		const signature = signatureOf(index, file.path);
		if (file.signature === null) this.#setFile({ signature });
		else if (signature !== file.signature) {
			this.#setFile({ signature });
			this.#reloadFile();
		}
	}

	// -------------------------------------------------------------------------
	// The open file

	/** Applies the route: opens the file (or directory), switches the view mode, or goes to the requested line. */
	select(route: FilesRoute): void {
		const previous = this.#route;
		this.#route = route;
		const file = this.#snapshot.file;
		const mode: ViewMode = route.diff ?? "source";
		if (route.path === "") {
			this.#fileGen++;
			this.#diffGen++;
			this.#set({ file: NO_FILE });
			return;
		}
		for (const dir of ancestorsOf(route.path)) this.#expand(dir, false);
		if (file.path !== route.path || previous === null) {
			this.#openFile(route.path, route.line, mode);
			return;
		}
		if (route.line !== null && route.line !== previous.line && route.line !== file.target) {
			void this.#readPage(pageStartFor(route.line), route.line);
		}
		if (mode !== file.mode) {
			this.#setFile({ mode });
			if (mode !== "source") void this.#loadDiff(false);
		}
	}

	#openFile(path: string, line: number | null, mode: ViewMode): void {
		const status = this.#snapshot.status;
		this.#diffGen++;
		this.#set({
			file: {
				...NO_FILE,
				path,
				mode,
				loading: true,
				target: line,
				signature: status.loaded ? signatureOf(status.index, path) : null,
			},
		});
		if (mode !== "source") void this.#loadDiff(false);
		void this.#readPage(line === null ? 1 : pageStartFor(line), line);
	}

	/** Reads the page starting at `fromLine`; a failure keeps the page that was shown (it is stale, not gone). */
	async #readPage(fromLine: number, target: number | null): Promise<void> {
		const path = this.#snapshot.file.path;
		if (path === null) return;
		const gen = ++this.#fileGen;
		this.#setFile({ loading: true, target });
		const result = await this.#api.read(path, fromLine, PAGE_LINES);
		if (gen !== this.#fileGen || this.#stopped) return;
		if (result.ok) {
			this.#observe(null);
			this.#setFile({ loading: false, content: result.data, error: null });
			if (result.data.kind === "dir") this.#expand(path, true);
		} else if (result.failure.code !== "aborted") {
			this.#observe(result.failure);
			this.#setFile({ loading: false, error: result.failure });
		}
	}

	async #loadDiff(force: boolean): Promise<void> {
		// A rename's diff needs the old path, which only the status knows.
		if (!this.#snapshot.status.loaded && this.#statusFlight) await this.#statusFlight;
		if (this.#stopped) return;
		const { path, mode, diff } = this.#snapshot.file;
		if (path === null || mode === "source") return;
		const origPath = entryFor(this.#snapshot.status.index, path)?.origPath;
		const key = `${path}\0${mode}\0${origPath ?? ""}`;
		if (!force && diff?.key === key && (diff.loading || diff.data)) return;
		const gen = ++this.#diffGen;
		this.#setFile({ diff: { key, data: diff?.key === key ? diff.data : null, loading: true, error: null } });
		const result = await this.#api.diff(path, mode, origPath);
		if (gen !== this.#diffGen || this.#stopped) return;
		const current = this.#snapshot.file.diff;
		if (result.ok) {
			this.#observe(null);
			this.#setFile({ diff: { key, data: result.data, loading: false, error: null } });
		} else if (result.failure.code !== "aborted") {
			this.#observe(result.failure);
			this.#setFile({
				diff: { key, data: current?.key === key ? current.data : null, loading: false, error: result.failure },
			});
		}
	}

	#reloadFile(): void {
		const { path, content, target, mode } = this.#snapshot.file;
		if (path === null) return;
		const from = content?.kind === "text" ? content.startLine : target === null ? 1 : pageStartFor(target);
		void this.#readPage(from, target);
		if (mode !== "source") void this.#loadDiff(true);
	}

	goToLine(line: number): void {
		if (this.#snapshot.file.path !== null && Number.isInteger(line) && line > 0) {
			void this.#readPage(pageStartFor(line), line);
		}
	}

	nextPage(): void {
		const { content } = this.#snapshot.file;
		if (content?.kind === "text" && content.nextLine !== null) void this.#readPage(content.nextLine, null);
	}

	prevPage(): void {
		const { content } = this.#snapshot.file;
		if (content?.kind === "text" && content.startLine > 1) {
			void this.#readPage(Math.max(1, content.startLine - PAGE_LINES), null);
		}
	}

	/** The Refresh button: status, every expanded directory and the open file, now. */
	refresh(): void {
		const before = this.#fileGen;
		const status = this.refreshStatus();
		for (const dir of ["", ...this.#snapshot.expanded]) void this.loadDir(dir);
		void status.then(() => {
			// A changed git state already reloaded the file.
			if (this.#fileGen === before && !this.#stopped) this.#reloadFile();
		});
	}
}
