// Upstream tool-render/element.tsx does `class X extends HTMLElement` at module load. Browsers have it; Bun render-to-string
// does not. Same one-line stub upstream's own tests use (collab-web/test/transcript-dom-shim.ts).
class TestHTMLElement {}
const globals = globalThis as typeof globalThis & { HTMLElement?: typeof HTMLElement };
globals.HTMLElement ??= TestHTMLElement as unknown as typeof HTMLElement;
