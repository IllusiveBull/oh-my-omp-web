import { dlopen } from "bun:ffi";

/** Native ConPTY owns a separate job hierarchy. Explicitly bind supported shells to a daemon-owned nested job; close it on terminal exit or daemon death. */
export function joinWindowsServiceJob(pid: number): (() => void) | undefined {
	const name = process.env.OMP_WEB_SERVICE_JOB;
	if (process.platform !== "win32" || !name) return;
	const kernel = dlopen("kernel32.dll", {
		CreateJobObjectW: { args: ["ptr", "ptr"], returns: "ptr" },
		OpenJobObjectW: { args: ["u32", "i32", "ptr"], returns: "ptr" },
		SetInformationJobObject: { args: ["ptr", "i32", "ptr", "u32"], returns: "i32" },
		OpenProcess: { args: ["u32", "i32", "u32"], returns: "ptr" },
		AssignProcessToJobObject: { args: ["ptr", "ptr"], returns: "i32" },
		IsProcessInJob: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
		GetCurrentProcess: { args: [], returns: "ptr" },
		CloseHandle: { args: ["ptr"], returns: "i32" },
		GetLastError: { args: [], returns: "u32" },
	});
	let terminalJob: ReturnType<typeof kernel.symbols.CreateJobObjectW> = null;
	try {
		const serviceJob = kernel.symbols.OpenJobObjectW(0x0004, 0, Buffer.from(`${name}\0`, "utf16le"));
		if (!serviceJob) throw new Error(`cannot open the Windows service job (${kernel.symbols.GetLastError()})`);
		try {
			const member = new Uint32Array(1);
			if (!kernel.symbols.IsProcessInJob(kernel.symbols.GetCurrentProcess(), serviceJob, member) || !member[0]) {
				throw new Error("terminal daemon is not in its Windows service job");
			}
		} finally {
			kernel.symbols.CloseHandle(serviceJob);
		}
		terminalJob = kernel.symbols.CreateJobObjectW(null, null); // daemon-only, noninheritable handle
		if (!terminalJob) throw new Error(`cannot create terminal job (${kernel.symbols.GetLastError()})`);
		const limits = new Uint8Array(144);
		new DataView(limits.buffer).setUint32(16, 0x2000, true);
		if (!kernel.symbols.SetInformationJobObject(terminalJob, 9, limits, limits.byteLength)) {
			throw new Error(`cannot restrict terminal job (${kernel.symbols.GetLastError()})`);
		}
		const shell = kernel.symbols.OpenProcess(0x0101, 0, pid); // SET_QUOTA | TERMINATE
		if (!shell) throw new Error(`cannot open terminal pid ${pid} (${kernel.symbols.GetLastError()})`);
		try {
			if (!kernel.symbols.AssignProcessToJobObject(terminalJob, shell)) {
				throw new Error(
					`cannot assign terminal pid ${pid} to its service-owned job (${kernel.symbols.GetLastError()})`,
				);
			}
		} finally {
			kernel.symbols.CloseHandle(shell);
		}
	} catch (error) {
		if (terminalJob) kernel.symbols.CloseHandle(terminalJob);
		kernel.close();
		throw error;
	}
	let closed = false;
	return () => {
		if (closed) return;
		closed = true;
		kernel.symbols.CloseHandle(terminalJob);
		kernel.close();
	};
}
