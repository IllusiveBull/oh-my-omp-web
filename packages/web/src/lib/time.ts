import { formatDuration } from "@oh-my-pi/pi-utils/format";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Nov 12, 2026, 15:04" in the reader's locale, 24-hour. */
export function formatAbsolute(at: number, locale?: string): string {
	return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", hourCycle: "h23" }).format(at);
}

/** "Thursday, November 19, 2026 at 14:03:27" in the reader's locale and time zone, 24-hour: a message's tooltip. */
export function formatExact(at: number, locale?: string): string {
	return new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "medium", hourCycle: "h23" }).format(at);
}

/** "14:03:27" today, "Nov 19, 14:03:27" earlier this year, "Nov 19, 2025, 14:03:27" before: a chat message's stamp. */
export function formatMessageTime(at: number, now: number, locale?: string): string {
	const day = new Date(at);
	const today = new Date(now);
	const sameDay = day.toDateString() === today.toDateString();
	return new Intl.DateTimeFormat(locale, {
		month: sameDay ? undefined : "short",
		day: sameDay ? undefined : "numeric",
		year: sameDay || day.getFullYear() === today.getFullYear() ? undefined : "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).format(at);
}

/** "15:04" today, "Nov 12" earlier this year, "Nov 12, 2025" before: short enough for a list row. */
export function formatStamp(at: number, now: number, locale?: string): string {
	const day = new Date(at);
	const today = new Date(now);
	if (day.toDateString() === today.toDateString()) {
		return new Intl.DateTimeFormat(locale, { timeStyle: "short", hourCycle: "h23" }).format(at);
	}
	const thisYear = day.getFullYear() === today.getFullYear();
	return new Intl.DateTimeFormat(locale, {
		month: "short",
		day: "numeric",
		year: thisYear ? undefined : "numeric",
	}).format(at);
}

/** "5 minutes ago", "yesterday", "in 2 hours": the coarsest unit that keeps the number small. Under a minute is "now". */
export function formatRelative(at: number, now: number, locale?: string): string {
	const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
	const diff = at - now;
	const age = Math.abs(diff);
	if (age < MINUTE) return format.format(0, "second");
	if (age < HOUR) return format.format(Math.trunc(diff / MINUTE), "minute");
	if (age < DAY) return format.format(Math.trunc(diff / HOUR), "hour");
	if (age < 30 * DAY) return format.format(Math.trunc(diff / DAY), "day");
	if (age < 365 * DAY) return format.format(Math.trunc(diff / (30 * DAY)), "month");
	return format.format(Math.trunc(diff / (365 * DAY)), "year");
}

/** "in 4d 7h", "3h 12m ago", "in 12m": the two largest units down to minutes, for deadlines where "in 4 days" hides
 * the hours. Under a minute is "now". */
export function formatCountdown(at: number, now: number): string {
	const diff = at - now;
	const age = Math.abs(diff);
	if (age < MINUTE) return "now";
	const days = Math.floor(age / DAY);
	const hours = Math.floor((age % DAY) / HOUR);
	const minutes = Math.floor((age % HOUR) / MINUTE);
	const span =
		days > 0
			? `${days}d${hours > 0 ? ` ${hours}h` : ""}`
			: hours > 0
				? `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`
				: `${minutes}m`;
	return diff > 0 ? `in ${span}` : `${span} ago`;
}

/** "14:00" today, "Tue 08:00" within a week, "Dec 3, 08:00" later: when a usage window resets. */
export function formatResetAt(at: number, now: number, locale?: string): string {
	if (at <= now) return "now";
	const day = new Date(at);
	const time = new Intl.DateTimeFormat(locale, { timeStyle: "short", hourCycle: "h23" }).format(at);
	if (day.toDateString() === new Date(now).toDateString()) return time;
	if (at - now < 6 * DAY) return `${new Intl.DateTimeFormat(locale, { weekday: "short" }).format(at)} ${time}`;
	return `${new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(at)}, ${time}`;
}

/** Time spent so far: whole seconds under a minute ("42s"; a ticking clock shows no fractions), omp's compact units above. */
export function formatElapsed(ms: number): string {
	return ms < MINUTE ? `${Math.floor(Math.max(0, ms) / 1000)}s` : formatDuration(ms);
}
