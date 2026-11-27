import type { LucideIcon } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
	icon: LucideIcon;
	/** Accessible name and tooltip; an icon button always has one. */
	label: string;
	small?: boolean;
	/** Hover turns red: the button closes, deletes or stops something. */
	danger?: boolean;
	/** Extra content over the glyph (an `icon-btn-dot`). */
	children?: ReactNode;
}

/** A square, labelled button holding one lucide glyph (16px; 14px when `small`). */
export function IconButton({ icon: Icon, label, small, danger, className, children, ...rest }: Props): ReactNode {
	const classes = ["icon-btn", danger && "icon-btn--danger", className].filter(Boolean).join(" ");
	return (
		<button type="button" aria-label={label} title={label} {...rest} className={classes}>
			<Icon size={small ? 14 : 16} aria-hidden="true" />
			{children}
		</button>
	);
}
