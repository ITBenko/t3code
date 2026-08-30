import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  PortSchema,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const LocalDockerSandboxId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
).pipe(Schema.brand("LocalDockerSandboxId"));
export type LocalDockerSandboxId = typeof LocalDockerSandboxId.Type;

export const LocalDockerSandboxStatus = Schema.Literals([
  "created",
  "running",
  "paused",
  "restarting",
  "removing",
  "exited",
  "dead",
]);
export type LocalDockerSandboxStatus = typeof LocalDockerSandboxStatus.Type;

/** The limits the manager applies, read back from the running container rather
    than restated from the launch arguments, so the UI shows what is in force. */
export const LocalDockerSandboxResources = Schema.Struct({
  memoryBytes: Schema.optionalKey(Schema.Number),
  cpus: Schema.optionalKey(Schema.Number),
  pidsLimit: Schema.optionalKey(Schema.Number),
});
export type LocalDockerSandboxResources = typeof LocalDockerSandboxResources.Type;

export const LocalDockerSandbox = Schema.Struct({
  sandboxId: LocalDockerSandboxId,
  environmentId: Schema.optionalKey(EnvironmentId),
  image: TrimmedNonEmptyString,
  /** Digest of the image actually running. A tag can be rebuilt underneath a
      sandbox, so this is what identifies the build for a reproducible run. */
  imageId: Schema.optionalKey(TrimmedNonEmptyString),
  status: LocalDockerSandboxStatus,
  createdAt: IsoDateTime,
  startedAt: Schema.optionalKey(IsoDateTime),
  hostPort: Schema.optionalKey(PortSchema),
  resources: Schema.optionalKey(LocalDockerSandboxResources),
});
export type LocalDockerSandbox = typeof LocalDockerSandbox.Type;

export const LocalDockerSandboxListResult = Schema.Struct({
  image: TrimmedNonEmptyString,
  sandboxes: Schema.Array(LocalDockerSandbox),
});
export type LocalDockerSandboxListResult = typeof LocalDockerSandboxListResult.Type;

export const LocalDockerSandboxCreateResult = Schema.Struct({
  sandbox: LocalDockerSandbox,
  pairingUrl: TrimmedNonEmptyString,
});
export type LocalDockerSandboxCreateResult = typeof LocalDockerSandboxCreateResult.Type;

/**
 * A local sandbox re-pairs itself on every start: the container writes a fresh
 * one-time token to its startup log, which the managing server reads and the
 * client connects without the operator handling a URL. The token is absent only
 * when the log no longer carries one.
 */
export const LocalDockerSandboxStartResult = Schema.Struct({
  sandbox: LocalDockerSandbox,
  pairingUrl: Schema.optionalKey(TrimmedNonEmptyString),
});
export type LocalDockerSandboxStartResult = typeof LocalDockerSandboxStartResult.Type;

export const LocalDockerSandboxPairResult = Schema.Struct({
  pairingUrl: TrimmedNonEmptyString,
});
export type LocalDockerSandboxPairResult = typeof LocalDockerSandboxPairResult.Type;

export const LocalDockerSandboxTargetInput = Schema.Struct({
  sandboxId: LocalDockerSandboxId,
});
export type LocalDockerSandboxTargetInput = typeof LocalDockerSandboxTargetInput.Type;

/**
 * Seeds a sandbox workspace from a project that lives on the managing server.
 * The client names the sandbox and the source project; the server resolves the
 * checkout path itself, so no host path ever crosses the wire.
 */
export const LocalDockerSandboxPrepareWorkspaceInput = Schema.Struct({
  sandboxId: LocalDockerSandboxId,
  projectId: ProjectId,
});
export type LocalDockerSandboxPrepareWorkspaceInput =
  typeof LocalDockerSandboxPrepareWorkspaceInput.Type;

/**
 * Where the seeded checkout landed inside the container, plus the sandbox's own
 * environment id so the client can register the directory as a project there.
 */
export const LocalDockerSandboxPrepareWorkspaceResult = Schema.Struct({
  environmentId: EnvironmentId,
  workspacePath: TrimmedNonEmptyString,
  /** False when the sandbox already held this checkout and nothing was copied. */
  seeded: Schema.Boolean,
});
export type LocalDockerSandboxPrepareWorkspaceResult =
  typeof LocalDockerSandboxPrepareWorkspaceResult.Type;

export const LocalDockerSandboxErrorReason = Schema.Literals([
  "not-configured",
  "docker-unavailable",
  "image-unavailable",
  "image-runs-as-root",
  "not-found",
  "conflict",
  "command-failed",
  "invalid-response",
  "startup-failed",
  "not-running",
  "project-not-found",
  "project-not-a-repository",
  "workspace-seed-failed",
  "pair-unsupported",
]);
export type LocalDockerSandboxErrorReason = typeof LocalDockerSandboxErrorReason.Type;

export const LocalDockerSandboxOperation = Schema.Literals([
  "list",
  "create",
  "start",
  "stop",
  "delete",
  "pair",
  "prepare-workspace",
]);
export type LocalDockerSandboxOperation = typeof LocalDockerSandboxOperation.Type;

export class LocalDockerSandboxError extends Schema.TaggedErrorClass<LocalDockerSandboxError>()(
  "LocalDockerSandboxError",
  {
    operation: LocalDockerSandboxOperation,
    reason: LocalDockerSandboxErrorReason,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "not-configured":
        return "Local Docker sandboxes are not configured on this environment.";
      case "docker-unavailable":
        return "The Docker daemon is unavailable.";
      case "image-unavailable":
        return "The configured sandbox image is unavailable.";
      case "image-runs-as-root":
        return "The configured sandbox image must declare a non-root user.";
      case "not-found":
        return "The managed Docker sandbox was not found.";
      case "conflict":
        return "More than one managed Docker sandbox matched this request.";
      case "startup-failed":
        return "The Docker sandbox did not become ready.";
      case "invalid-response":
        return "Docker returned an invalid sandbox response.";
      case "not-running":
        return "The Docker sandbox must be running for this operation.";
      case "project-not-found":
        return "The source project no longer exists on this environment.";
      case "project-not-a-repository":
        return "Only a Git project can be copied into a Docker sandbox.";
      case "workspace-seed-failed":
        return "Copying the project checkout into the Docker sandbox failed.";
      case "pair-unsupported":
        return "This sandbox image cannot issue a new pairing link. Stop and start the sandbox to pair it again, or update the image to one whose `t3` supports `t3 pair`.";
      case "command-failed":
        return `The Docker sandbox ${this.operation} command failed.`;
    }
  }
}
