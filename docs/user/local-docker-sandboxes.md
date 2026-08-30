# Local Docker Sandboxes

Local Docker sandboxes run a separate T3 Code environment in a container on the same machine. Each sandbox has its own workspace, T3 data, provider state, and environment identity. It appears in T3 Code through the normal environment pairing flow.

This feature is opt-in. Build the reference image and point the T3 Code server or desktop backend at it:

```bash
docker build -t t3-sandbox:local docker/sandbox
T3CODE_DOCKER_SANDBOX_IMAGE=t3-sandbox:local npx t3
```

`docker/sandbox/Dockerfile` is a worked example carrying Codex, Claude Code, and OpenCode. Any image meeting the contract below works just as well, and an immutable digest is worth using where reproducibility matters:

```bash
T3CODE_DOCKER_SANDBOX_IMAGE=example/t3-sandbox@sha256:... npx t3
```

After restart, open **Settings** → **Connections** → **Local sandboxes** and choose **New sandbox**.

Pairing is automatic. A sandbox runs on your own machine under a server you already trust, so T3 Code never asks you to carry a pairing URL across: every container boot writes a one-time token that the managing server reads and connects on your behalf. **New sandbox** pairs on creation, and **Start** re-pairs, so stopping and starting a sandbox is a complete recovery path if its connection is ever lost.

Local sandboxes are available only from a web or desktop client running on the Docker host. They are not exposed to remote or mobile clients, and they are managed only from this section — a sandbox is not listed again under **Remote environments**.

## Running a thread in a sandbox

The composer's workspace picker gains a **Sandbox (Docker)** entry alongside **Current checkout** and **New worktree** whenever this client is on the machine running Docker.

Choosing it only marks the draft; nothing happens until you send, so changing your mind first costs nothing. Sending is then one action. Whatever the sandbox needs happens for you: creating a sandbox if none exists, starting a stopped one, pairing it, copying the project's committed `HEAD` tree in, and registering that directory as a project in the sandbox environment. You never create a folder or pair anything by hand — a local sandbox is a container this server made on this machine, not a remote to onboard. The thread is then created by the sandbox's own server, so everything after that — providers, terminals, checkpoints, diffs — behaves exactly as it does on any other environment.

Uncommitted work is not carried across: the copy is defined by a commit, so a run is reproducible from its ref alone. Commit or stash first if you need in-progress changes. Repeat picks reuse the existing copy rather than overwriting it; delete the directory inside the sandbox to start clean.

Each sandbox in **Settings** → **Connections** shows the image it runs, the digest of the build actually running, and the memory, CPU, and process limits in force — a tag can be rebuilt underneath a sandbox, so the digest is what identifies a run.

## Image contract

The configured image must:

- provide a `t3` executable on `PATH`
- declare a non-root `USER`
- allow that user to write to `/workspace`, `/t3-data`, and `/t3-home`
- provide `git`, `tar`, and `timeout` on `PATH`
- include the provider CLIs needed by the threads that will run in it — a sandbox can only run a provider whose CLI is in the image, whatever credentials it has

An older `t3` without a `pair` subcommand parses `pair` as a working directory and starts a second server instead of issuing a link. T3 Code bounds that call so nothing is left running, and falls back to the token from the container's last boot.

Use an immutable image digest when reproducibility matters. T3 Code pulls the configured image only when it is not already available to Docker.

## Credentials and secrets

T3 Code does not mount host credential directories, environment files, the Docker socket, or other host paths into a sandbox.

## Provider credentials

Give a sandbox its own keys. They are passed to the container as environment variables, which is how both CLIs accept a key:

```bash
T3CODE_DOCKER_SANDBOX_ANTHROPIC_API_KEY=sk-ant-...
T3CODE_DOCKER_SANDBOX_CODEX_API_KEY=sk-...
```

Nothing of your own sign-in reaches the sandbox: no session history, no project list, no refresh token. You can revoke a sandbox's key without touching your own login, and deleting the sandbox removes it with its volumes.

Without keys, authenticate from a terminal inside the sandbox. Browser sign-in cannot complete from inside a container, so that also means an API key in practice.

### Copying your own sign-in

If you have no API key — a subscription-only login, say — you can opt in to copying this machine's provider credential files into every sandbox as it starts:

```bash
T3CODE_DOCKER_SANDBOX_SEED_CREDENTIALS=true
```

Only credential files are copied, never files like `~/.claude.json` that carry project history, and the sandbox keeps its own provider state with its own history and settings. Codex, Claude Code, and OpenCode are covered. On macOS, Claude Code keeps its credentials in the login keychain rather than on disk, so T3 Code reads them from there and writes the file the Linux build expects.

Understand the trade before using it. A copied sign-in leaves your machine and the sandbox holding the same refresh token, so a rotation by either can sign the other out, and anything running in that sandbox is running as you. A dedicated key is the better answer wherever you can get one.

## Isolation limits

The container is read-only except for private named volumes and a temporary filesystem. T3 Code drops Linux capabilities, enables `no-new-privileges`, binds the T3 port to host loopback, and applies fixed CPU, memory, process, and log limits.

The sandbox still uses Docker's default bridge network and can make outbound network requests. Docker containers also share the host kernel; this is useful isolation for trusted local development and benchmarks, not a hardened multi-tenant boundary.
