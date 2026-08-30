import { ContainerIcon, LinkIcon, PlayIcon, PlusIcon, SquareIcon, Trash2Icon } from "lucide-react";
import {
  type EnvironmentId,
  type LocalDockerSandbox,
  type LocalDockerSandboxId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { connectPairing as connectPairingAtom } from "~/connection/onboarding";
import { localDockerSandboxes } from "~/state/localDockerSandboxes";
import { cn } from "~/lib/utils";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The local Docker sandbox request failed.";
}

function shortSandboxId(sandboxId: LocalDockerSandboxId): string {
  return sandboxId.slice(0, 8);
}

/** `sha256:abcdef012345…` — enough to tell two builds of one tag apart. */
function shortImageId(imageId: string): string {
  const digest = imageId.startsWith("sha256:") ? imageId.slice("sha256:".length) : imageId;
  return digest.slice(0, 12);
}

function formatMemory(bytes: number): string {
  const gigabytes = bytes / 1024 ** 3;
  return gigabytes >= 1
    ? `${Number(gigabytes.toFixed(gigabytes < 10 ? 1 : 0))} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function formatUptime(startedAt: string): string | null {
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) return null;
  const minutes = Math.floor((Date.now() - startedMs) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Image build and enforced limits, so a run can be reproduced and its
    isolation understood without reaching for `docker inspect`. */
function SandboxDetail({ sandbox }: { readonly sandbox: LocalDockerSandbox }) {
  const limits = [
    sandbox.resources?.memoryBytes === undefined
      ? null
      : formatMemory(sandbox.resources.memoryBytes),
    sandbox.resources?.cpus === undefined
      ? null
      : `${Number(sandbox.resources.cpus.toFixed(2))} CPU`,
    sandbox.resources?.pidsLimit === undefined ? null : `${sandbox.resources.pidsLimit} PIDs`,
  ].filter((value): value is string => value !== null);
  return (
    <span className="flex flex-col gap-0.5">
      <span className="truncate">{sandbox.image}</span>
      {sandbox.imageId ? (
        <span className="font-mono text-[11px] text-muted-foreground/70">
          {shortImageId(sandbox.imageId)}
        </span>
      ) : null}
      {limits.length > 0 ? <span>{limits.join(" · ")}</span> : null}
    </span>
  );
}

function statusLabel(status: LocalDockerSandbox["status"]): string {
  switch (status) {
    case "created":
      return "Created";
    case "running":
      return "Running";
    case "paused":
      return "Paused";
    case "restarting":
      return "Restarting";
    case "removing":
      return "Removing";
    case "exited":
      return "Stopped";
    case "dead":
      return "Failed";
  }
}

function uptimeSuffix(startedAt: string): string {
  const uptime = formatUptime(startedAt);
  return uptime === null ? "" : ` · up ${uptime}`;
}

function SandboxStatus({ sandbox }: { readonly sandbox: LocalDockerSandbox }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          sandbox.status === "running"
            ? "bg-emerald-500"
            : sandbox.status === "dead"
              ? "bg-destructive"
              : "bg-muted-foreground/50",
        )}
      />
      {statusLabel(sandbox.status)}
      {sandbox.hostPort ? ` · 127.0.0.1:${sandbox.hostPort}` : ""}
      {sandbox.status === "running" && sandbox.startedAt ? uptimeSuffix(sandbox.startedAt) : ""}
    </span>
  );
}

export function LocalDockerSandboxesSettings({
  primaryEnvironmentId,
  savedEnvironmentIds,
}: {
  readonly primaryEnvironmentId: EnvironmentId;
  readonly savedEnvironmentIds: ReadonlySet<EnvironmentId>;
}) {
  const sandboxes = useEnvironmentQuery(
    localDockerSandboxes.list({ environmentId: primaryEnvironmentId, input: {} }),
  );
  const createSandbox = useAtomCommand(localDockerSandboxes.create, { reportFailure: false });
  const startSandbox = useAtomCommand(localDockerSandboxes.start, { reportFailure: false });
  const stopSandbox = useAtomCommand(localDockerSandboxes.stop, { reportFailure: false });
  const deleteSandbox = useAtomCommand(localDockerSandboxes.delete, { reportFailure: false });
  const pairSandbox = useAtomCommand(localDockerSandboxes.pair, { reportFailure: false });
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const [busySandboxId, setBusySandboxId] = useState<LocalDockerSandboxId | "create" | null>(null);
  const [pendingDelete, setPendingDelete] = useState<LocalDockerSandbox | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const reportFailure = useCallback((title: string, failure: unknown) => {
    const message = errorMessage(failure);
    setMutationError(message);
    toastManager.add(stackedThreadToast({ type: "error", title, description: message }));
  }, []);

  const connectPairingUrl = useCallback(
    async (pairingUrl: string) => {
      const connected = await connectPairing({ pairingUrl });
      if (connected._tag === "Failure") {
        if (!isAtomCommandInterrupted(connected)) {
          reportFailure("Could not pair sandbox", squashAtomCommandFailure(connected));
        }
        return false;
      }
      return true;
    },
    [connectPairing, reportFailure],
  );

  const handleCreate = useCallback(async () => {
    setBusySandboxId("create");
    setMutationError(null);
    const created = await createSandbox({ environmentId: primaryEnvironmentId, input: {} });
    if (created._tag === "Failure") {
      if (!isAtomCommandInterrupted(created)) {
        reportFailure("Could not create sandbox", squashAtomCommandFailure(created));
      }
      setBusySandboxId(null);
      return;
    }

    const connected = await connectPairingUrl(created.value.pairingUrl);
    if (!connected) {
      await deleteSandbox({
        environmentId: primaryEnvironmentId,
        input: { sandboxId: created.value.sandbox.sandboxId },
      });
    } else {
      toastManager.add({
        type: "success",
        title: "Sandbox ready",
        description: "The Docker environment is paired and ready for a project.",
      });
    }
    sandboxes.refresh();
    setBusySandboxId(null);
  }, [
    connectPairingUrl,
    createSandbox,
    deleteSandbox,
    primaryEnvironmentId,
    reportFailure,
    sandboxes,
  ]);

  const handlePair = useCallback(
    async (sandbox: LocalDockerSandbox) => {
      setBusySandboxId(sandbox.sandboxId);
      setMutationError(null);
      const paired = await pairSandbox({
        environmentId: primaryEnvironmentId,
        input: { sandboxId: sandbox.sandboxId },
      });
      if (paired._tag === "Failure") {
        if (!isAtomCommandInterrupted(paired)) {
          reportFailure("Could not pair sandbox", squashAtomCommandFailure(paired));
        }
      } else if (await connectPairingUrl(paired.value.pairingUrl)) {
        toastManager.add({
          type: "success",
          title: "Sandbox paired",
          description: "The Docker environment is saved and will reconnect automatically.",
        });
      }
      setBusySandboxId(null);
    },
    [connectPairingUrl, pairSandbox, primaryEnvironmentId, reportFailure],
  );

  const handleLifecycle = useCallback(
    async (sandbox: LocalDockerSandbox, action: "start" | "stop") => {
      setBusySandboxId(sandbox.sandboxId);
      setMutationError(null);
      const command = action === "start" ? startSandbox : stopSandbox;
      const result = await command({
        environmentId: primaryEnvironmentId,
        input: { sandboxId: sandbox.sandboxId },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure(
          action === "start" ? "Could not start sandbox" : "Could not stop sandbox",
          squashAtomCommandFailure(result),
        );
      } else if (result._tag !== "Failure" && "sandbox" in result.value) {
        // A start always mints a fresh one-time token, so the environment
        // re-pairs itself here rather than asking the operator for anything.
        const { pairingUrl } = result.value;
        if (pairingUrl !== undefined) await connectPairingUrl(pairingUrl);
      }
      sandboxes.refresh();
      setBusySandboxId(null);
    },
    [connectPairingUrl, primaryEnvironmentId, reportFailure, sandboxes, startSandbox, stopSandbox],
  );

  const handleDelete = useCallback(async () => {
    if (pendingDelete === null) return;
    const sandbox = pendingDelete;
    setBusySandboxId(sandbox.sandboxId);
    setMutationError(null);
    const result = await deleteSandbox({
      environmentId: primaryEnvironmentId,
      input: { sandboxId: sandbox.sandboxId },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure("Could not delete sandbox", squashAtomCommandFailure(result));
      }
      setBusySandboxId(null);
      return;
    }
    if (sandbox.environmentId && savedEnvironmentIds.has(sandbox.environmentId)) {
      await removeEnvironment(sandbox.environmentId);
    }
    setPendingDelete(null);
    sandboxes.refresh();
    setBusySandboxId(null);
  }, [
    deleteSandbox,
    pendingDelete,
    primaryEnvironmentId,
    removeEnvironment,
    reportFailure,
    sandboxes,
    savedEnvironmentIds,
  ]);

  const sandboxRows = sandboxes.data?.sandboxes ?? [];
  const queryError = mutationError ?? sandboxes.error;

  return (
    <>
      <SettingsSection
        {...searchableSetting("local-docker-sandboxes")}
        title="Local sandboxes"
        headerAction={
          <Button
            size="xs"
            variant="ghost"
            className="h-5 gap-1 rounded-sm px-1 text-[11px] font-normal text-muted-foreground/60 hover:text-muted-foreground"
            disabled={busySandboxId !== null}
            onClick={() => void handleCreate()}
          >
            {busySandboxId === "create" ? (
              <Spinner className="size-3" />
            ) : (
              <PlusIcon className="size-3" />
            )}
            <span>{busySandboxId === "create" ? "Creating…" : "New sandbox"}</span>
          </Button>
        }
      >
        <SettingsRow
          title="Docker isolation"
          description={
            sandboxes.data
              ? `Runs ${sandboxes.data.image} with private workspace, T3 data, and home volumes. No host path or Docker socket is mounted.`
              : "Runs an operator-approved image with private workspace, T3 data, and home volumes. No host path or Docker socket is mounted."
          }
          status={queryError ? <span className="text-destructive">{queryError}</span> : undefined}
        />
        {sandboxRows.map((sandbox) => {
          const isBusy = busySandboxId === sandbox.sandboxId;
          const isSaved =
            sandbox.environmentId !== undefined && savedEnvironmentIds.has(sandbox.environmentId);
          const canStart = sandbox.status === "created" || sandbox.status === "exited";
          const canStop = sandbox.status === "running" || sandbox.status === "paused";
          return (
            <SettingsRow
              key={sandbox.sandboxId}
              title={
                <span className="inline-flex items-center gap-2">
                  <ContainerIcon aria-hidden className="size-3.5 text-muted-foreground" />
                  Sandbox {shortSandboxId(sandbox.sandboxId)}
                </span>
              }
              description={<SandboxDetail sandbox={sandbox} />}
              status={<SandboxStatus sandbox={sandbox} />}
              control={
                <div className="flex items-center gap-1">
                  {!isSaved && sandbox.status === "running" ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={isBusy}
                      onClick={() => void handlePair(sandbox)}
                    >
                      <LinkIcon className="size-3" />
                      Pair
                    </Button>
                  ) : null}
                  {canStart ? (
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Start sandbox ${shortSandboxId(sandbox.sandboxId)}`}
                      disabled={isBusy}
                      onClick={() => void handleLifecycle(sandbox, "start")}
                    >
                      {isBusy ? (
                        <Spinner className="size-3.5" />
                      ) : (
                        <PlayIcon className="size-3.5" />
                      )}
                    </Button>
                  ) : null}
                  {canStop ? (
                    <Button
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Stop sandbox ${shortSandboxId(sandbox.sandboxId)}`}
                      disabled={isBusy}
                      onClick={() => void handleLifecycle(sandbox, "stop")}
                    >
                      {isBusy ? (
                        <Spinner className="size-3.5" />
                      ) : (
                        <SquareIcon className="size-3.5" />
                      )}
                    </Button>
                  ) : null}
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    className="hover:text-destructive"
                    aria-label={`Delete sandbox ${shortSandboxId(sandbox.sandboxId)}`}
                    disabled={isBusy}
                    onClick={() => setPendingDelete(sandbox)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              }
            />
          );
        })}
        {sandboxes.isPending && sandboxes.data === null ? (
          <SettingsRow title="Loading sandboxes…" control={<Spinner className="size-4" />} />
        ) : null}
      </SettingsSection>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && busySandboxId === null) setPendingDelete(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this sandbox?</AlertDialogTitle>
            <AlertDialogDescription>
              The container and its workspace, T3 data, and provider home volumes will be
              permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={busySandboxId !== null}
              render={<Button variant="outline" disabled={busySandboxId !== null} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busySandboxId !== null}
              onClick={() => void handleDelete()}
            >
              {busySandboxId !== null ? <Spinner className="size-3.5" /> : null}
              Delete sandbox
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
