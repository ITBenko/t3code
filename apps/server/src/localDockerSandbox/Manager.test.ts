import { assert, describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  LocalDockerSandboxId,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { makeWithRunner, type DockerCommandRunner } from "./Manager.ts";

const OWNER_ENVIRONMENT_ID = EnvironmentId.make("11111111-1111-4111-8111-111111111111");
const SANDBOX_ENVIRONMENT_ID = EnvironmentId.make("22222222-2222-4222-8222-222222222222");
const SANDBOX_ID = LocalDockerSandboxId.make("33333333-3333-4333-8333-333333333333");
const CONTAINER_ID = "a".repeat(64);
const ARCHIVE_PATH = "/tmp/t3-sandbox-seed/workspace.tar";
const TIMEOUT_EXIT_CODE = 124;
const STAGED_CREDENTIAL_PATH = "/tmp/t3-sandbox-credential/credential";

const descriptor: ExecutionEnvironmentDescriptor = {
  environmentId: SANDBOX_ENVIRONMENT_ID,
  label: "Docker sandbox",
  platform: { os: "linux", arch: "arm64" },
  serverVersion: "0.0.35",
  capabilities: { repositoryIdentity: true },
};

const httpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(descriptor))),
);

function inspectJson(name: string, status: "running" | "exited" = "running"): string {
  return JSON.stringify([
    {
      Id: CONTAINER_ID,
      Name: `/${name}`,
      Created: "2026-08-27T12:00:00.000000000Z",
      Image: "sha256:feedfacedeadbeef0123456789abcdef0123456789abcdef0123456789abcdef",
      HostConfig: { Memory: 4 * 1024 ** 3, NanoCpus: 2_000_000_000, PidsLimit: 512 },
      Config: {
        Image: "example/t3-sandbox@sha256:abc",
        Labels: {
          "dev.t3code.local-sandbox": "true",
          "dev.t3code.local-sandbox.owner": OWNER_ENVIRONMENT_ID,
          "dev.t3code.local-sandbox.id": SANDBOX_ID,
        },
      },
      State: { Status: status, StartedAt: "2026-08-27T12:00:01.000000000Z" },
      NetworkSettings: {
        Ports: { "3773/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }] },
      },
    },
  ]);
}

/** A container reported by a Docker version that omits the presentation-only
    fields, and which has never been started. */
function bareInspectJson(): string {
  return JSON.stringify([
    {
      Id: CONTAINER_ID,
      Name: `/t3-sandbox-${SANDBOX_ENVIRONMENT_ID}`,
      Created: "2026-08-27T12:00:00.000000000Z",
      Config: {
        Image: "example/t3-sandbox@sha256:abc",
        Labels: {
          "dev.t3code.local-sandbox": "true",
          "dev.t3code.local-sandbox.owner": OWNER_ENVIRONMENT_ID,
          "dev.t3code.local-sandbox.id": SANDBOX_ID,
        },
      },
      State: { Status: "created", StartedAt: "0001-01-01T00:00:00Z" },
      NetworkSettings: { Ports: {} },
    },
  ]);
}

/**
 * A container log that banners a fresh one-time token on every boot, the way a
 * real `t3 serve` does. `start` reads the log before and after starting, so a
 * log fixed across a boot is a container that never came back up.
 */
function bootLog() {
  let boots = 1;
  return {
    onStart: () => {
      boots += 1;
    },
    read: () => `Token: BOOTTOKEN${boots}\n`,
  };
}

describe("LocalDockerSandboxManager", () => {
  it.effect("creates a constrained container and returns its local pairing URL", () =>
    Effect.gen(function* () {
      const commands: Array<ReadonlyArray<string>> = [];
      let renamed = false;
      const runner: DockerCommandRunner = {
        run: (args) => {
          commands.push(args);
          if (args[0] === "image" && args[1] === "inspect") {
            return Effect.succeed({ exitCode: 0, stdout: '"node"\n', stderr: "" });
          }
          if (args[0] === "volume" && args[1] === "create") {
            return Effect.succeed({ exitCode: 0, stdout: `${args.at(-1)}\n`, stderr: "" });
          }
          if (args[0] === "run") {
            return Effect.succeed({ exitCode: 0, stdout: `${CONTAINER_ID}\n`, stderr: "" });
          }
          if (args[0] === "inspect") {
            const name = renamed
              ? `t3-sandbox-${SANDBOX_ENVIRONMENT_ID}`
              : `t3-sandbox-pending-${SANDBOX_ID}`;
            return Effect.succeed({ exitCode: 0, stdout: inspectJson(name), stderr: "" });
          }
          if (args[0] === "logs") {
            return Effect.succeed({
              exitCode: 0,
              stdout: "T3 Code server is ready.\nToken: PAIRCODE\n",
              stderr: "",
            });
          }
          if (args[0] === "rename") {
            renamed = true;
            return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
          }
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        },
      };
      const manager = yield* makeWithRunner({
        image: "example/t3-sandbox@sha256:abc",
        ownerEnvironmentId: OWNER_ENVIRONMENT_ID,
        runner,
        httpClient,
        randomUUID: Effect.succeed(SANDBOX_ID),
        archiveHeadTree: () => Effect.succeed(ARCHIVE_PATH),
        credentialSources: Effect.succeed([]),
        stageCredential: () => Effect.succeed(STAGED_CREDENTIAL_PATH),
        providerEnvironment: [],
      });

      const created = yield* manager.create;

      expect(created.pairingUrl).toBe("http://127.0.0.1:49152/pair#token=PAIRCODE");
      expect(created.sandbox.environmentId).toBe(SANDBOX_ENVIRONMENT_ID);
      const runCommand = commands.find((args) => args[0] === "run");
      assert.isDefined(runCommand);
      expect(runCommand).toContain("--read-only");
      expect(runCommand).toContain("--cap-drop=ALL");
      expect(runCommand).toContain("--security-opt=no-new-privileges");
      expect(runCommand).toContain("127.0.0.1::3773");
      // Named so the paired environment does not surface as a bare container id.
      expect(runCommand).toContain(`t3-sandbox-${SANDBOX_ID.slice(0, 8)}`);
      expect(runCommand).not.toContain("--privileged");
      expect(runCommand?.join(" ")).not.toContain("docker.sock");
      expect(runCommand?.slice(-8)).toEqual([
        "serve",
        "--host",
        "0.0.0.0",
        "--port",
        "3773",
        "--base-dir",
        "/t3-data",
        "/workspace",
      ]);
    }),
  );

  it.effect("rejects an image that does not declare a non-root user before running it", () =>
    Effect.gen(function* () {
      const commands: Array<ReadonlyArray<string>> = [];
      const runner: DockerCommandRunner = {
        run: (args) => {
          commands.push(args);
          return Effect.succeed({ exitCode: 0, stdout: '""\n', stderr: "" });
        },
      };
      const manager = yield* makeWithRunner({
        image: "example/root-image:latest",
        ownerEnvironmentId: OWNER_ENVIRONMENT_ID,
        runner,
        httpClient,
        randomUUID: Effect.succeed(SANDBOX_ID),
        archiveHeadTree: () => Effect.succeed(ARCHIVE_PATH),
        credentialSources: Effect.succeed([]),
        stageCredential: () => Effect.succeed(STAGED_CREDENTIAL_PATH),
        providerEnvironment: [],
      });

      const failure = yield* manager.create.pipe(Effect.flip);

      expect(failure.reason).toBe("image-runs-as-root");
      expect(commands.some((args) => args[0] === "run")).toBe(false);
      expect(commands.some((args) => args[0] === "volume")).toBe(false);
    }),
  );

  it.effect("lists and deletes only the owner-labelled sandbox by exact ids", () =>
    Effect.gen(function* () {
      const commands: Array<ReadonlyArray<string>> = [];
      const runner: DockerCommandRunner = {
        run: (args) => {
          commands.push(args);
          if (args[0] === "ps") {
            return Effect.succeed({ exitCode: 0, stdout: `${CONTAINER_ID}\n`, stderr: "" });
          }
          if (args[0] === "inspect") {
            return Effect.succeed({
              exitCode: 0,
              stdout: inspectJson(`t3-sandbox-${SANDBOX_ENVIRONMENT_ID}`),
              stderr: "",
            });
          }
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        },
      };
      const manager = yield* makeWithRunner({
        image: "example/t3-sandbox@sha256:abc",
        ownerEnvironmentId: OWNER_ENVIRONMENT_ID,
        runner,
        httpClient,
        randomUUID: Effect.succeed(SANDBOX_ID),
        archiveHeadTree: () => Effect.succeed(ARCHIVE_PATH),
        credentialSources: Effect.succeed([]),
        stageCredential: () => Effect.succeed(STAGED_CREDENTIAL_PATH),
        providerEnvironment: [],
      });

      const listed = yield* manager.list;
      yield* manager.delete({ sandboxId: SANDBOX_ID });

      expect(listed.sandboxes).toHaveLength(1);
      expect(listed.sandboxes[0]?.sandboxId).toBe(SANDBOX_ID);
      expect(commands).toContainEqual(["rm", "-f", CONTAINER_ID]);
      expect(commands).toContainEqual(["volume", "rm", "-f", `t3-sandbox-${SANDBOX_ID}-workspace`]);
      const deleteLookup = commands.findLast((args) => args[0] === "ps");
      expect(deleteLookup).toContain(
        `label=dev.t3code.local-sandbox.owner=${OWNER_ENVIRONMENT_ID}`,
      );
      expect(deleteLookup).toContain(`label=dev.t3code.local-sandbox.id=${SANDBOX_ID}`);
    }),
  );
  it.effect("seeds a workspace directory once and reuses it afterwards", () =>
    Effect.gen(function* () {
      const commands: Array<ReadonlyArray<string>> = [];
      let seeded = false;
      const runner: DockerCommandRunner = {
        run: (args) => {
          commands.push(args);
          if (args[0] === "ps") {
            return Effect.succeed({ exitCode: 0, stdout: `${CONTAINER_ID}\n`, stderr: "" });
          }
          if (args[0] === "inspect") {
            return Effect.succeed({
              exitCode: 0,
              stdout: inspectJson(`t3-sandbox-${SANDBOX_ENVIRONMENT_ID}`),
              stderr: "",
            });
          }
          // The probe reports "already present" only after a seed has landed.
          if (args[0] === "exec" && args.at(2) === "sh" && args.at(3) === "-c") {
            const script = args.at(4) ?? "";
            if (script.includes("test -d")) {
              return Effect.succeed({ exitCode: seeded ? 0 : 1, stdout: "", stderr: "" });
            }
            seeded = true;
          }
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        },
      };
      const manager = yield* makeWithRunner({
        image: "example/t3-sandbox@sha256:abc",
        ownerEnvironmentId: OWNER_ENVIRONMENT_ID,
        runner,
        httpClient,
        randomUUID: Effect.succeed(SANDBOX_ID),
        archiveHeadTree: () => Effect.succeed(ARCHIVE_PATH),
        credentialSources: Effect.succeed([]),
        stageCredential: () => Effect.succeed(STAGED_CREDENTIAL_PATH),
        providerEnvironment: [],
      });

      const first = yield* manager.prepareWorkspace({
        sandboxId: SANDBOX_ID,
        projectRoot: "/Users/dev/code/my-repo",
      });
      const second = yield* manager.prepareWorkspace({
        sandboxId: SANDBOX_ID,
        projectRoot: "/Users/dev/code/my-repo",
      });

      expect(first.seeded).toBe(true);
      expect(first.workspacePath).toBe("/workspace/my-repo");
      expect(first.environmentId).toBe(SANDBOX_ENVIRONMENT_ID);
      expect(second.seeded).toBe(false);

      // The host archive is copied in, never a host directory, and the target
      // path is passed as an argument rather than spliced into the script.
      expect(commands).toContainEqual([
        "cp",
        ARCHIVE_PATH,
        `${CONTAINER_ID}:/workspace/.t3-workspace-seed.tar`,
      ]);
      const seedCommand = commands.find(
        (args) => args[0] === "exec" && (args.at(4) ?? "").includes("git init"),
      );
      assert.isDefined(seedCommand);
      expect(seedCommand?.slice(-2)).toEqual(["sh", "/workspace/my-repo"]);
      // Copying happens exactly once across both calls.
      expect(commands.filter((args) => args[0] === "cp")).toHaveLength(1);
    }),
  );

  it.effect("refuses to seed a sandbox that is not running", () =>
    Effect.gen(function* () {
      const runner: DockerCommandRunner = {
        run: (args) => {
          if (args[0] === "ps") {
            return Effect.succeed({ exitCode: 0, stdout: `${CONTAINER_ID}\n`, stderr: "" });
          }
          if (args[0] === "inspect") {
            return Effect.succeed({
              exitCode: 0,
              stdout: inspectJson(`t3-sandbox-${SANDBOX_ENVIRONMENT_ID}`, "exited"),
              stderr: "",
            });
          }
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        },
      };
      const manager = yield* makeWithRunner({
        image: "example/t3-sandbox@sha256:abc",
        ownerEnvironmentId: OWNER_ENVIRONMENT_ID,
        runner,
        httpClient,
        randomUUID: Effect.succeed(SANDBOX_ID),
        archiveHeadTree: () => Effect.succeed(ARCHIVE_PATH),
        credentialSources: Effect.succeed([]),
        stageCredential: () => Effect.succeed(STAGED_CREDENTIAL_PATH),
        providerEnvironment: [],
      });

      const failure = yield* manager
        .prepareWorkspace({ sandboxId: SANDBOX_ID, projectRoot: "/Users/dev/code/my-repo" })
        .pipe(Effect.flip);

      expect(failure.reason).toBe("not-running");
    }),
  );

  it.effect("reports an unsupported image rather than hanging when no token can be issued", () =>
    Effect.gen(function* () {
      const commands: Array<ReadonlyArray<string>> = [];
      const runner: DockerCommandRunner = {
        run: (args) => {
          commands.push(args);
          if (args[0] === "ps") {
            return Effect.succeed({ exitCode: 0, stdout: `${CONTAINER_ID}\n`, stderr: "" });
          }
          if (args[0] === "inspect") {
            return Effect.succeed({
              exitCode: 0,
              stdout: inspectJson(`t3-sandbox-${SANDBOX_ENVIRONMENT_ID}`),
              stderr: "",
            });
          }
          // What an image whose `t3` predates the subcommand does: "pair" is
          // read as a working directory, a second server starts, and the
          // in-container `timeout` eventually kills it with exit code 124.
          if (args[0] === "exec") {
            return Effect.succeed({ exitCode: 124, stdout: "", stderr: "" });
          }
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        },
      };
      const manager = yield* makeWithRunner({
        image: "example/t3-sandbox@sha256:abc",
        ownerEnvironmentId: OWNER_ENVIRONMENT_ID,
        runner,
        httpClient,
        randomUUID: Effect.succeed(SANDBOX_ID),
        archiveHeadTree: () => Effect.succeed(ARCHIVE_PATH),
        credentialSources: Effect.succeed([]),
        stageCredential: () => Effect.succeed(STAGED_CREDENTIAL_PATH),
        providerEnvironment: [],
      });

      const failure = yield* manager.pair({ sandboxId: SANDBOX_ID }).pipe(Effect.flip);

      expect(failure.reason).toBe("pair-unsupported");
      const pairCommand = commands.find((args) => args[0] === "exec");
      // Bounded inside the container so no second server is left behind.
      expect(pairCommand?.join(" ")).toContain("timeout");
    }),
  );

  it.effect("re-pairs itself on start from the token the new boot writes", () =>
    Effect.gen(function* () {
      // A restarted container keeps every boot in one log, so the previous
      // boot's token stays the last line until the new one banners.
      let log = "Token: STALEFIRSTBOOT\nListening\n";
      const runner: DockerCommandRunner = {
        run: (args) => {
          if (args[0] === "ps") {
            return Effect.succeed({ exitCode: 0, stdout: `${CONTAINER_ID}\n`, stderr: "" });
          }
          if (args[0] === "inspect") {
            return Effect.succeed({
              exitCode: 0,
              stdout: inspectJson(`t3-sandbox-${SANDBOX_ENVIRONMENT_ID}`),
              stderr: "",
            });
          }
          if (args[0] === "start") {
            log += "Token: FRESHESTBOOT\n";
            return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
          }
          if (args[0] === "logs") {
            return Effect.succeed({ exitCode: 0, stdout: log, stderr: "" });
          }
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        },
      };
      const manager = yield* makeWithRunner({
        image: "example/t3-sandbox@sha256:abc",
        ownerEnvironmentId: OWNER_ENVIRONMENT_ID,
        runner,
        httpClient,
        randomUUID: Effect.succeed(SANDBOX_ID),
        archiveHeadTree: () => Effect.succeed(ARCHIVE_PATH),
        credentialSources: Effect.succeed([]),
        stageCredential: () => Effect.succeed(STAGED_CREDENTIAL_PATH),
        providerEnvironment: [],
      });

      const started = yield* manager.start({ sandboxId: SANDBOX_ID });

      expect(started.sandbox.sandboxId).toBe(SANDBOX_ID);
      expect(started.pairingUrl).toBe("http://127.0.0.1:49152/pair#token=FRESHESTBOOT");
    }),
  );

  it.effect("never hands back the spent token of the boot before a start", () =>
    Effect.gen(function* () {
      // The port answers immediately but the new boot never banners, so the
      // only token in the log is the one the previous boot already spent.
      const runner: DockerCommandRunner = {
        run: (args) => {
          if (args[0] === "ps") {
            return Effect.succeed({ exitCode: 0, stdout: `${CONTAINER_ID}\n`, stderr: "" });
          }
          if (args[0] === "inspect") {
            return Effect.succeed({
              exitCode: 0,
              stdout: inspectJson(`t3-sandbox-${SANDBOX_ENVIRONMENT_ID}`),
              stderr: "",
            });
          }
          if (args[0] === "logs") {
            return Effect.succeed({ exitCode: 0, stdout: "Token: SPENTONLASTBOOT\n", stderr: "" });
          }
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        },
      };
      const manager = yield* makeWithRunner({
        image: "example/t3-sandbox@sha256:abc",
        ownerEnvironmentId: OWNER_ENVIRONMENT_ID,
        runner,
        httpClient,
        randomUUID: Effect.succeed(SANDBOX_ID),
        archiveHeadTree: () => Effect.succeed(ARCHIVE_PATH),
        credentialSources: Effect.succeed([]),
        stageCredential: () => Effect.succeed(STAGED_CREDENTIAL_PATH),
        providerEnvironment: [],
      });

      const fiber = yield* manager.start({ sandboxId: SANDBOX_ID }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      // Past the retry window, so the wait for a fresh banner has given up.
      yield* TestClock.adjust(Duration.seconds(60));
      const started = yield* Fiber.join(fiber);

      // Still started, just not re-paired: the settings page offers an explicit
      // pair, and a dead link would look like success.
      expect(started.sandbox.sandboxId).toBe(SANDBOX_ID);
      expect(started.pairingUrl).toBeUndefined();
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("pairs from the startup log when the image has no `t3 pair`", () =>
    Effect.gen(function* () {
      const runner: DockerCommandRunner = {
        run: (args) => {
          if (args[0] === "ps") {
            return Effect.succeed({ exitCode: 0, stdout: `${CONTAINER_ID}\n`, stderr: "" });
          }
          if (args[0] === "inspect") {
            return Effect.succeed({
              exitCode: 0,
              stdout: inspectJson(`t3-sandbox-${SANDBOX_ENVIRONMENT_ID}`),
              stderr: "",
            });
          }
          if (args[0] === "exec") {
            return Effect.succeed({ exitCode: TIMEOUT_EXIT_CODE, stdout: "", stderr: "" });
          }
          if (args[0] === "logs") {
            return Effect.succeed({ exitCode: 0, stdout: "Token: FROMBOOTLOG\n", stderr: "" });
          }
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        },
      };
      const manager = yield* makeWithRunner({
        image: "example/t3-sandbox@sha256:abc",
        ownerEnvironmentId: OWNER_ENVIRONMENT_ID,
        runner,
        httpClient,
        randomUUID: Effect.succeed(SANDBOX_ID),
        archiveHeadTree: () => Effect.succeed(ARCHIVE_PATH),
        credentialSources: Effect.succeed([]),
        stageCredential: () => Effect.succeed(STAGED_CREDENTIAL_PATH),
        providerEnvironment: [],
      });

      const paired = yield* manager.pair({ sandboxId: SANDBOX_ID });

      expect(paired.pairingUrl).toBe("http://127.0.0.1:49152/pair#token=FROMBOOTLOG");
    }),
  );

  it.effect("places seeded credentials as the container user, not as root", () =>
    Effect.gen(function* () {
      const commands: Array<ReadonlyArray<string>> = [];
      const log = bootLog();
      const runner: DockerCommandRunner = {
        run: (args) => {
          commands.push(args);
          if (args[0] === "ps") {
            return Effect.succeed({ exitCode: 0, stdout: `${CONTAINER_ID}\n`, stderr: "" });
          }
          if (args[0] === "inspect") {
            return Effect.succeed({
              exitCode: 0,
              stdout: inspectJson(`t3-sandbox-${SANDBOX_ENVIRONMENT_ID}`),
              stderr: "",
            });
          }
          if (args[0] === "start") {
            log.onStart();
            return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
          }
          if (args[0] === "logs") {
            return Effect.succeed({ exitCode: 0, stdout: log.read(), stderr: "" });
          }
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        },
      };
      const manager = yield* makeWithRunner({
        image: "example/t3-sandbox@sha256:abc",
        ownerEnvironmentId: OWNER_ENVIRONMENT_ID,
        runner,
        httpClient,
        randomUUID: Effect.succeed(SANDBOX_ID),
        archiveHeadTree: () => Effect.succeed(ARCHIVE_PATH),
        credentialSources: Effect.succeed([
          { hostPath: "/Users/dev/.codex/auth.json", relativePath: ".codex/auth.json" },
        ]),
        stageCredential: () => Effect.succeed(STAGED_CREDENTIAL_PATH),
        providerEnvironment: [],
      });

      yield* manager.start({ sandboxId: SANDBOX_ID });

      // Staged by `docker cp` (which writes as root), then placed by the
      // container's user so a later provider login can still overwrite it.
      expect(commands).toContainEqual([
        "cp",
        STAGED_CREDENTIAL_PATH,
        `${CONTAINER_ID}:/t3-home/.t3-credential-stage`,
      ]);
      const place = commands.find(
        (args) => args[0] === "exec" && (args.at(4) ?? "").includes("chmod 600"),
      );
      assert.isDefined(place);
      expect(place?.slice(-2)).toEqual(["sh", "/t3-home/.codex/auth.json"]);
    }),
  );

  it.effect("copies no credentials when the operator has not opted in", () =>
    Effect.gen(function* () {
      const commands: Array<ReadonlyArray<string>> = [];
      const log = bootLog();
      const runner: DockerCommandRunner = {
        run: (args) => {
          commands.push(args);
          if (args[0] === "ps") {
            return Effect.succeed({ exitCode: 0, stdout: `${CONTAINER_ID}\n`, stderr: "" });
          }
          if (args[0] === "inspect") {
            return Effect.succeed({
              exitCode: 0,
              stdout: inspectJson(`t3-sandbox-${SANDBOX_ENVIRONMENT_ID}`),
              stderr: "",
            });
          }
          if (args[0] === "start") {
            log.onStart();
            return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
          }
          if (args[0] === "logs") {
            return Effect.succeed({ exitCode: 0, stdout: log.read(), stderr: "" });
          }
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        },
      };
      const manager = yield* makeWithRunner({
        image: "example/t3-sandbox@sha256:abc",
        ownerEnvironmentId: OWNER_ENVIRONMENT_ID,
        runner,
        httpClient,
        randomUUID: Effect.succeed(SANDBOX_ID),
        archiveHeadTree: () => Effect.succeed(ARCHIVE_PATH),
        credentialSources: Effect.succeed([]),
        stageCredential: () => Effect.succeed(STAGED_CREDENTIAL_PATH),
        providerEnvironment: [],
      });

      yield* manager.start({ sandboxId: SANDBOX_ID });

      expect(commands.some((args) => args[0] === "cp")).toBe(false);
    }),
  );

  it.effect("gives a sandbox its own Codex credential rather than the host session", () =>
    Effect.gen(function* () {
      const staged: Array<{ readonly relativePath: string; readonly contents?: string }> = [];
      const log = bootLog();
      const runner: DockerCommandRunner = {
        run: (args) => {
          if (args[0] === "ps") {
            return Effect.succeed({ exitCode: 0, stdout: `${CONTAINER_ID}\n`, stderr: "" });
          }
          if (args[0] === "inspect") {
            return Effect.succeed({
              exitCode: 0,
              stdout: inspectJson(`t3-sandbox-${SANDBOX_ENVIRONMENT_ID}`),
              stderr: "",
            });
          }
          if (args[0] === "start") {
            log.onStart();
            return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
          }
          if (args[0] === "logs") {
            return Effect.succeed({ exitCode: 0, stdout: log.read(), stderr: "" });
          }
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        },
      };
      const manager = yield* makeWithRunner({
        image: "example/t3-sandbox@sha256:abc",
        ownerEnvironmentId: OWNER_ENVIRONMENT_ID,
        runner,
        httpClient,
        randomUUID: Effect.succeed(SANDBOX_ID),
        archiveHeadTree: () => Effect.succeed(ARCHIVE_PATH),
        credentialSources: Effect.succeed([
          {
            relativePath: ".codex/auth.json",
            contents: '{"auth_mode":"apikey","OPENAI_API_KEY":"sk-sandbox"}',
          },
        ]),
        stageCredential: (source) =>
          Effect.sync(() => {
            staged.push({
              relativePath: source.relativePath,
              ...(source.contents !== undefined ? { contents: source.contents } : {}),
            });
            return STAGED_CREDENTIAL_PATH;
          }),
        providerEnvironment: [],
      });

      yield* manager.start({ sandboxId: SANDBOX_ID });

      // Generated, not read from the operator's home: the sandbox holds a
      // credential that can be revoked without touching the host login.
      expect(staged).toHaveLength(1);
      expect(staged[0]?.relativePath).toBe(".codex/auth.json");
      expect(staged[0]?.contents).toContain("sk-sandbox");
      expect(staged[0]?.contents).not.toContain("refresh_token");
    }),
  );

  it.effect("passes dedicated provider keys to the container as environment", () =>
    Effect.gen(function* () {
      const commands: Array<ReadonlyArray<string>> = [];
      let renamed = false;
      const runner: DockerCommandRunner = {
        run: (args) => {
          commands.push(args);
          if (args[0] === "image" && args[1] === "inspect") {
            return Effect.succeed({ exitCode: 0, stdout: '"node"\n', stderr: "" });
          }
          if (args[0] === "run") {
            return Effect.succeed({ exitCode: 0, stdout: `${CONTAINER_ID}\n`, stderr: "" });
          }
          if (args[0] === "inspect") {
            const name = renamed
              ? `t3-sandbox-${SANDBOX_ENVIRONMENT_ID}`
              : `t3-sandbox-pending-${SANDBOX_ID}`;
            return Effect.succeed({ exitCode: 0, stdout: inspectJson(name), stderr: "" });
          }
          if (args[0] === "logs") {
            return Effect.succeed({ exitCode: 0, stdout: "Token: PAIRCODE\n", stderr: "" });
          }
          if (args[0] === "rename") {
            renamed = true;
          }
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        },
      };
      const manager = yield* makeWithRunner({
        image: "example/t3-sandbox@sha256:abc",
        ownerEnvironmentId: OWNER_ENVIRONMENT_ID,
        runner,
        httpClient,
        randomUUID: Effect.succeed(SANDBOX_ID),
        archiveHeadTree: () => Effect.succeed(ARCHIVE_PATH),
        credentialSources: Effect.succeed([]),
        stageCredential: () => Effect.succeed(STAGED_CREDENTIAL_PATH),
        providerEnvironment: [["ANTHROPIC_API_KEY", "sk-ant-sandbox"]],
      });

      yield* manager.create;

      const runCommand = commands.find((args) => args[0] === "run");
      expect(runCommand).toContain("ANTHROPIC_API_KEY=sk-ant-sandbox");
      // Still no host mount, no host home, nothing of the operator's session.
      expect(runCommand?.join(" ")).not.toContain(".codex");
      expect(runCommand?.join(" ")).not.toContain("type=bind");
    }),
  );

  it.effect("reports the running build and the limits actually in force", () =>
    Effect.gen(function* () {
      const runner: DockerCommandRunner = {
        run: (args) => {
          if (args[0] === "ps") {
            return Effect.succeed({ exitCode: 0, stdout: `${CONTAINER_ID}\n`, stderr: "" });
          }
          if (args[0] === "inspect") {
            return Effect.succeed({
              exitCode: 0,
              stdout: inspectJson(`t3-sandbox-${SANDBOX_ENVIRONMENT_ID}`),
              stderr: "",
            });
          }
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        },
      };
      const manager = yield* makeWithRunner({
        image: "example/t3-sandbox@sha256:abc",
        ownerEnvironmentId: OWNER_ENVIRONMENT_ID,
        runner,
        httpClient,
        randomUUID: Effect.succeed(SANDBOX_ID),
        archiveHeadTree: () => Effect.succeed(ARCHIVE_PATH),
        credentialSources: Effect.succeed([]),
        stageCredential: () => Effect.succeed(STAGED_CREDENTIAL_PATH),
        providerEnvironment: [],
      });

      const listed = yield* manager.list;
      const sandbox = listed.sandboxes[0];

      // The resolved digest, not just the tag the operator configured.
      expect(sandbox?.imageId).toBe(
        "sha256:feedfacedeadbeef0123456789abcdef0123456789abcdef0123456789abcdef",
      );
      expect(sandbox?.resources).toEqual({
        memoryBytes: 4 * 1024 ** 3,
        cpus: 2,
        pidsLimit: 512,
      });
      expect(sandbox?.startedAt).toBe("2026-08-27T12:00:01.000000000Z");
    }),
  );

  it.effect("omits container detail a Docker version does not report", () =>
    Effect.gen(function* () {
      const bare = bareInspectJson();
      const runner: DockerCommandRunner = {
        run: (args) => {
          if (args[0] === "ps") {
            return Effect.succeed({ exitCode: 0, stdout: `${CONTAINER_ID}\n`, stderr: "" });
          }
          if (args[0] === "inspect") {
            return Effect.succeed({ exitCode: 0, stdout: bare, stderr: "" });
          }
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        },
      };
      const manager = yield* makeWithRunner({
        image: "example/t3-sandbox@sha256:abc",
        ownerEnvironmentId: OWNER_ENVIRONMENT_ID,
        runner,
        httpClient,
        randomUUID: Effect.succeed(SANDBOX_ID),
        archiveHeadTree: () => Effect.succeed(ARCHIVE_PATH),
        credentialSources: Effect.succeed([]),
        stageCredential: () => Effect.succeed(STAGED_CREDENTIAL_PATH),
        providerEnvironment: [],
      });

      const listed = yield* manager.list;

      expect(listed.sandboxes).toHaveLength(1);
      expect(listed.sandboxes[0]?.imageId).toBeUndefined();
      expect(listed.sandboxes[0]?.resources).toBeUndefined();
      expect(listed.sandboxes[0]?.startedAt).toBeUndefined();
    }),
  );

  it.effect("seeds every provider credential it is given, nested paths included", () =>
    Effect.gen(function* () {
      const placed: Array<string> = [];
      const log = bootLog();
      const runner: DockerCommandRunner = {
        run: (args) => {
          if (args[0] === "ps") {
            return Effect.succeed({ exitCode: 0, stdout: `${CONTAINER_ID}\n`, stderr: "" });
          }
          if (args[0] === "inspect") {
            return Effect.succeed({
              exitCode: 0,
              stdout: inspectJson(`t3-sandbox-${SANDBOX_ENVIRONMENT_ID}`),
              stderr: "",
            });
          }
          if (args[0] === "start") {
            log.onStart();
            return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
          }
          if (args[0] === "logs") {
            return Effect.succeed({ exitCode: 0, stdout: log.read(), stderr: "" });
          }
          if (args[0] === "exec" && (args.at(4) ?? "").includes("chmod 600")) {
            placed.push(args.at(-1) ?? "");
          }
          return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
        },
      };
      const manager = yield* makeWithRunner({
        image: "example/t3-sandbox@sha256:abc",
        ownerEnvironmentId: OWNER_ENVIRONMENT_ID,
        runner,
        httpClient,
        randomUUID: Effect.succeed(SANDBOX_ID),
        archiveHeadTree: () => Effect.succeed(ARCHIVE_PATH),
        credentialSources: Effect.succeed([
          { hostPath: "/Users/dev/.codex/auth.json", relativePath: ".codex/auth.json" },
          // Generated from the macOS keychain, which has no file to copy.
          { relativePath: ".claude/.credentials.json", contents: '{"claudeAiOauth":{}}' },
          {
            hostPath: "/Users/dev/.local/share/opencode/auth.json",
            relativePath: ".local/share/opencode/auth.json",
          },
        ]),
        stageCredential: () => Effect.succeed(STAGED_CREDENTIAL_PATH),
        providerEnvironment: [],
      });

      yield* manager.start({ sandboxId: SANDBOX_ID });

      expect(placed).toEqual([
        "/t3-home/.codex/auth.json",
        "/t3-home/.claude/.credentials.json",
        "/t3-home/.local/share/opencode/auth.json",
      ]);
    }),
  );
});
