import { Type, type Static } from "@sinclair/typebox";

export interface CronJobRecord {
	id: string;
	schedule: string;
	prompt: string;
	nextRunAt: number;
	lastRunAt?: number;
	createdAt: number;
}

export interface CronJobStore {
	create(schedule: string, prompt: string): Promise<CronJobRecord>;
	delete(id: string): Promise<boolean>;
	list(): Promise<CronJobRecord[]>;
}

const createCronJobSchema = Type.Object({
	schedule: Type.String({
		description: "Cron schedule in standard 5-field UTC format: minute hour day-of-month month day-of-week. Minimum supported frequency is every 10 minutes.",
	}),
	prompt: Type.String({ description: "Prompt to send to the agent on each run." }),
});

const deleteCronJobSchema = Type.Object({
	id: Type.String({ description: "Cron job id to delete." }),
});

const listCronJobsSchema = Type.Object({});

type ParsedField = { wildcard: boolean; values: Set<number> };

type ParsedCron = {
	minute: ParsedField;
	hour: ParsedField;
	dayOfMonth: ParsedField;
	month: ParsedField;
	dayOfWeek: ParsedField;
	original: string;
};

function parseCronField(raw: string, min: number, max: number, label: string): ParsedField {
	const value = raw.trim();
	if (!value) throw new Error(`Missing ${label} field`);
	if (value === "*") return { wildcard: true, values: new Set() };

	const values = new Set<number>();
	for (const part of value.split(",")) {
		const segment = part.trim();
		if (!segment) throw new Error(`Invalid ${label} field: empty segment`);

		let base = segment;
		let step = 1;
		if (segment.includes("/")) {
			const [lhs, rhs] = segment.split("/");
			if (!lhs || !rhs) throw new Error(`Invalid ${label} step syntax: ${segment}`);
			base = lhs;
			step = Number(rhs);
			if (!Number.isInteger(step) || step <= 0) throw new Error(`Invalid ${label} step: ${segment}`);
		}

		let start = min;
		let end = max;
		if (base !== "*") {
			if (base.includes("-")) {
				const [lhs, rhs] = base.split("-");
				start = Number(lhs);
				end = Number(rhs);
			} else {
				start = Number(base);
				end = Number(base);
			}
			if (!Number.isInteger(start) || !Number.isInteger(end)) {
				throw new Error(`Invalid ${label} value: ${segment}`);
			}
		}

		if (start < min || end > max || start > end) {
			throw new Error(`Invalid ${label} range: ${segment}`);
		}

		for (let current = start; current <= end; current += step) {
			values.add(current);
		}
	}

	return { wildcard: false, values };
}

function parseCronSchedule(schedule: string): ParsedCron {
	const parts = schedule.trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new Error("Cron schedule must have exactly 5 fields: minute hour day-of-month month day-of-week");
	}

	const parsed: ParsedCron = {
		minute: parseCronField(parts[0], 0, 59, "minute"),
		hour: parseCronField(parts[1], 0, 23, "hour"),
		dayOfMonth: parseCronField(parts[2], 1, 31, "day-of-month"),
		month: parseCronField(parts[3], 1, 12, "month"),
		dayOfWeek: parseCronField(parts[4], 0, 7, "day-of-week"),
		original: schedule.trim(),
	};

	if (parsed.dayOfWeek.values.has(7)) {
		parsed.dayOfWeek.values.delete(7);
		parsed.dayOfWeek.values.add(0);
	}

	return parsed;
}

function matchesField(field: ParsedField, value: number): boolean {
	return field.wildcard || field.values.has(value);
}

function matchesCron(parsed: ParsedCron, date: Date): boolean {
	const minute = date.getUTCMinutes();
	const hour = date.getUTCHours();
	const dayOfMonth = date.getUTCDate();
	const month = date.getUTCMonth() + 1;
	const dayOfWeek = date.getUTCDay();

	if (!matchesField(parsed.minute, minute)) return false;
	if (!matchesField(parsed.hour, hour)) return false;
	if (!matchesField(parsed.month, month)) return false;

	const domMatch = matchesField(parsed.dayOfMonth, dayOfMonth);
	const dowMatch = matchesField(parsed.dayOfWeek, dayOfWeek);
	if (!parsed.dayOfMonth.wildcard && !parsed.dayOfWeek.wildcard) {
		return domMatch || dowMatch;
	}
	return domMatch && dowMatch;
}

export function nextCronRun(schedule: string, afterMs: number): number {
	const parsed = parseCronSchedule(schedule);
	const cursor = new Date(afterMs);
	cursor.setUTCSeconds(0, 0);
	cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

	const limit = afterMs + 366 * 24 * 60 * 60 * 1000;
	while (cursor.getTime() <= limit) {
		if (matchesCron(parsed, cursor)) return cursor.getTime();
		cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
	}

	throw new Error(`Could not find a future run time for cron schedule: ${schedule}`);
}

function validateMinimumInterval(schedule: string, minimumMinutes: number) {
	let previous = nextCronRun(schedule, Date.now() - 60_000);
	for (let i = 0; i < 3; i++) {
		const next = nextCronRun(schedule, previous);
		const diffMinutes = (next - previous) / 60_000;
		if (diffMinutes < minimumMinutes) {
			throw new Error(`Cron jobs cannot run more frequently than every ${minimumMinutes} minutes`);
		}
		previous = next;
	}
}

export function createCronTools(store: CronJobStore, minimumMinutes = 10) {
	return [
		{
			name: "create_cron_job" as const,
			label: "create_cron_job",
			description: `Create a recurring cron job that sends a prompt to the agent on a UTC schedule. Uses standard 5-field cron syntax. Minimum supported frequency is every ${minimumMinutes} minutes.`,
			parameters: createCronJobSchema,
			execute: async (_id: string, { schedule, prompt }: Static<typeof createCronJobSchema>) => {
				parseCronSchedule(schedule);
				validateMinimumInterval(schedule, minimumMinutes);
				const job = await store.create(schedule.trim(), prompt.trim());
				return {
					content: [{ type: "text" as const, text: `Created cron job ${job.id}\nSchedule: ${job.schedule} (UTC)\nNext run: ${new Date(job.nextRunAt).toISOString()}\nPrompt: ${job.prompt}` }],
					details: job,
				};
			},
		},
		{
			name: "delete_cron_job" as const,
			label: "delete_cron_job",
			description: "Delete a recurring cron job.",
			parameters: deleteCronJobSchema,
			execute: async (_id: string, { id }: Static<typeof deleteCronJobSchema>) => {
				const deleted = await store.delete(id.trim());
				return {
					content: [{ type: "text" as const, text: deleted ? `Deleted cron job ${id}` : `No cron job found with id ${id}` }],
					details: { deleted },
				};
			},
		},
		{
			name: "list_cron_jobs" as const,
			label: "list_cron_jobs",
			description: "List recurring cron jobs for this session.",
			parameters: listCronJobsSchema,
			execute: async () => {
				const jobs = await store.list();
				const text = jobs.length === 0
					? "(no cron jobs)"
					: jobs.map((job) => `${job.id} -> ${job.schedule} UTC -> next ${new Date(job.nextRunAt).toISOString()} -> ${job.prompt}`).join("\n");
				return { content: [{ type: "text" as const, text }], details: { jobs } };
			},
		},
	];
}
