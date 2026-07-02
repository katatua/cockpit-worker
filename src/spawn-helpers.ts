/**
 * Helper util para correr sub-processos com promessa. Usado pelo preview-manager
 * (npm ci, git fetch/reset/clone) — não precisa da abstração do git.ts porque
 * queremos capturar stdout+stderr para logs de diagnóstico.
 */
import { spawn, type SpawnOptions } from "node:child_process";

export function spawnPromise(cmd: string, args: string[], opts: SpawnOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (c: Buffer) => { stdout += c.toString(); });
    proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
    proc.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} ${args.join(" ")} exit=${code}\n${stderr}`));
    });
    proc.on("error", reject);
  });
}
