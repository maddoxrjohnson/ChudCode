/** Small DOM and formatting helpers shared by the pages. */

export const $ = (selector, root = document) => root.querySelector(selector);

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function")
      node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function readConfig() {
  const script = document.getElementById("cc-config");
  return script ? JSON.parse(script.textContent) : {};
}

export function formatMs(ms) {
  if (ms < 1) return "<1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Python-flavoured display of a JSON value, matching the server's examples. */
export function formatValue(value) {
  if (value === undefined) return "—";
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(formatValue).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)}: ${formatValue(v)}`)
      .join(", ")}}`;
  }
  return String(value);
}

export function formatInput(input, order = []) {
  const keys = [
    ...order.filter((k) => k in input),
    ...Object.keys(input).filter((k) => !order.includes(k)),
  ];
  return keys.map((k) => `${k} = ${formatValue(input[k])}`).join(", ");
}

/** Keep a long value readable in a details pane. */
export function clip(text, max = 2000) {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text;
}
