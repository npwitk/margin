import type { CompileResult } from "@margin/shared";
import { emit, flushProject } from "./collab.ts";
import { COMPILE_TOKEN, COMPILE_URL } from "./config.ts";
import { getProject, syncWorkDir, touchProject } from "./storage.ts";

export async function compileWorker(pathAndQuery: string, init?: RequestInit) {
  const res = await fetch(`${COMPILE_URL}${pathAndQuery}`, {
    ...init,
    headers: { "content-type": "application/json", ...(COMPILE_TOKEN ? { "x-compile-token": COMPILE_TOKEN } : {}) },
  }).catch(() => null);
  if (!res) throw new Error("Compile service is not reachable");
  const body = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Compile service error ${res.status}`);
  return body;
}

/** Save live edits, compile in the sandbox, and tell everyone in the project. */
export async function compileProject(id: string, by: string): Promise<CompileResult> {
  const project = await getProject(id);
  await flushProject(id);
  await syncWorkDir(id);
  const result = (await compileWorker("/compile", {
    method: "POST",
    body: JSON.stringify({ projectId: id, mainFile: project.mainFile, engine: project.engine }),
  })) as CompileResult;
  await touchProject(id);
  emit(id, "lastCompile", { by, at: Date.now(), ok: result.ok });
  return result;
}
