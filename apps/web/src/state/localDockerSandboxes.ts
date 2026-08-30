import { WS_METHODS } from "@t3tools/contracts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "~/connection/runtime";

const mutationScheduler = createAtomCommandScheduler();
const mutationConcurrency = {
  mode: "serial" as const,
  key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
};

export const localDockerSandboxes = {
  list: createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
    label: "web:local-docker-sandboxes:list",
    tag: WS_METHODS.localDockerSandboxesList,
    staleTimeMs: 2_000,
  }),
  create: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "web:local-docker-sandboxes:create",
    tag: WS_METHODS.localDockerSandboxesCreate,
    scheduler: mutationScheduler,
    concurrency: mutationConcurrency,
  }),
  start: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "web:local-docker-sandboxes:start",
    tag: WS_METHODS.localDockerSandboxesStart,
    scheduler: mutationScheduler,
    concurrency: mutationConcurrency,
  }),
  stop: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "web:local-docker-sandboxes:stop",
    tag: WS_METHODS.localDockerSandboxesStop,
    scheduler: mutationScheduler,
    concurrency: mutationConcurrency,
  }),
  delete: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "web:local-docker-sandboxes:delete",
    tag: WS_METHODS.localDockerSandboxesDelete,
    scheduler: mutationScheduler,
    concurrency: mutationConcurrency,
  }),
  pair: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "web:local-docker-sandboxes:pair",
    tag: WS_METHODS.localDockerSandboxesPair,
    scheduler: mutationScheduler,
    concurrency: mutationConcurrency,
  }),
  prepareWorkspace: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "web:local-docker-sandboxes:prepare-workspace",
    tag: WS_METHODS.localDockerSandboxesPrepareWorkspace,
    scheduler: mutationScheduler,
    concurrency: mutationConcurrency,
  }),
};
