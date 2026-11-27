// Login page of the gateway: trades the token for the session cookie. A separate bundle (scripts/build.ts, dist/login/);
// it must not import the app.
import { LOGIN_API } from "@omp-web/protocol";
import "@oh-my-pi/collab-web/src/styles/tokens.css";
import "@oh-my-pi/collab-web/src/styles/base.css";
import "../styles/theme.css";
import "./login.css";

function required<T extends Element>(root: ParentNode, selector: string): T {
	const element = root.querySelector<T>(selector);
	if (!element) throw new Error(`login page is missing ${selector}`);
	return element;
}

const form = required<HTMLFormElement>(document, "#login-form");
const error = required<HTMLElement>(form, ".login-error");
const submit = required<HTMLButtonElement>(form, "button[type=submit]");
const input = required<HTMLInputElement>(form, "input[name=token]");

function fail(message: string): void {
	error.textContent = message;
	error.hidden = false;
}

async function signIn(): Promise<void> {
	error.hidden = true;
	submit.disabled = true;
	try {
		const res = await fetch(LOGIN_API, {
			method: "POST",
			credentials: "same-origin",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ token: input.value }),
		});
		if (res.ok) {
			location.replace("/");
			return;
		}
		fail(res.status === 401 ? "Wrong token." : `Sign-in failed (${res.status}).`);
	} catch {
		fail("Cannot reach the gateway.");
	} finally {
		submit.disabled = false;
	}
}

form.addEventListener("submit", event => {
	event.preventDefault();
	void signIn();
});
