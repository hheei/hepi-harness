import { constants } from "node:fs";
import { access, mkdir, realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createSystemSshRunner, WorkspaceRegistry, sshWorkspaceSeed } from "../../gateway/src/index.ts";
import { SshFilesystem } from "../../gateway/src/ssh-filesystem.ts";
import { sshProfileOf } from "../../gateway/src/startup.ts";
import type { GatewaySettings } from "./config.ts";

export type ProbeResult = { readonly ok: true; readonly detail: string } | { readonly ok: false; readonly detail: string };

/**
 * The three things doctor has to reach outside its own process. They are injected so a test can decide the verdict
 * without a host, and the default `systemProbe` uses the same SSH helper the gateway does.
 */
export type DoctorProbe = {
  workspace(root: string): Promise<ProbeResult>;
  journal(directory: string): Promise<ProbeResult>;
  ssh(settings: GatewaySettings): Promise<ProbeResult>;
};

export type DoctorCheck = { readonly name: string; readonly ok: boolean; readonly detail: string };
export type DoctorResult = { readonly ok: boolean; readonly mode: string; readonly configFile: string | null; readonly checks: readonly DoctorCheck[] };

/**
 * Check configuration and reachability. A local gateway is checked against its own filesystem; an SSH gateway is
 * checked against the host it would execute on, because a remote root cannot be proven from the gateway machine.
 */
export async function runDoctor(settings: GatewaySettings, probe: DoctorProbe): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [{
    name: "config",
    ok: true,
    detail: "gateway " + settings.gatewayId + ", workspace " + settings.workspaceId + ", mode " + settings.mode + ", token configured (value not shown), " + settings.allowedCommands.length + " allowed command(s)",
  }];
  if (settings.ssh === undefined) {
    const workspace = await probe.workspace(settings.workspaceRoot);
    checks.push({ name: "workspace root", ok: workspace.ok, detail: workspace.detail });
  } else {
    const ssh = await probe.ssh(settings);
    checks.push({ name: "ssh host", ok: ssh.ok, detail: ssh.detail });
  }
  const journal = await probe.journal(dirname(settings.databasePath));
  checks.push({ name: "journal directory", ok: journal.ok, detail: journal.detail });
  return { ok: checks.every(check => check.ok), mode: settings.mode, configFile: settings.configFile ?? null, checks };
}

/** Format the result for a terminal or for `--json`, with every secret replaced before it can be printed. */
export function formatDoctor(result: DoctorResult, json: boolean, secrets: readonly string[] = []): string {
  const redact = (text: string): string => secrets.filter(secret => secret !== "").reduce((value, secret) => value.split(secret).join("<redacted>"), text);
  if (json) return redact(JSON.stringify(result, null, 2));
  const lines = ["hepi-client doctor: " + (result.ok ? "ok" : "failed") + " (mode " + result.mode + (result.configFile === null ? "" : ", config " + result.configFile) + ")"];
  for (const check of result.checks) lines.push("  " + (check.ok ? "ok  " : "fail") + " " + check.name + ": " + check.detail);
  return lines.join("\n");
}

export const systemProbe: DoctorProbe = {
  workspace: async (root) => {
    try {
      const info = await stat(root);
      if (!info.isDirectory()) return { ok: false, detail: "not a directory: " + root };
      return { ok: true, detail: await realpath(root) };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  },
  journal: async (directory) => {
    try {
      await mkdir(directory, { recursive: true });
      // The journal is opened for writing at startup, so a directory that exists but cannot be written is a failure
      // here rather than at the first call. W_OK covers read-only directories and, as root, is still advisory.
      await access(directory, constants.W_OK);
      return { ok: true, detail: directory };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  },
  ssh: async (settings) => {
    // The profile and the workspace registry are the ones the gateway itself composes, so doctor reaches the host
    // through the same mapping a started gateway would use instead of a second, hand-built copy of it.
    let files: SshFilesystem | undefined;
    try {
      const profile = sshProfileOf(settings);
      if (profile === undefined) return { ok: false, detail: "not an SSH gateway" };
      const workspaces = new WorkspaceRegistry(sshWorkspaceSeed([profile]));
      files = new SshFilesystem({ id: settings.gatewayId, profiles: [profile], runner: createSystemSshRunner(), workspaces });
      // `executionHost` asks the host for its own account and home, so a host that cannot be reached or has no
      // Python 3 is a failure here rather than a value the gateway machine supplied.
      const result = await files.execute({ workspaceId: settings.workspaceId, method: "executionHost" }) as { ok: true; value: { user: string; home: string } } | { ok: false; error: { code: string; message: string } };
      if (!result.ok) return { ok: false, detail: result.error.code + ": " + result.error.message };
      return { ok: true, detail: "account " + result.value.user + ", home " + result.value.home + ", root " + settings.workspaceRoot };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    } finally {
      await files?.close();
    }
  },
};
