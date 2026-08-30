import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef } from "react";

import type { DraftId } from "../composerDraftStore";
import { connectPairing as connectPairingAtom } from "../connection/onboarding";
import { isLoopbackHostname } from "../environments/primary/target";
import { inferProjectTitleFromPath } from "../lib/projectPaths";
import { newProjectId } from "../lib/utils";
import { useProjects, useServerConfigs } from "../state/entities";
import { localDockerSandboxes } from "../state/localDockerSandboxes";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";

interface SandboxDraftTargetInput {
  readonly draftId: DraftId | undefined;
  readonly primaryEnvironmentId: EnvironmentId | null;
  /** The project the composer is currently pointed at. */
  readonly activeProject: { readonly id: ProjectId; readonly environmentId: EnvironmentId } | null;
  readonly envLocked: boolean;
  readonly setProjectRef: (draftId: DraftId, projectRef: ScopedProjectRef) => void;
  readonly onFailure: (message: string) => void;
}

export interface SandboxDraftTarget {
  /** Cheap: records that the draft is bound for a sandbox. */
  readonly select: () => void;
  /** The work, run when the user commits by sending. Resolves to the sandbox
      project the draft now points at, or null when it could not be reached. */
  readonly prepare: () => Promise<ScopedProjectRef | null>;
}

/**
 * Offers the composer a "Sandbox (Docker)" workspace entry, and makes choosing
 * it a single action: whatever the sandbox needs — creating it, starting it,
 * pairing it, copying the project in, registering it — happens here.
 *
 * A local sandbox is a container this server owns on this machine, so none of
 * that is a decision to put to the user separately. Reaching one should not
 * feel like onboarding a remote machine.
 */
export function useSandboxDraftTarget(
  input: SandboxDraftTargetInput & { readonly onSelect: () => void },
): SandboxDraftTarget | undefined {
  const { draftId, primaryEnvironmentId, activeProject, envLocked, setProjectRef, onFailure } =
    input;

  const serverConfigs = useServerConfigs();
  const allProjects = useProjects();
  // Read inside the async flow, where the value captured at click time is
  // already stale: pairing a sandbox is what makes its projects visible.
  const projectsRef = useRef(allProjects);
  useEffect(() => {
    projectsRef.current = allProjects;
  }, [allProjects]);
  const createSandbox = useAtomCommand(localDockerSandboxes.create, { reportFailure: false });
  const startSandbox = useAtomCommand(localDockerSandboxes.start, { reportFailure: false });
  const pairSandbox = useAtomCommand(localDockerSandboxes.pair, { reportFailure: false });
  const prepareWorkspace = useAtomCommand(localDockerSandboxes.prepareWorkspace, {
    reportFailure: false,
  });
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });

  // Docker runs on the machine hosting the managing server, so the entry only
  // makes sense for a project on that machine, reached from that machine.
  const eligible =
    primaryEnvironmentId !== null &&
    activeProject !== null &&
    activeProject.environmentId === primaryEnvironmentId &&
    !envLocked &&
    serverConfigs.get(primaryEnvironmentId)?.environment.capabilities.localDockerSandboxes ===
      true &&
    (window.desktopBridge !== undefined || isLoopbackHostname(window.location.hostname));

  const sandboxes = useEnvironmentQuery(
    eligible && primaryEnvironmentId !== null
      ? localDockerSandboxes.list({ environmentId: primaryEnvironmentId, input: {} })
      : null,
  );
  const knownSandboxes = useMemo(() => sandboxes.data?.sandboxes ?? [], [sandboxes.data]);
  const refreshSandboxesRef = useRef(sandboxes.refresh);
  refreshSandboxesRef.current = sandboxes.refresh;

  const prepare = useCallback(async (): Promise<ScopedProjectRef | null> => {
    if (draftId === undefined || activeProject === null || primaryEnvironmentId === null) {
      return null;
    }
    const environmentId = primaryEnvironmentId;

    {
      // Pairing is what lets us register a project inside the sandbox, so every
      // path below ends either connected or reported.
      const connect = async (pairingUrl: string) => {
        const connected = await connectPairing({ pairingUrl });
        return connected._tag !== "Failure";
      };

      const connected = knownSandboxes.find(
        (sandbox) =>
          sandbox.status === "running" &&
          sandbox.environmentId !== undefined &&
          serverConfigs.has(sandbox.environmentId),
      );
      const stopped = knownSandboxes.find(
        (sandbox) => sandbox.status === "created" || sandbox.status === "exited",
      );
      const unpaired = knownSandboxes.find((sandbox) => sandbox.status === "running");

      let target = connected ?? null;
      if (target === null && stopped !== undefined) {
        // A start mints a fresh token, so this wakes and re-pairs in one step.
        const started = await startSandbox({
          environmentId,
          input: { sandboxId: stopped.sandboxId },
        });
        if (started._tag === "Failure" || !("sandbox" in started.value)) {
          onFailure("The Docker sandbox could not be started.");
          return null;
        }
        if (started.value.pairingUrl !== undefined && !(await connect(started.value.pairingUrl))) {
          onFailure("The Docker sandbox started but could not be paired.");
          return null;
        }
        target = started.value.sandbox;
      } else if (target === null && unpaired !== undefined) {
        const paired = await pairSandbox({
          environmentId,
          input: { sandboxId: unpaired.sandboxId },
        });
        if (paired._tag === "Failure" || !(await connect(paired.value.pairingUrl))) {
          onFailure("The running Docker sandbox could not be paired.");
          return null;
        }
        target = unpaired;
      } else if (target === null) {
        const created = await createSandbox({ environmentId, input: {} });
        if (created._tag !== "Failure") {
          // The container exists from here on, even if pairing fails below. A
          // list that misses it creates a second one on the next send.
          refreshSandboxesRef.current();
        }
        if (created._tag === "Failure" || !(await connect(created.value.pairingUrl))) {
          onFailure("A Docker sandbox could not be created.");
          return null;
        }
        target = created.value.sandbox;
      }

      const prepared = await prepareWorkspace({
        environmentId,
        input: { sandboxId: target.sandboxId, projectId: activeProject.id },
      });
      if (prepared._tag === "Failure") {
        onFailure("The project could not be copied into the Docker sandbox.");
        return null;
      }
      const { environmentId: sandboxEnvironmentId, workspacePath } = prepared.value;

      const findRegistered = () =>
        projectsRef.current.find(
          (project) =>
            project.environmentId === sandboxEnvironmentId &&
            project.workspaceRoot === workspacePath,
        );

      const adopt = (projectId: ProjectId) => {
        const ref = scopeProjectRef(sandboxEnvironmentId, projectId);
        setProjectRef(draftId, ref);
        return ref;
      };

      const alreadyRegistered = findRegistered();
      if (alreadyRegistered !== undefined) return adopt(alreadyRegistered.id);

      const projectId = newProjectId();
      const registered = await createProject({
        environmentId: sandboxEnvironmentId,
        input: {
          projectId,
          title: inferProjectTitleFromPath(workspacePath),
          workspaceRoot: workspacePath,
          createWorkspaceRootIfMissing: false,
          defaultModelSelection: null,
        },
      });
      if (registered._tag !== "Failure") return adopt(projectId);

      // A create can lose to a project that already covers this path — the
      // client only learns about a freshly paired sandbox's projects once it
      // has synced. Adopt that project rather than reporting a failure the
      // user cannot act on.
      const raced = findRegistered();
      if (raced !== undefined) return adopt(raced.id);
      onFailure("The sandbox workspace could not be registered as a project.");
      return null;
    }
  }, [
    activeProject,
    connectPairing,
    createProject,
    createSandbox,
    draftId,
    knownSandboxes,
    onFailure,
    pairSandbox,
    prepareWorkspace,
    primaryEnvironmentId,
    serverConfigs,
    setProjectRef,
    startSandbox,
  ]);

  const select = input.onSelect;
  return useMemo(() => (eligible ? { select, prepare } : undefined), [eligible, prepare, select]);
}
