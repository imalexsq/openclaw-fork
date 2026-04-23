import { describe, expect, it } from "vitest";
import {
  assertCronSystemRunAllowed,
  resolveCronSystemRunAllowEntry,
  resolveCronSystemRunError,
  resolveCronSystemRunSummary,
} from "./system-run.js";

describe("cron systemRun allowlist", () => {
  const payload = {
    kind: "systemRun" as const,
    command: ["python3", "/tmp/runner.py", "--db-path", "/tmp/db.sqlite3"],
    cwd: "/tmp/workspace",
    env: { OPENCLAW_ENV: "prod" },
  };

  it("matches allowlisted argv prefixes, cwd prefixes, and env keys", () => {
    const entry = resolveCronSystemRunAllowEntry({
      payload,
      cronConfig: {
        systemRun: {
          allow: [
            {
              id: "marketing",
              argvPrefix: ["python3", "/tmp/runner.py"],
              cwdPrefix: "/tmp",
              envAllowlist: ["OPENCLAW_ENV"],
            },
          ],
        },
      },
    });

    expect(entry?.id).toBe("marketing");
  });

  it("rejects non-allowlisted env keys", () => {
    expect(() =>
      assertCronSystemRunAllowed({
        payload: {
          ...payload,
          env: { OPENCLAW_ENV: "prod", SECRET_TOKEN: "nope" },
        },
        cronConfig: {
          systemRun: {
            allow: [
              {
                id: "marketing",
                argvPrefix: ["python3", "/tmp/runner.py"],
                cwdPrefix: "/tmp",
                envAllowlist: ["OPENCLAW_ENV"],
              },
            ],
          },
        },
      }),
    ).toThrow("cron systemRun command is not allowlisted");
  });
});

describe("cron systemRun summaries", () => {
  it("uses custom success summaries when requested", () => {
    expect(
      resolveCronSystemRunSummary({
        payload: {
          kind: "systemRun",
          command: ["python3", "runner.py"],
          summaryPolicy: "custom",
          successSummary: "Runner completed cleanly",
        },
        status: "ok",
        stdout: "ignored",
      }),
    ).toBe("Runner completed cleanly");
  });

  it("summarizes failures from process output", () => {
    expect(
      resolveCronSystemRunError({
        stdout: "",
        stderr: "boom\nstacktrace",
        code: 2,
        signal: null,
        killed: false,
        termination: "exit",
      }),
    ).toContain("boom");
  });
});
