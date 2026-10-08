/** Thin fetch helpers that turn error bodies into exceptions. */

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  const data = parseJson(text);
  if (!res.ok) {
    const message =
      data && typeof data.error === "string" ? data.error : `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message);
  }
  return data;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const getJson = (path) => request("GET", path);
export const postJson = (path, body = {}) => request("POST", path, body);
export const putJson = (path, body = {}) => request("PUT", path, body);
