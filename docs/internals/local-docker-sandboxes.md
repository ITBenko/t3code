# Local Docker Sandboxes

Local Docker sandboxing is a deliberately small extension of the existing multi-environment model. The host server manages a container that runs a complete headless T3 server. The client pairs that server through the standard environment onboarding flow, so projects, threads, terminals, providers, checkpoints, and reconnection remain environment-local without a second orchestration path.

## Scope

The first slice manages local Docker environments and seeds workspaces into them. It does not mount a host checkout, proxy sandbox traffic for remote clients, or define a Kubernetes backend.

`ThreadEnvMode` deliberately stays `local | worktree`. A sandbox is a separate server with its own event store, so "run this thread in the sandbox" cannot be a mode of a thread on the managing server — it is a different environment. The composer therefore exposes **Sandbox (Docker)** as an _action_ in the workspace picker, next to the modes, in the same shape as the existing "previous worktree" entry: selecting it repoints the draft at a project in the sandbox environment. Nothing new is persisted, and the wire contract is unchanged, so older servers and clients stay compatible.

The server advertises `capabilities.localDockerSandboxes` only when `T3CODE_DOCKER_SANDBOX_IMAGE` is configured. Web clients show the controls only on loopback; desktop clients show them for their local backend. The lifecycle RPCs use `access:write`, while listing uses `access:read`.

## Trust boundary

The image is server configuration, never RPC input. RPC payloads contain only a generated sandbox UUID. Clients cannot supply Docker arguments, commands, mounts, environment variables, ports, or image names.

Before execution, the manager inspects the image and rejects an empty or root `USER`. The runtime command is generated from fixed arguments:

- read-only root filesystem
- all Linux capabilities dropped
- `no-new-privileges`
- private named volumes for `/workspace`, `/t3-data`, and `/t3-home`
- loopback-only random host port for container port 3773
- bounded memory, CPU, PIDs, temporary storage, and Docker logs
- default bridge networking for outbound provider and source-control access
- fixed `t3 serve` entrypoint and arguments

No host path, provider credential directory, secret file, or Docker socket is mounted. Provider login happens inside the paired environment and persists in its private home volume.

Providers are meant to be reached with credentials of the sandbox's own: `T3CODE_DOCKER_SANDBOX_ANTHROPIC_API_KEY` and `T3CODE_DOCKER_SANDBOX_CODEX_API_KEY` are passed to the container as environment variables, carry no history by construction, and can be revoked without touching the operator's login.

`T3CODE_DOCKER_SANDBOX_SEED_CREDENTIALS` is the fallback for a subscription-only login that has no key to give. It relaxes the boundary above and is off by default. It copies a fixed allowlist of credential _files_ — never state files like `~/.claude.json`, which carry host project history — on create and on start.

Copying rather than mounting is deliberate. A read-only mount breaks token refresh; a writable one lets sandbox processes corrupt the operator's provider state and mixes session history across the boundary. A copy leaves the sandbox able to refresh its own tokens and dies with its volumes.

Copying a ChatGPT sign-in still shares one refresh token between host and sandbox, which no amount of filesystem isolation fixes: a rotation by either side can invalidate the other. `T3CODE_DOCKER_SANDBOX_CODEX_API_KEY` avoids that by generating the sandbox's `auth.json` from a key the operator can revoke independently, and takes precedence over copying that file.

The copy runs in two steps because `docker cp` preserves the source mode and gives the file to root: a credential at mode 600 would arrive unreadable to the sandbox user. The manager stages a 0644 copy in a 0700 host temp directory, copies that in, and then places it with the container's own user so it lands owned by that user at mode 600. The staged file is removed by a shell trap on every exit path.

Docker is not treated as a hostile multi-tenant boundary. The operator approves the image and controls the daemon. Stronger kernel isolation and policy-enforced egress belong in a future execution backend.

## Ownership and lifecycle

Managed containers and volumes carry three labels: a managed marker, the owner T3 environment ID, and the generated sandbox ID. Every lookup filters by all applicable labels. Mutations resolve the exact container ID before invoking Docker; no name-pattern killing or broad cleanup is used.

The container begins with a pending name. Once its loopback port answers with an environment descriptor, the manager renames it with the sandbox environment ID. This keeps Docker discovery stateless while allowing the client to associate a managed sandbox with its saved environment.

Stop/start preserves all named volumes. Delete removes the exact container and its three exact volumes after user confirmation.

## Presentation

A paired sandbox is a saved environment like any other, but it belongs to the machine running Docker and its whole lifecycle lives in **Local sandboxes**. Settings therefore filters sandbox environment ids out of **Remote environments**: showing the same environment twice offers connect and remove actions that do not apply to a container the server owns, and reads as a second, unrelated backend.

Listing a sandbox reports the resolved image digest, start time, and the memory, CPU, and PID limits read back from the container rather than restated from the launch arguments, so the settings page shows what is actually in force. Those fields decode as optional: a Docker version that reshapes them degrades the display instead of breaking the list.

The container is given a `t3-sandbox-<short id>` hostname for the same reason. A server labels itself from its hostname, which Docker defaults to the container id, so without this the environment surfaces everywhere — settings, the composer picker — as an opaque hex string.

## Pairing

A local sandbox is a container the managing server itself created, on the operator's own machine, from an operator-approved image. Making the operator ferry a pairing URL into it would add a manual step without adding a trust decision they have not already made, so pairing is automatic.

Every `t3 serve` boot writes a one-time token to the container log. `create` and `start` both read the bounded tail of that log, rebuild the pairing URL against the loopback host port, and return it; the client connects it without showing the operator a URL. Because a restarted container keeps earlier boots in the same log, the _last_ `Token:` line is the live one.

This makes stop/start a complete recovery path: a sandbox whose session is lost re-pairs by cycling it, with no image support beyond a startup banner.

The explicit pair action issues a fresh link with `t3 pair` inside the running container, falling back to the last boot token when the image's `t3` predates that subcommand. That call is bounded by `timeout` inside the container and by a deadline outside it: an older `t3` reads `pair` as a working directory and starts a second server against the same event store, which must neither hang the RPC nor outlive it. When neither path can produce a token the failure stays `pair-unsupported`, which names the recovery step rather than blaming startup.

## Seeding a workspace

`localDockerSandboxes.prepareWorkspace` takes a sandbox id and a project id. The handler resolves the project's checkout path from the projection, so no host path is ever accepted from a client. The manager then:

1. resolves the container by owner and sandbox labels, and requires it to be running
2. probes `test -d <target>/.git` and returns early when the copy already exists
3. writes a tar of the host checkout's `HEAD` tree with `git archive`, in a scoped temp directory
4. `docker cp`s that archive into the workspace volume, then extracts it and runs `git init` / `git add` / `git commit` inside the container

The target directory is the basename of the host checkout, validated against a conservative character set, and is passed to `sh -c` as a positional argument rather than spliced into the script.

The archive is staged inside the `/workspace` volume rather than the container's tmpfs: `docker cp` rejects every destination in a container whose rootfs is marked read-only, including mounted ones. Seeding from `git archive` rather than a bind mount or a clone keeps the container free of host paths and of Git credentials, and makes the copy reproducible from a single commit.
