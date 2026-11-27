import type { QueueWire } from "@omp-web/protocol";
import { X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { textKeys } from "../lib/keys";
import { IconButton } from "./ui/icon-button";

interface Props {
	queue: QueueWire;
	/** Absent: the list is display-only. */
	onRemove?(message: string, queue: "steering" | "followUp"): Promise<{ ok: boolean; error?: string }>;
}

/** Messages waiting for the running turn: steering ones (the first `liveSteered` are already sent) and follow-ups. */
export function QueueList({ queue, onRemove }: Props): ReactNode {
	const [error, setError] = useState<string | null>(null);
	if (queue.steering.length === 0 && queue.followUp.length === 0) return null;
	const steeringKeys = textKeys(queue.steering);
	const followKeys = textKeys(queue.followUp);

	const remove = async (message: string, which: "steering" | "followUp"): Promise<void> => {
		setError(null);
		const ack = await onRemove?.(message, which);
		if (ack && !ack.ok) setError(ack.error ?? "remove failed");
	};

	const row = (key: string, label: string, text: string, which: "steering" | "followUp", removable: boolean) => (
		<li key={key} className="queue-item">
			<span className="chip">{label}</span>
			<span className="queue-text">{text}</span>
			{removable && onRemove && (
				<IconButton
					icon={X}
					small
					danger
					className="queue-x"
					label="Remove from queue"
					onClick={() => void remove(text, which)}
				/>
			)}
		</li>
	);

	return (
		<div className="queue">
			<ul>
				{queue.steering.map((text, i) =>
					row(
						`s:${steeringKeys[i]}`,
						i < queue.liveSteered ? "steering · sent" : "steering",
						text,
						"steering",
						i >= queue.liveSteered,
					),
				)}
				{queue.followUp.map((text, i) => row(`f:${followKeys[i]}`, "follow-up", text, "followUp", true))}
			</ul>
			{error && <div className="form-error">{error}</div>}
		</div>
	);
}
