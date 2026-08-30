import {
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  LocalDockerSandbox,
  LocalDockerSandboxError,
  LocalDockerSandboxId,
  LocalDockerSandboxStatus,
  type LocalDockerSandboxPrepareWorkspaceResult,
  type LocalDockerSandboxStartResult,
  type LocalDockerSandboxOperation,
  type LocalDockerSandboxTargetInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { buildPairingUrl } from "../startupAccess.ts";

const OWNER_LABEL = "dev.t3code.local-sandbox.owner";
const SANDBOX_LABEL = "dev.t3code.local-sandbox.id";
const MANAGED_LABEL = "dev.t3code.local-sandbox";
const CONTAINER_PORT = 3773;
const CONTAINER_NAME_PREFIX = "t3-sandbox-";
const PENDING_CONTAINER_NAME_PREFIX = "t3-sandbox-pending-";
const VOLUME_NAME_PREFIX = "t3-sandbox-";
// `t3 pair` returns in well under a second. An image whose `t3` predates the
// subcommand parses "pair" as a working directory and starts a *second* server
// instead, which never exits — so the call is bounded inside the container (no
// orphaned process) and again outside it (in case `timeout` is unavailable).
const PAIR_TIMEOUT_SECONDS = 15;
const PAIR_TIMEOUT = Duration.seconds(30);
const TIMEOUT_EXIT_CODE = 124;
const STARTUP_ATTEMPTS = 120;
const STARTUP_RETRY_INTERVAL = Duration.millis(250);
const WORKSPACE_ROOT = "/workspace";
const HOME_ROOT = "/t3-home";
const CREDENTIAL_STAGE_PATH = `${HOME_ROOT}/.t3-credential-stage`;
/**
 * Provider credential files, relative to the operator's home directory. Only
 * credentials: files like `.claude.json` also carry host project history, which
 * has no business inside a sandbox.
 */
const SEEDED_CREDENTIAL_PATHS = [
  ".codex/auth.json",
  // Claude Code on Linux. On macOS the same content lives in the login
  // keychain instead, which is read separately below.
  ".claude/.credentials.json",
  ".local/share/opencode/auth.json",
  ".config/opencode/auth.json",
] as const;

/** Where Claude Code keeps its credentials on macOS, and the file the same
    content belongs in inside a Linux container. */
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CLAUDE_CREDENTIALS_RELATIVE_PATH = ".claude/.credentials.json";
const CODEX_AUTH_RELATIVE_PATH = ".codex/auth.json";

/**
 * A credential to place in a sandbox: either copied from a host file, or
 * generated, which is how a sandbox gets a credential of its own rather than a
 * second copy of the operator's session.
 */
const CodexApiKeyAuth = Schema.Struct({
  auth_mode: Schema.Literals(["apikey"]),
  OPENAI_API_KEY: Schema.String,
});
const encodeCodexApiKeyAuth = Schema.encodeEffect(Schema.fromJsonString(CodexApiKeyAuth));

export interface CredentialSource {
  readonly relativePath: string;
  readonly hostPath?: string;
  readonly contents?: string;
}
/**
 * Placed by the container's own user so the file lands with its ownership and
 * mode: `docker cp` writes as root, which a later provider login could not
 * overwrite. The staged copy is removed on every exit path, including failure.
 */
const CREDENTIAL_PLACE_SCRIPT = [
  "set -e",
  `trap 'rm -f ${CREDENTIAL_STAGE_PATH}' EXIT`,
  'mkdir -p "$(dirname "$1")"',
  `cp ${CREDENTIAL_STAGE_PATH} "$1"`,
  'chmod 600 "$1"',
].join("\n");
// Staged inside the workspace volume, not on the container's tmpfs: `docker cp`
// refuses any destination on a read-only rootfs, mounts included.
const SEED_ARCHIVE_PATH = `${WORKSPACE_ROOT}/.t3-workspace-seed.tar`;
/** Directory names are derived from a host checkout, never from RPC input, but
    they still reach a container shell, so keep them to an unambiguous set. */
const SAFE_DIRECTORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
/** Runs as the image's non-root user with "$1" bound to the target directory. */
const SEED_SCRIPT = [
  "set -e",
  'mkdir -p "$1"',
  `tar -xf ${SEED_ARCHIVE_PATH} -C "$1"`,
  `rm -f ${SEED_ARCHIVE_PATH}`,
  'cd "$1"',
  "git init -q",
  "git add -A",
  'git -c user.name="T3 Code" -c user.email="sandbox@t3.codes" commit -q -m "Seed sandbox workspace"',
].join("\n");

const RawDockerInspect = Schema.Struct({
  Id: Schema.String,
  Name: Schema.String,
  Created: Schema.String,
  // Optional so a Docker version that reshapes these does not break listing:
  // they are presentation detail, not something a sandbox depends on.
  Image: Schema.optionalKey(Schema.String),
  Config: Schema.Struct({
    Image: Schema.String,
    Labels: Schema.Unknown,
  }),
  HostConfig: Schema.optionalKey(
    Schema.Struct({
      Memory: Schema.optionalKey(Schema.NullOr(Schema.Number)),
      NanoCpus: Schema.optionalKey(Schema.NullOr(Schema.Number)),
      PidsLimit: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    }),
  ),
  State: Schema.Struct({
    Status: LocalDockerSandboxStatus,
    StartedAt: Schema.optionalKey(Schema.String),
  }),
  NetworkSettings: Schema.Struct({
    Ports: Schema.Unknown,
  }),
});
type RawDockerInspect = typeof RawDockerInspect.Type;

const decodeDockerInspect = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Array(RawDockerInspect)),
);
const decodeEnvironmentDescriptor = Schema.decodeUnknownEffect(ExecutionEnvironmentDescriptor);
const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeSandboxId = Schema.decodeUnknownOption(LocalDockerSandboxId);
const decodeJsonString = Schema.decodeEffect(Schema.fromJsonString(Schema.String));

interface DockerCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DockerCommandRunner {
  readonly run: (
    args: ReadonlyArray<string>,
  ) => Effect.Effect<DockerCommandResult, DockerCommandRunnerError>;
}

export class DockerCommandRunnerError extends Schema.TaggedErrorClass<DockerCommandRunnerError>()(
  "DockerCommandRunnerError",
  { cause: Schema.Defect() },
) {}

export interface LocalDockerSandboxManagerShape {
  readonly list: Effect.Effect<
    { readonly image: string; readonly sandboxes: ReadonlyArray<LocalDockerSandbox> },
    LocalDockerSandboxError
  >;
  readonly create: Effect.Effect<
    { readonly sandbox: LocalDockerSandbox; readonly pairingUrl: string },
    LocalDockerSandboxError
  >;
  readonly start: (
    input: LocalDockerSandboxTargetInput,
  ) => Effect.Effect<LocalDockerSandboxStartResult, LocalDockerSandboxError>;
  readonly stop: (
    input: LocalDockerSandboxTargetInput,
  ) => Effect.Effect<LocalDockerSandbox, LocalDockerSandboxError>;
  readonly delete: (
    input: LocalDockerSandboxTargetInput,
  ) => Effect.Effect<{}, LocalDockerSandboxError>;
  readonly pair: (
    input: LocalDockerSandboxTargetInput,
  ) => Effect.Effect<{ readonly pairingUrl: string }, LocalDockerSandboxError>;
  readonly prepareWorkspace: (input: {
    readonly sandboxId: LocalDockerSandboxId;
    readonly projectRoot: string;
  }) => Effect.Effect<LocalDockerSandboxPrepareWorkspaceResult, LocalDockerSandboxError>;
}

export class LocalDockerSandboxManager extends Context.Service<
  LocalDockerSandboxManager,
  LocalDockerSandboxManagerShape
>()("t3/localDockerSandbox/Manager/LocalDockerSandboxManager") {}

const commandOutput = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (output, chunk) => output + chunk,
    ),
  );

const liveDockerCommandRunner = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return {
    run: (args) =>
      Effect.gen(function* () {
        const child = yield* spawner.spawn(ChildProcess.make("docker", args));
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [commandOutput(child.stdout), commandOutput(child.stderr), child.exitCode],
          { concurrency: "unbounded" },
        );
        return { stdout, stderr, exitCode: Number(exitCode) };
      }).pipe(
        Effect.scoped,
        Effect.mapError((cause) => new DockerCommandRunnerError({ cause })),
      ),
  } satisfies DockerCommandRunner;
});

const error = (operation: LocalDockerSandboxOperation, reason: LocalDockerSandboxError["reason"]) =>
  new LocalDockerSandboxError({ operation, reason });

function labelValue(labels: unknown, key: string): string | undefined {
  if (typeof labels !== "object" || labels === null || Array.isArray(labels)) return undefined;
  const value = Reflect.get(labels, key);
  return typeof value === "string" ? value : undefined;
}

function mappedHostPort(ports: unknown): number | undefined {
  if (typeof ports !== "object" || ports === null || Array.isArray(ports)) return undefined;
  const bindings = Reflect.get(ports, `${CONTAINER_PORT}/tcp`);
  if (!Array.isArray(bindings)) return undefined;
  const first = bindings[0];
  if (typeof first !== "object" || first === null || Array.isArray(first)) return undefined;
  const rawPort = Reflect.get(first, "HostPort");
  if (typeof rawPort !== "string" || !/^\d+$/u.test(rawPort)) return undefined;
  const port = Number(rawPort);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
}

function environmentIdFromName(name: string): EnvironmentId | undefined {
  const normalized = name.startsWith("/") ? name.slice(1) : name;
  if (!normalized.startsWith(CONTAINER_NAME_PREFIX)) return undefined;
  const candidate = normalized.slice(CONTAINER_NAME_PREFIX.length);
  if (candidate.startsWith("pending-")) return undefined;
  return Option.getOrUndefined(decodeEnvironmentId(candidate));
}

const positive = (value: number | null | undefined): number | undefined =>
  typeof value === "number" && value > 0 ? value : undefined;

function toResources(hostConfig: RawDockerInspect["HostConfig"]): LocalDockerSandbox["resources"] {
  if (hostConfig === undefined) return undefined;
  const memoryBytes = positive(hostConfig.Memory);
  const nanoCpus = positive(hostConfig.NanoCpus);
  const pidsLimit = positive(hostConfig.PidsLimit);
  const resources = {
    ...(memoryBytes === undefined ? {} : { memoryBytes }),
    ...(nanoCpus === undefined ? {} : { cpus: nanoCpus / 1_000_000_000 }),
    ...(pidsLimit === undefined ? {} : { pidsLimit }),
  };
  return Object.keys(resources).length === 0 ? undefined : resources;
}

// Docker reports a zero time for a container that has never run.
const runStartedAt = (value: string | undefined): string | undefined =>
  value === undefined || value.startsWith("0001-01-01") ? undefined : value;

function toSandbox(container: RawDockerInspect): LocalDockerSandbox | null {
  const sandboxIdRaw = labelValue(container.Config.Labels, SANDBOX_LABEL);
  const sandboxId = Option.getOrUndefined(decodeSandboxId(sandboxIdRaw));
  if (sandboxId === undefined) return null;
  const hostPort = mappedHostPort(container.NetworkSettings.Ports);
  const environmentId = environmentIdFromName(container.Name);
  const resources = toResources(container.HostConfig);
  const startedAt = runStartedAt(container.State.StartedAt);
  return {
    sandboxId,
    ...(environmentId === undefined ? {} : { environmentId }),
    image: container.Config.Image,
    ...(container.Image === undefined ? {} : { imageId: container.Image }),
    status: container.State.Status,
    createdAt: container.Created,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(hostPort === undefined ? {} : { hostPort }),
    ...(resources === undefined ? {} : { resources }),
  };
}

const volumeNames = (sandboxId: LocalDockerSandboxId) => ({
  workspace: `${VOLUME_NAME_PREFIX}${sandboxId}-workspace`,
  data: `${VOLUME_NAME_PREFIX}${sandboxId}-data`,
  home: `${VOLUME_NAME_PREFIX}${sandboxId}-home`,
});

function directoryNameFor(projectRoot: string): string | undefined {
  const segments = projectRoot.split(/[\\/]+/u).filter((segment) => segment.length > 0);
  const name = segments.at(-1);
  return name !== undefined && SAFE_DIRECTORY_NAME.test(name) ? name : undefined;
}

/**
 * Both `t3 serve` startup output and `t3 pair` print the credential on a
 * `Token:` line. A restarted container keeps its earlier boots in the same log,
 * so the *last* line is the live one.
 */
const tokenFromOutput = (output: string): string | undefined =>
  [...output.matchAll(/^Token:\s+(\S+)\s*$/gmu)].at(-1)?.[1];

export const makeWithRunner = (input: {
  readonly image: string | undefined;
  readonly ownerEnvironmentId: EnvironmentId;
  readonly runner: DockerCommandRunner;
  readonly httpClient: HttpClient.HttpClient;
  readonly randomUUID: Effect.Effect<string, LocalDockerSandboxError>;
  /**
   * Writes a tar of the project's committed HEAD tree somewhere on the host and
   * yields that path. Scoped so the archive is deleted once the copy finishes.
   */
  readonly archiveHeadTree: (
    projectRoot: string,
  ) => Effect.Effect<string, LocalDockerSandboxError, Scope.Scope>;
  /**
   * Host provider credentials to copy into a sandbox, already filtered to the
   * files that exist. Empty unless the operator opted in.
   */
  readonly credentialSources: Effect.Effect<
    ReadonlyArray<CredentialSource>,
    LocalDockerSandboxError
  >;
  /**
   * Yields a readable copy of a host credential file. `docker cp` preserves the
   * source mode and hands ownership to root, so copying a 600 file straight in
   * produces one the sandbox user cannot read.
   */
  readonly stageCredential: (
    source: CredentialSource,
  ) => Effect.Effect<string, LocalDockerSandboxError, Scope.Scope>;
  /**
   * Provider API keys handed to the container as environment variables, which
   * is how both CLIs accept a key. Dedicated keys, never the operator's own
   * sign-in: a sandbox that carries the host session is not a sandbox.
   */
  readonly providerEnvironment: ReadonlyArray<readonly [string, string]>;
}) =>
  Effect.gen(function* () {
    const mutationLock = yield* Semaphore.make(1);
    const image = input.image?.trim() || undefined;
    const archiveHeadTree = input.archiveHeadTree;

    const requireImage = (operation: LocalDockerSandboxOperation) =>
      image === undefined ? Effect.fail(error(operation, "not-configured")) : Effect.succeed(image);

    const run = (
      operation: LocalDockerSandboxOperation,
      args: ReadonlyArray<string>,
      failureReason: LocalDockerSandboxError["reason"] = "command-failed",
    ) =>
      input.runner.run(args).pipe(
        Effect.mapError(() => error(operation, "docker-unavailable")),
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result)
            : Effect.fail(error(operation, failureReason)),
        ),
      );

    const inspectContainers = (
      operation: LocalDockerSandboxOperation,
      containerIds: ReadonlyArray<string>,
    ) =>
      containerIds.length === 0
        ? Effect.succeed([] as ReadonlyArray<RawDockerInspect>)
        : run(operation, ["inspect", ...containerIds]).pipe(
            Effect.flatMap((result) => decodeDockerInspect(result.stdout)),
            Effect.mapError(() => error(operation, "invalid-response")),
          );

    const findContainer = (
      operation: LocalDockerSandboxOperation,
      sandboxId: LocalDockerSandboxId,
    ) =>
      Effect.gen(function* () {
        const result = yield* run(operation, [
          "ps",
          "-aq",
          "--filter",
          `label=${MANAGED_LABEL}=true`,
          "--filter",
          `label=${OWNER_LABEL}=${input.ownerEnvironmentId}`,
          "--filter",
          `label=${SANDBOX_LABEL}=${sandboxId}`,
        ]);
        const ids = result.stdout
          .split(/\r?\n/u)
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
        if (ids.length === 0) return yield* error(operation, "not-found");
        if (ids.length > 1) return yield* error(operation, "conflict");
        const inspected = yield* inspectContainers(operation, ids);
        const container = inspected[0];
        if (container === undefined) return yield* error(operation, "not-found");
        return container;
      });

    const list = Effect.gen(function* () {
      const configuredImage = yield* requireImage("list");
      const result = yield* run("list", [
        "ps",
        "-aq",
        "--filter",
        `label=${MANAGED_LABEL}=true`,
        "--filter",
        `label=${OWNER_LABEL}=${input.ownerEnvironmentId}`,
      ]);
      const containerIds = result.stdout
        .split(/\r?\n/u)
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
      const containers = yield* inspectContainers("list", containerIds);
      return {
        image: configuredImage,
        sandboxes: containers
          .map(toSandbox)
          .filter((sandbox): sandbox is LocalDockerSandbox => sandbox !== null)
          .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt)),
      };
    });

    const inspectImageUser = (configuredImage: string) =>
      run(
        "create",
        ["image", "inspect", "--format", "{{json .Config.User}}", configuredImage],
        "image-unavailable",
      ).pipe(
        Effect.catch(() =>
          run("create", ["pull", configuredImage], "image-unavailable").pipe(
            Effect.andThen(
              run(
                "create",
                ["image", "inspect", "--format", "{{json .Config.User}}", configuredImage],
                "image-unavailable",
              ),
            ),
          ),
        ),
        Effect.flatMap((result) =>
          decodeJsonString(result.stdout.trim()).pipe(
            Effect.mapError(() => error("create", "invalid-response")),
          ),
        ),
        Effect.flatMap((configuredUser) => {
          if (typeof configuredUser !== "string") {
            return Effect.fail(error("create", "invalid-response"));
          }
          const user = configuredUser.trim().split(":", 1)[0]?.toLowerCase();
          return user === undefined || user === "" || user === "0" || user === "root"
            ? Effect.fail(error("create", "image-runs-as-root"))
            : Effect.void;
        }),
      );

    const removeContainer = (containerId: string) =>
      input.runner.run(["rm", "-f", containerId]).pipe(Effect.ignore);

    const removeVolumes = (sandboxId: LocalDockerSandboxId) =>
      Effect.forEach(Object.values(volumeNames(sandboxId)), (name) =>
        input.runner.run(["volume", "rm", "-f", name]).pipe(Effect.ignore),
      ).pipe(Effect.asVoid);

    const issuePairing = (
      operation: "create" | "pair" | "start",
      containerId: string,
      hostPort: number,
      mode: "startup" | "fresh",
    ) =>
      Effect.gen(function* () {
        const output =
          mode === "startup"
            ? yield* run(operation, ["logs", "--tail", "200", containerId], "startup-failed")
            : yield* input.runner
                .run([
                  "exec",
                  containerId,
                  "sh",
                  "-c",
                  'exec timeout -s TERM "$1" t3 pair --base-dir "$2"',
                  "sh",
                  String(PAIR_TIMEOUT_SECONDS),
                  "/t3-data",
                ])
                .pipe(
                  Effect.mapError(() => error(operation, "docker-unavailable")),
                  Effect.timeoutOrElse({
                    duration: PAIR_TIMEOUT,
                    orElse: () => Effect.fail(error(operation, "pair-unsupported")),
                  }),
                  Effect.flatMap((result) =>
                    result.exitCode === 0
                      ? Effect.succeed(result)
                      : Effect.fail(
                          error(
                            operation,
                            result.exitCode === TIMEOUT_EXIT_CODE
                              ? "pair-unsupported"
                              : "command-failed",
                          ),
                        ),
                  ),
                );
        const token = tokenFromOutput(output.stdout);
        if (token === undefined) return yield* error(operation, "startup-failed");
        return { token, pairingUrl: buildPairingUrl(`http://127.0.0.1:${hostPort}`, token) };
      });

    /** The token a container's log currently ends with, or undefined when it
        carries none. Best-effort: only ever used to recognise a stale one. */
    const lastStartupToken = (containerId: string) =>
      input.runner.run(["logs", "--tail", "200", containerId]).pipe(
        Effect.map((result) =>
          result.exitCode === 0 ? tokenFromOutput(result.stdout) : undefined,
        ),
        Effect.orElseSucceed(() => undefined),
      );

    const awaitCreatedSandbox = (containerId: string) =>
      Effect.gen(function* () {
        const inspected = yield* inspectContainers("create", [containerId]);
        const container = inspected[0];
        if (container === undefined || container.State.Status !== "running") {
          return yield* error("create", "startup-failed");
        }
        const hostPort = mappedHostPort(container.NetworkSettings.Ports);
        if (hostPort === undefined) return yield* error("create", "startup-failed");
        const pairing = yield* issuePairing("create", containerId, hostPort, "startup");
        const response = yield* input.httpClient
          .execute(HttpClientRequest.get(`http://127.0.0.1:${hostPort}/.well-known/t3/environment`))
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap((value) => value.json),
            Effect.flatMap(decodeEnvironmentDescriptor),
            Effect.mapError(() => error("create", "startup-failed")),
          );
        return { container, hostPort, pairingUrl: pairing.pairingUrl, descriptor: response };
      }).pipe(
        Effect.retry(
          Schedule.spaced(STARTUP_RETRY_INTERVAL).pipe(Schedule.upTo({ times: STARTUP_ATTEMPTS })),
        ),
        Effect.mapError(() => error("create", "startup-failed")),
      );

    // Best-effort: a sandbox that comes up without credentials is still usable,
    // and the provider surfaces its own "unauthenticated" state.
    const seedCredentials = (
      operation: "create" | "start" | "prepare-workspace",
      containerId: string,
    ) =>
      Effect.gen(function* () {
        const sources = yield* input.credentialSources;
        yield* Effect.forEach(sources, (source) =>
          Effect.scoped(
            Effect.gen(function* () {
              const staged = yield* input.stageCredential(source);
              yield* run(operation, ["cp", staged, `${containerId}:${CREDENTIAL_STAGE_PATH}`]);
              yield* run(operation, [
                "exec",
                containerId,
                "sh",
                "-c",
                CREDENTIAL_PLACE_SCRIPT,
                "sh",
                `${HOME_ROOT}/${source.relativePath}`,
              ]);
            }),
          ),
        );
      }).pipe(Effect.ignore);

    const awaitStartupPairing = (
      sandboxId: LocalDockerSandboxId,
      hostPort: number,
      previousToken: string | undefined,
    ) =>
      Effect.gen(function* () {
        yield* input.httpClient
          .execute(HttpClientRequest.get(`http://127.0.0.1:${hostPort}/.well-known/t3/environment`))
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.mapError(() => error("start", "startup-failed")),
          );
        const container = yield* findContainer("start", sandboxId);
        const pairing = yield* issuePairing("start", container.Id, hostPort, "startup");
        // The port can answer before the new boot's banner reaches the log, and
        // the previous boot's token is still the last one until it does. That
        // token is spent, so keep retrying rather than hand back a dead link.
        if (previousToken !== undefined && pairing.token === previousToken) {
          return yield* error("start", "startup-failed");
        }
        return pairing.pairingUrl;
      }).pipe(
        Effect.retry(
          Schedule.spaced(STARTUP_RETRY_INTERVAL).pipe(Schedule.upTo({ times: STARTUP_ATTEMPTS })),
        ),
        Effect.mapError(() => error("start", "startup-failed")),
      );

    const create = mutationLock.withPermits(1)(
      Effect.gen(function* () {
        const configuredImage = yield* requireImage("create");
        yield* inspectImageUser(configuredImage);
        const sandboxId = LocalDockerSandboxId.make(yield* input.randomUUID);
        const volumes = volumeNames(sandboxId);
        const createdVolumes: Array<string> = [];
        let containerId: string | undefined;

        return yield* Effect.gen(function* () {
          for (const name of Object.values(volumes)) {
            yield* run("create", [
              "volume",
              "create",
              "--label",
              `${MANAGED_LABEL}=true`,
              "--label",
              `${OWNER_LABEL}=${input.ownerEnvironmentId}`,
              "--label",
              `${SANDBOX_LABEL}=${sandboxId}`,
              name,
            ]);
            createdVolumes.push(name);
          }

          const launched = yield* run("create", [
            "run",
            "-d",
            "--name",
            `${PENDING_CONTAINER_NAME_PREFIX}${sandboxId}`,
            "--label",
            `${MANAGED_LABEL}=true`,
            "--label",
            `${OWNER_LABEL}=${input.ownerEnvironmentId}`,
            "--label",
            `${SANDBOX_LABEL}=${sandboxId}`,
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--pids-limit=512",
            "--memory=4g",
            "--cpus=2",
            "--init",
            "--stop-timeout=10",
            "--log-opt=max-size=10m",
            "--log-opt=max-file=2",
            "--network=bridge",
            // The server labels itself from its hostname, which Docker defaults
            // to the container id. Name it so the environment reads as a sandbox
            // wherever it is listed rather than as an opaque remote machine.
            "--hostname",
            `${CONTAINER_NAME_PREFIX}${sandboxId.slice(0, 8)}`,
            "--publish",
            `127.0.0.1::${CONTAINER_PORT}`,
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,nodev,size=512m",
            "--mount",
            `type=volume,src=${volumes.workspace},dst=/workspace`,
            "--mount",
            `type=volume,src=${volumes.data},dst=/t3-data`,
            "--mount",
            `type=volume,src=${volumes.home},dst=/t3-home`,
            "--env",
            "HOME=/t3-home",
            "--env",
            "T3CODE_HOME=/t3-data",
            ...input.providerEnvironment.flatMap(([name, value]) => ["--env", `${name}=${value}`]),
            "--workdir",
            "/workspace",
            "--entrypoint",
            "t3",
            configuredImage,
            "serve",
            "--host",
            "0.0.0.0",
            "--port",
            String(CONTAINER_PORT),
            "--base-dir",
            "/t3-data",
            "/workspace",
          ]);
          const launchedId = launched.stdout.trim();
          if (!/^[0-9a-f]{12,64}$/u.test(launchedId)) {
            return yield* error("create", "invalid-response");
          }
          containerId = launchedId;

          yield* seedCredentials("create", launchedId);
          const ready = yield* awaitCreatedSandbox(launchedId);
          yield* run("create", [
            "rename",
            launchedId,
            `${CONTAINER_NAME_PREFIX}${ready.descriptor.environmentId}`,
          ]);
          const renamed = yield* inspectContainers("create", [launchedId]);
          const sandbox = renamed[0] === undefined ? null : toSandbox(renamed[0]);
          if (sandbox === null) return yield* error("create", "invalid-response");
          return { sandbox, pairingUrl: ready.pairingUrl };
        }).pipe(
          Effect.onError(() =>
            Effect.gen(function* () {
              if (containerId !== undefined) yield* removeContainer(containerId);
              if (createdVolumes.length > 0) yield* removeVolumes(sandboxId);
            }),
          ),
        );
      }),
    );

    const mutateContainer = (
      operation: "start" | "stop",
      command: "start" | "stop",
      target: LocalDockerSandboxTargetInput,
    ) =>
      mutationLock.withPermits(1)(
        Effect.gen(function* () {
          yield* requireImage(operation);
          const container = yield* findContainer(operation, target.sandboxId);
          yield* run(operation, [command, container.Id]);
          const inspected = yield* inspectContainers(operation, [container.Id]);
          const sandbox = inspected[0] === undefined ? null : toSandbox(inspected[0]);
          if (sandbox === null) return yield* error(operation, "invalid-response");
          return sandbox;
        }),
      );

    // Every boot writes a one-time token to the container log, so a start can
    // hand the client a pairing link without the operator ever seeing a URL.
    // A sandbox that comes back without one is still usable, just not re-paired.
    const start = (target: LocalDockerSandboxTargetInput) =>
      Effect.gen(function* () {
        // The token the log ends with before this start. Docker keeps every
        // boot in one log, so this is the spent one a read can come back with
        // until the new boot banners its own.
        const previousToken = yield* findContainer("start", target.sandboxId).pipe(
          Effect.flatMap((container) => lastStartupToken(container.Id)),
          Effect.orElseSucceed(() => undefined),
        );
        const sandbox = yield* mutateContainer("start", "start", target);
        const container = yield* findContainer("start", target.sandboxId);
        yield* seedCredentials("start", container.Id);
        if (sandbox.hostPort === undefined) return { sandbox };
        const pairing = yield* awaitStartupPairing(
          target.sandboxId,
          sandbox.hostPort,
          previousToken,
        ).pipe(Effect.option);
        return Option.isNone(pairing) ? { sandbox } : { sandbox, pairingUrl: pairing.value };
      });

    const deleteSandbox = (target: LocalDockerSandboxTargetInput) =>
      mutationLock.withPermits(1)(
        Effect.gen(function* () {
          yield* requireImage("delete");
          const container = yield* findContainer("delete", target.sandboxId);
          yield* run("delete", ["rm", "-f", container.Id]);
          // `-f` so a sandbox whose volumes were already removed stays deletable.
          yield* Effect.forEach(Object.values(volumeNames(target.sandboxId)), (name) =>
            run("delete", ["volume", "rm", "-f", name]),
          );
          return {};
        }),
      );

    const pair = (target: LocalDockerSandboxTargetInput) =>
      mutationLock.withPermits(1)(
        Effect.gen(function* () {
          yield* requireImage("pair");
          const container = yield* findContainer("pair", target.sandboxId);
          if (container.State.Status !== "running") return yield* error("pair", "command-failed");
          const hostPort = mappedHostPort(container.NetworkSettings.Ports);
          if (hostPort === undefined) return yield* error("pair", "invalid-response");
          // An image without `t3 pair` can still be paired from the token its
          // last boot wrote, which is what makes a stop/start cycle a complete
          // recovery path rather than a dead end.
          const pairing = yield* issuePairing("pair", container.Id, hostPort, "fresh").pipe(
            Effect.catchIf(
              (failure) => failure.reason === "pair-unsupported",
              () =>
                issuePairing("pair", container.Id, hostPort, "startup").pipe(
                  // Keep the actionable reason when the boot token is gone too,
                  // rather than reporting a startup that in fact succeeded.
                  Effect.mapError(() => error("pair", "pair-unsupported")),
                ),
            ),
          );
          return { pairingUrl: pairing.pairingUrl };
        }),
      );

    // Seeds a directory under /workspace from the host checkout's HEAD tree, then
    // makes it a standalone repository so the sandbox can checkpoint normally.
    // Uncommitted host work is deliberately left behind: the copy is defined by
    // a commit, so a benchmark run is reproducible from its ref alone.
    const prepareWorkspace = (target: {
      readonly sandboxId: LocalDockerSandboxId;
      readonly projectRoot: string;
    }) =>
      mutationLock.withPermits(1)(
        Effect.gen(function* () {
          yield* requireImage("prepare-workspace");
          const directoryName = directoryNameFor(target.projectRoot);
          if (directoryName === undefined) {
            return yield* error("prepare-workspace", "workspace-seed-failed");
          }
          const workspacePath = `${WORKSPACE_ROOT}/${directoryName}`;
          const container = yield* findContainer("prepare-workspace", target.sandboxId);
          if (container.State.Status !== "running") {
            return yield* error("prepare-workspace", "not-running");
          }
          const environmentId = environmentIdFromName(container.Name);
          if (environmentId === undefined) {
            return yield* error("prepare-workspace", "not-found");
          }

          // Also seeded here, not only on create/start: a sandbox that is
          // already up should not need a restart to become usable.
          yield* seedCredentials("prepare-workspace", container.Id);

          const existing = yield* input.runner
            .run(["exec", container.Id, "sh", "-c", 'test -d "$1/.git"', "sh", workspacePath])
            .pipe(Effect.mapError(() => error("prepare-workspace", "docker-unavailable")));
          if (existing.exitCode === 0) {
            return { environmentId, workspacePath, seeded: false };
          }

          yield* Effect.scoped(
            Effect.gen(function* () {
              const archivePath = yield* archiveHeadTree(target.projectRoot);
              yield* run(
                "prepare-workspace",
                ["cp", archivePath, `${container.Id}:${SEED_ARCHIVE_PATH}`],
                "workspace-seed-failed",
              );
            }),
          );

          yield* run(
            "prepare-workspace",
            ["exec", container.Id, "sh", "-c", SEED_SCRIPT, "sh", workspacePath],
            "workspace-seed-failed",
          );

          return { environmentId, workspacePath, seeded: true };
        }),
      );

    return LocalDockerSandboxManager.of({
      list,
      create,
      start,
      stop: (target) => mutateContainer("stop", "stop", target),
      delete: deleteSandbox,
      pair,
      prepareWorkspace,
    });
  });

const liveArchiveHeadTree = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const seedFailed = () => error("prepare-workspace", "workspace-seed-failed");
  return (projectRoot: string) =>
    Effect.gen(function* () {
      const directory = yield* fs
        .makeTempDirectoryScoped({ prefix: "t3-sandbox-seed-" })
        .pipe(Effect.mapError(seedFailed));
      const archivePath = `${directory}/workspace.tar`;
      const child = yield* spawner
        .spawn(
          ChildProcess.make("git", [
            "-C",
            projectRoot,
            "archive",
            "--format=tar",
            "-o",
            archivePath,
            "HEAD",
          ]),
        )
        .pipe(Effect.mapError(seedFailed));
      const exitCode = Number(yield* child.exitCode.pipe(Effect.mapError(seedFailed)));
      // git exits non-zero when the project is not a repository or HEAD is unborn.
      if (exitCode !== 0) return yield* error("prepare-workspace", "project-not-a-repository");
      return archivePath;
    });
});

/**
 * Claude Code stores its credentials in the macOS login keychain rather than on
 * disk, so there is no file to copy: read it out and hand the container the
 * `.credentials.json` the Linux build expects.
 */
const claudeKeychainCredentials = Effect.gen(function* () {
  if ((yield* HostProcessPlatform) !== "darwin") return undefined;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make("security", ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"]),
  );
  const [output, exitCode] = yield* Effect.all([commandOutput(child.stdout), child.exitCode], {
    concurrency: "unbounded",
  });
  const trimmed = output.trim();
  return Number(exitCode) === 0 && trimmed.startsWith("{") ? trimmed : undefined;
}).pipe(
  Effect.scoped,
  Effect.orElseSucceed(() => undefined),
);

const liveCredentialSources = (input: {
  readonly enabled: boolean;
  readonly codexApiKey: string | undefined;
}): Effect.Effect<
  ReadonlyArray<CredentialSource>,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const found: Array<CredentialSource> = [];
    // A dedicated key gives the sandbox a credential the operator can revoke on
    // its own. Copying the host session would hand both sides one refresh token,
    // and a rotation by either can sign the other out.
    const codexApiKey = input.codexApiKey?.trim();
    if (codexApiKey !== undefined && codexApiKey !== "") {
      const contents = yield* encodeCodexApiKeyAuth({
        auth_mode: "apikey",
        OPENAI_API_KEY: codexApiKey,
      }).pipe(Effect.orElseSucceed(() => ""));
      if (contents !== "") found.push({ relativePath: CODEX_AUTH_RELATIVE_PATH, contents });
    }
    if (!input.enabled) return found;
    const fs = yield* FileSystem.FileSystem;
    const home = (yield* HostProcessEnvironment)["HOME"];
    if (home === undefined || home.trim() === "") return found;
    for (const relativePath of SEEDED_CREDENTIAL_PATHS) {
      if (found.some((source) => source.relativePath === relativePath)) continue;
      const hostPath = `${home}/${relativePath}`;
      const exists = yield* fs.exists(hostPath).pipe(Effect.orElseSucceed(() => false));
      if (exists) found.push({ hostPath, relativePath });
    }
    if (!found.some((source) => source.relativePath === CLAUDE_CREDENTIALS_RELATIVE_PATH)) {
      const keychain = yield* claudeKeychainCredentials;
      if (keychain !== undefined) {
        found.push({ relativePath: CLAUDE_CREDENTIALS_RELATIVE_PATH, contents: keychain });
      }
    }
    return found;
  });

const liveStageCredential = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return (source: CredentialSource) =>
    Effect.gen(function* () {
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-sandbox-credential-" });
      const stagedPath = `${directory}/credential`;
      if (source.contents === undefined) {
        yield* fs.copyFile(source.hostPath ?? "", stagedPath);
      } else {
        yield* fs.writeFileString(stagedPath, source.contents);
      }
      // Readable inside the container, which is single-user; the enclosing
      // temp directory keeps it unreadable to other users on the host.
      yield* fs.chmod(stagedPath, 0o644);
      return stagedPath;
    }).pipe(Effect.mapError(() => error("create", "command-failed")));
});

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const ownerEnvironmentId = yield* ServerEnvironment.ServerEnvironment.pipe(
    Effect.flatMap((environment) => environment.getEnvironmentId),
  );
  const runner = yield* liveDockerCommandRunner;
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const archiveHeadTree = yield* liveArchiveHeadTree;
  const stageCredential = yield* liveStageCredential;
  // Resolved once at layer construction: the set of credential files does not
  // change while the server runs, and each copy re-reads the file, so a
  // re-login on the host still reaches the next sandbox that starts.
  const providerEnvironment: Array<readonly [string, string]> = [];
  const anthropicApiKey = config.localDockerSandboxAnthropicApiKey?.trim();
  if (anthropicApiKey !== undefined && anthropicApiKey !== "") {
    providerEnvironment.push(["ANTHROPIC_API_KEY", anthropicApiKey]);
  }
  const openAiApiKey = config.localDockerSandboxCodexApiKey?.trim();
  if (openAiApiKey !== undefined && openAiApiKey !== "") {
    providerEnvironment.push(["OPENAI_API_KEY", openAiApiKey]);
  }
  const resolvedCredentialSources = yield* liveCredentialSources({
    enabled: config.localDockerSandboxSeedCredentials === true,
    codexApiKey: config.localDockerSandboxCodexApiKey,
  });
  return yield* makeWithRunner({
    image: config.localDockerSandboxImage,
    ownerEnvironmentId,
    runner,
    httpClient,
    randomUUID: crypto.randomUUIDv4.pipe(Effect.mapError(() => error("create", "command-failed"))),
    archiveHeadTree,
    credentialSources: Effect.succeed(resolvedCredentialSources),
    stageCredential,
    providerEnvironment,
  });
});

export const layer = Layer.effect(LocalDockerSandboxManager, make);
