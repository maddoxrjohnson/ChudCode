/**
 * format.ts: text formatting shared by the page builders and the interviewer prompts.
 */

/** `nums = [2, 1, 5], k = 3`, in the order the signature declares. */
export function formatInput(input: Record<string, unknown>, order: string[] = []): string {
  const keys = [
    ...order.filter((k) => k in input),
    ...Object.keys(input).filter((k) => !order.includes(k)),
  ];
  return keys.map((k) => `${k} = ${formatValue(input[k])}`).join(", ");
}

/** Python-flavoured display of a JSON value. */
export function formatValue(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(formatValue).join(", ")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${JSON.stringify(k)}: ${formatValue(v)}`)
      .join(", ")}}`;
  }
  return String(value);
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Cut a long string for a prompt or a log line. */
export function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text;
}

export function plural(count: number, word: string, pluralWord = `${word}s`): string {
  return `${count} ${count === 1 ? word : pluralWord}`;
}
