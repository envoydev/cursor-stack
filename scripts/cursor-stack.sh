#!/usr/bin/env bash
#
# cursor-stack.sh [install|update] [space] [github-cli] - install/update the CURSOR stack
# FOR A PROJECT: every skill / MCP from cursor-stack.html (the complete toolset, not a curated
# subset), installed INTO a project. Built-in/system CLI skills are excluded (they ship with the
# CLI). Bash twin of cursor-stack.ps1.
#
# Usage - run this file directly inside the target project (install == update for Cursor):
#   bash cursor-stack.sh install   # provision Cursor
#   bash cursor-stack.sh update    # refresh skills + the .cursor tree
#
# SELF-CONTAINED .cursor/: skills copied into .cursor/skills (strict - no dependency on a shared
# .agents store); MCPs into .cursor/mcp.json; hooks into .cursor/hooks.json (+ .cursor/hooks/).
# Marketplace plugins are UI-only (install them from the Cursor UI); their skill / MCP / hook
# components are provisioned here.
#
# Optional extras (args 2+, any order):
#   space       -> any word; the memory MCP's per-space DB at the 'scoped' level (memory_<space>.db) -
#                  see memory-global | memory-scoped | memory-project below. Reserved words are matched
#                  first, so a level word is never swallowed as the space.
#   memory-global | memory-scoped | memory-project -> the memory MCP's db level. global (the default
#                  when nothing is registered yet): ~/.memory-mcp/memory.db, shared across every
#                  project. scoped: ~/.memory-mcp/memory_<space>.db (memory_default.db with no space).
#                  project: <repo>/.memory-mcp/memory.db, gitignored by this run (.memory-mcp/.gitignore
#                  holding '*', written only when absent). Omitted on a run that finds an existing
#                  registration, its MCP_MEMORY_SQLITE_PATH is kept byte-for-byte and only the rest of
#                  the entry (pin, pragmas) is upgraded; omitted with none registered, global. The
#                  ~/.memory-mcp root sits outside the project so recall carries across every project
#                  (Cursor is self-contained under ~/.cursor; the space/level do not change that).
#   github-cli  -> install the GitHub CLI (gh) via Homebrew (macOS) if missing; prompts for
#                  `gh auth login` when unauthenticated. e.g.:
#                    bash cursor-stack.sh install github-cli
#                    bash cursor-stack.sh install work github-cli
#   sentry-token | sentry-oauth -> the sentry MCP's auth. sentry-token (the default on a fresh entry)
#                  sends 'Authorization: Sentry-Bearer ${env:SENTRY_ACCESS_TOKEN}' - a Sentry API token
#                  you export in the OS environment; sentry-oauth writes NO header, so Cursor runs
#                  Sentry's OAuth sign-in on first connect. Omitted, an existing entry keeps its mode.
#   playwright-chrome | playwright-msedge | playwright-firefox | playwright-webkit (repeatable) -> the
#                  browsers the playwright MCP can drive, ONE server each (playwright-chrome, ...), each
#                  with its own profile in .playwright/<engine>. chrome and msedge use the browser installed
#                  on the machine; firefox and webkit are Playwright's own builds, downloaded by the run.
#                  Omitted, the servers already in mcp.json are kept (a legacy 'playwright' entry counts as
#                  its engine); chrome when there are none. A browser left out is removed.
#   playwright-on-<engine> -> the one browser to keep switched on; the run names the others to switch off
#                  in Customize (or `agent mcp disable <name>`). Cursor has no mcp.json field for it.
#   skills-only -> run only the skill install/update step, then exit (testability - skips
#                  prerequisites/mcps/hooks/rules/agents)
#
# Scope (default PROJECT - installs the full set INTO this repo; SCOPE=global installs it into the
# active account instead):
#   SCOPE=project  -> skills project-scoped; cursor tree -> <repo>/.cursor/  (default)
#   SCOPE=global   -> skills -g;             cursor tree -> ~/.cursor/
# STACK_SOURCE_REPO   source repo every artifact is copied from (default
#                     https://github.com/envoydev/cursor-stack). STACK_SKILLS_REPO is honored as
#                     the legacy alias - it named the skills source back when only skills came
#                     from a clone and hooks/rules/agents were fetched per-file.
# Full inventory - comment out manifest entries below to trim it to a curated subset.
set -euo pipefail

# 'install' or 'update' is REQUIRED (the main action); every arg after it is optional (has a default).
ACTION="${1:-}"
case "$ACTION" in
  install|update) ;;
  *) echo "usage: bash $0 <install|update> [space] [memory-global|memory-scoped|memory-project] [github-cli] [context7-local|context7-remote] [sentry-token|sentry-oauth] [playwright-<engine>...] [playwright-on-<engine>] [skills-only]" >&2; exit 1 ;;
esac

# This script provisions the Cursor agent.
AGENT="cursor"

# Optional extras (args 2+, any order, each with a default): a space name (any word -> the memory
# MCP's memory_<space>.db at the 'scoped' level), 'memory-global' | 'memory-scoped' | 'memory-project'
# (the memory MCP's db level - see the header comment), 'github-cli' (install gh), 'context7-local' |
# 'context7-remote' (context7 transport; default remote).
SPACE=""
MEMORY_LEVEL=""  # '' = not asked this run - keeps an existing registration's path byte-for-byte, global when none exists (resolved in set_cursor_mcps)
INSTALL_GITHUB_CLI=false
CONTEXT7_MODE="remote"
SENTRY_AUTH=""        # '' = keep an existing entry's mode, token on a fresh one (resolved in set_cursor_mcps)
PLAYWRIGHT_BROWSERS="" # '' = keep the playwright-* servers already in mcp.json, chrome when none (resolved in set_cursor_mcps)
PLAYWRIGHT_ENABLED=""  # the one engine to keep on - only names the others to switch off
SKILLS_ONLY=false
for extra in "${@:2}"; do
  case "$extra" in
    github-cli) INSTALL_GITHUB_CLI=true ;;
    context7-local) CONTEXT7_MODE="local" ;;
    context7-remote) CONTEXT7_MODE="remote" ;;
    sentry-token) SENTRY_AUTH="token" ;;
    sentry-oauth) SENTRY_AUTH="oauth" ;;
    playwright-chrome|playwright-msedge|playwright-firefox|playwright-webkit) PLAYWRIGHT_BROWSERS="$PLAYWRIGHT_BROWSERS ${extra#playwright-}" ;;
    playwright-on-chrome|playwright-on-msedge|playwright-on-firefox|playwright-on-webkit) PLAYWRIGHT_ENABLED="${extra#playwright-on-}" ;;
    skills-only) SKILLS_ONLY=true ;;
    memory-global|memory-scoped|memory-project)
      # Matched BEFORE the space catch-all below, so a level word is never swallowed as the space.
      if [ -n "$MEMORY_LEVEL" ]; then
        echo "usage: bash $0 <install|update> [space] [memory-global|memory-scoped|memory-project] [github-cli] [context7-local|context7-remote] [sentry-token|sentry-oauth] [playwright-<engine>...] [playwright-on-<engine>] [skills-only]   (only one memory level word; got 'memory-$MEMORY_LEVEL' and '$extra')" >&2; exit 1
      fi
      MEMORY_LEVEL="${extra#memory-}" ;;
    *)
      # Any other single word is the SPACE (memory-DB namespace at the 'scoped' level). Reserved flags
      # are matched above; a second bare word, or a disallowed charset, is an error.
      if [ -n "$SPACE" ]; then
        echo "usage: bash $0 <install|update> [space] [memory-global|memory-scoped|memory-project] [github-cli] [context7-local|context7-remote] [sentry-token|sentry-oauth] [playwright-<engine>...] [playwright-on-<engine>] [skills-only]   (only one space name; got '$SPACE' and '$extra')" >&2; exit 1
      fi
      case "$extra" in
        [!A-Za-z0-9]*|*[!A-Za-z0-9._-]*)
          echo "usage: bash $0 <install|update> [space] [memory-global|memory-scoped|memory-project] [github-cli] [context7-local|context7-remote] [sentry-token|sentry-oauth] [playwright-<engine>...] [playwright-on-<engine>] [skills-only]   (space '$extra' must start alphanumeric; chars [A-Za-z0-9._-])" >&2; exit 1 ;;
      esac
      SPACE="$extra" ;;
  esac
done
if [ -n "$PLAYWRIGHT_ENABLED" ] && [ -n "$PLAYWRIGHT_BROWSERS" ]; then
  case " $PLAYWRIGHT_BROWSERS " in *" $PLAYWRIGHT_ENABLED "*) ;;
    *) echo "usage: playwright-on-$PLAYWRIGHT_ENABLED must be one of the kept browsers (${PLAYWRIGHT_BROWSERS# })" >&2; exit 1 ;;
  esac
fi

SCOPE="${SCOPE:-project}"
log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }

prerequisites_check() {
  # Warn (not fail) on missing prerequisites, matching the script's fail-soft philosophy.
  log "prerequisites check"
  local ok=true
  if command -v uvx >/dev/null 2>&1; then
    printf '  uvx: %s\n' "$(uvx --version 2>&1 | head -1)"
  else
    echo "  !! uvx not found - serena and memory MCPs will not work." >&2
    echo "     Install: curl -LsSf https://astral.sh/uv/install.sh | sh" >&2
    ok=false
  fi
  if command -v python3 >/dev/null 2>&1; then
    printf '  python3: %s\n' "$(command -v python3)"
  else
    echo "  !! python3 not found - the security-guidance hook and the Cursor/settings JSON merges will fail." >&2
    ok=false
  fi
  # node: required by the convention hooks and npx-based MCPs. Below 22.12 LTS some
  # MCPs (chrome-devtools) refuse to start and die at launch with a generic JSON-RPC -32000.
  if command -v node >/dev/null 2>&1; then
    node_ver="$(node -v 2>/dev/null | sed 's/^v//')"
    node_major="${node_ver%%.*}"; node_rest="${node_ver#*.}"; node_minor="${node_rest%%.*}"
    case "$node_major" in (*[!0-9]*|'') node_major=0 ;; esac
    case "$node_minor" in (*[!0-9]*|'') node_minor=0 ;; esac
    if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 12 ]; }; then
      echo "  !! node $node_ver - recommend Node >= 22.12 LTS. chrome-devtools (and some npx MCPs)" >&2
      echo "     require it; an older Node makes them die at launch with a generic JSON-RPC -32000." >&2
    else
      printf '  node: %s\n' "$node_ver"
    fi
  else
    echo "  !! node not found - the convention hooks and npx-based MCPs need it." >&2
    ok=false
  fi
  # csharp-ls: the csharp-lsp plugin shells out to it for Roslyn diagnostics. Off $PATH and the
  # plugin dies at launch with "Executable not found in $PATH". Needed only for C# work, so warn.
  if command -v csharp-ls >/dev/null 2>&1; then
    printf '  csharp-ls: %s\n' "$(command -v csharp-ls)"
  else
    echo "  !! csharp-ls not found - the csharp-lsp plugin needs it (C# work only)." >&2
    echo "     Install: dotnet tool install --global csharp-ls (needs the .NET SDK + ~/.dotnet/tools on PATH)." >&2
  fi
  $ok || echo "  Install the missing tools above, then re-run." >&2
}

install_github_cli() {  # opt-in via the 'github-cli' extra; fail-soft like everything else
  $INSTALL_GITHUB_CLI || return 0
  if command -v gh >/dev/null 2>&1; then
    log "github-cli: gh already installed ($(gh --version 2>/dev/null | head -1)) - skipping install"
  elif command -v brew >/dev/null 2>&1; then
    log "github-cli: installing gh via Homebrew"
    brew install gh || { echo "  !! brew install gh failed - install manually: https://cli.github.com" >&2; return 0; }
    # No auth during install (deliberate): run `gh auth login` once before the first GitHub
    # platform use (PRs/issues). Plain git push/pull never needs it.
    log "  installed - run 'gh auth login' before first GitHub platform use"
  else
    echo "  !! brew not found - install Homebrew or gh manually: https://cli.github.com" >&2
  fi
}

# CONFIG_DIR is for path resolution only - never exported to any CLI:
# ~/.cursor - so a cursor install is fully self-contained.
CONFIG_DIR="$HOME/.cursor"

SERENA_CTX="ide-assistant"   # serena's --context for Cursor (generic ide-assistant)

# Shared memory root - always resolved at install time, and deliberately outside the project so
# recall carries across every project installed into.
HOME_MEMORY_DIR="$HOME/.memory-mcp"

if [ "$SCOPE" = "project" ]; then
  cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"
fi

# ===========================================================================
# MANIFEST - edit these, then run.
# ===========================================================================

# (1) Skills, one per line as "repo|skill" (comment a line to skip it).
SKILLS=(
  # House (envoydev/cursor-stack)
  "envoydev/cursor-stack|create-ticket"                         # ticket generator (bug/story/epic/task) - tracker-agnostic EN Markdown, routes to references/<type>.md
  "envoydev/cursor-stack|dev-log-convert"                       # UA/EN work notes -> structured English work log; trigger 'dev-log'
  "envoydev/cursor-stack|explain-code-tutor"                    # senior-mentor explainer for code/bug/concept/trade-off via real-file walkthrough; depth ELI5/intermediate/expert
  "envoydev/cursor-stack|project-quality-loop"                  # autonomous review-and-fix loop pipeline over a loops/ folder of numbered prompts
  "envoydev/cursor-stack|project-architecture-quality-loop"     # deliberate analyze-assess-improve loop - runs the project-architecture-analyzer capture for the map + the project-architecture-quality-analyzer capture for findings, fix cons by tier, reconcile both docs; manual /-only
  "envoydev/cursor-stack|project-code-style-analyzer"           # deliberate code-style capture - fans out code-style-analyzer per language, merges docs/code-style/CODE-STYLE.md, generates the glob-scoped project-code-style rule; manual /-only
  "envoydev/cursor-stack|project-architecture-analyzer"         # deliberate architecture capture - dispatches architecture-analyzer per module, reasons in the main session, writes docs/architecture/ARCHITECTURE.md + the generated awareness rule baseline-project-architecture.mdc; manual /-only
  "envoydev/cursor-stack|project-architecture-quality-analyzer" # deliberate pros/cons capture over the architecture map - dispatches architecture-analyzer per module, runs the findings gate in-session, writes docs/quality/ASSESSMENT.md fresh every run; reads decisions/, never writes them; manual /-only
  "envoydev/cursor-stack|project-test-coverage-analyzer"        # deliberate coverage capture - detect tooling per surface, instrumented run ONCE per surface in the main session, writes docs/test-coverage/COVERAGE.md (90% line after exclusions default, tiered weak points) + raw/ machine-readable results; manual /-only (the loop Read-loads it)
  "envoydev/cursor-stack|project-test-coverage-loop"            # deliberate coverage analyze-triage-fix loop - runs the capture, works weak points by tier (tests inline/implementer briefs, testability refactors approval-gated, structural = user decision), reconciles docs; manual /-only
  "envoydev/cursor-stack|project-version-upgrade"               # deliberate BREAKING version-event flow (framework/runtime/package major) - plan in-session via context7 + architecture-analyzer digests, approval gate (auto mode only on explicit user ask), staged execution via implementers + resolvers; manual /-only
  "envoydev/cursor-stack|project-agent-capabilities"            # deliberate capabilities capture - inventories installed skills/agents/MCPs, generates the awareness rule baseline-project-agent-capabilities.mdc; manual /-only
  "envoydev/cursor-stack|project-related-context"               # deliberate related-projects capture - args paths/URLs, fans out related-project-analyzer per sibling, writes the awareness rule baseline-project-related-context.mdc + docs/related-projects/RELATED-PROJECTS.md; manual /-only
  "envoydev/cursor-stack|project-build-from-scratch"            # greenfield scaffolding + design->scaffold->slice-by-slice build orchestration over the pipeline
  "envoydev/cursor-stack|project-solve-cross-task"              # entry-point router: classify -> smallest execution mode -> cross-domain contract freeze + integration gate; home of the shared subagent policies
  "envoydev/cursor-stack|project-verify-plan"                   # audit an implementation plan BEFORE building - risk-coverage review (traps named per the stack skill, scope, edges, minimal); precedes /review
  "envoydev/cursor-stack|project-verify-code"                   # single-chat, no-dispatch review of an assembled build - the inline alternative to /review: rerun build/test, gate vs plan, RUN the app on failable inputs, trace wire-contract changes to consumers, ranked punch-list
  "envoydev/cursor-stack|project-commit-checkpoint"             # the pre-commit checkpoint + publish ceremony: fresh formatter, project-verify-code, security review on sensitive paths, the COMMIT-GATE / PUSH-GATE receipts guard-ungated-commit reads; loads when a commit or push is next
  "envoydev/cursor-stack|project-implementer"                   # single-chat build step: execute a verified plan task-by-task (contracts + per-task green gate + inline red-resolution, no dispatch), finish via /review + the done-gate
  "envoydev/cursor-stack|project-solution-design"               # single-chat designer twin: read the architecture, judge where a change fits (extend/refactor/isolate), load the stack skill for traps, decompose into an ordered plan; feeds project-verify-plan
  "envoydev/cursor-stack|project-solve-task"                    # gated single-chat vertical: design -> plan audit -> user approval + build mode -> build -> build review (skippable: project-verify-code inline or the verifier seat) -> done-gate; hard user stop between steps, plan-file + serena-note state survives compaction
  "envoydev/cursor-stack|project-runtime-failure-signatures"    # single-chat diagnoser twin: local-runtime crash signatures (null-ref/DI/deadlock/disposed/config-drift/boundary/HTTP-status) -> where to isolate each; pairs with systematic-debugging
  "envoydev/cursor-stack|project-ci-failure-signatures"         # single-chat CI-diagnoser twin: red-pipeline signatures (compile/restore, green-locally-red-on-runner, quality-gate, signing/release, workflow-config, infra-flake) -> code-vs-environment call + route; pairs with project-runtime-failure-signatures
  "envoydev/cursor-stack|project-diagnose-failure"              # gated read-only diagnosis from any evidence: triage to a tier -> gather (inline or evidence-gatherer seats) -> prove the root cause -> user fork (report / contracted fix tasks / log points); manual /-only
  "envoydev/cursor-stack|devops"                                # DevOps for the .NET/Angular house: Docker multi-stage/digest-pinned/non-root, GitHub Actions CI/CD, safe expand-contract deploys, secrets/OIDC, Aspire AppHost
  "envoydev/cursor-stack|database-conventions"                  # cross-engine DB conventions + per-engine skill routing
  "envoydev/cursor-stack|database-security"                     # SQL/data-layer security: parameterized-only injection, least-privilege DB accounts, row-level security, connection-string secrets, encryption, audit
  "envoydev/cursor-stack|typescript"                            # framework-agnostic TS/JS baseline (strict typing, modules, async, JS+JSDoc)
  "envoydev/cursor-stack|javascript"                            # base JS-family language layer: ESM modules, async discipline, two failure channels, modern-feature adoption, untrusted input, naming; typescript stacks on it
  "envoydev/cursor-stack|ts-js-testing"                         # plain TS/JS testing hub: runner routing (Vitest default), role-keyed strategy, seam stubs over module mocks, exclusion catalog - practices only, the % bar is user-set via project-test-coverage-analyzer
  "envoydev/cursor-stack|npm"                                   # professional npm: lockfile+ci discipline, supply-chain baseline (ignore-scripts/cooldown/allow-git), audit gating, overrides vs legacy-peer-deps, exports maps + ESM-first publishing, update-bot cooldowns
  "envoydev/cursor-stack|browser-extension"                     # MV3 browser extensions: ephemeral service worker + storage tiers, typed cross-context messaging, isolated vs MAIN world, least-privilege permissions, CSP-safe UI, WXT tooling, store review + monetization
  "envoydev/cursor-stack|webpack"                               # webpack 5 library builds: transpile/type-check split (swc + fork-ts-checker + tsc declarations), externals from package.json, tree-shaking preconditions, ESM output state, resolution traps, config factory + cache pitfalls
  "envoydev/cursor-stack|angular-conventions"                   # Angular 17+/TS house conventions (signals, OnPush, a11y)
  "envoydev/cursor-stack|angular-testing"                       # Angular testing hub: TestBed/harness patterns, runner routing, exclusion catalog - practices only, the % bar is user-set via project-test-coverage-analyzer
  "envoydev/cursor-stack|angular-material"                      # Angular Material + CDK: selective imports, M3 theming, CDK primitives, harnesses
  "envoydev/cursor-stack|angular-styling"                       # Angular CSS/styling: ViewEncapsulation, :host, ::ng-deep ways-out, design tokens, responsive, a11y styling
  "envoydev/cursor-stack|angular-security"                      # Angular/web frontend security: XSS/DomSanitizer bypass, CSP, CSRF, no-secrets-in-bundle, token storage, SSR/TransferState
  "envoydev/cursor-stack|ionic"                                 # house Ionic/Capacitor conventions: UI, nav, lifecycle, permissions, plugin sourcing + wrapping
  "envoydev/cursor-stack|capacitor-release"                     # Ionic/Capacitor release pipeline: cap sync/build, iOS+Android signing, store submission, OTA, versioning, CI, symbols
  "envoydev/cursor-stack|ionic-security"                        # Ionic/Capacitor mobile security: Keychain/Keystore storage, deep-link validation, permissions, cleartext/WebView hardening
  "envoydev/cursor-stack|csharp"                                # C# house conventions - style, naming, async, logging, DI
  "envoydev/cursor-stack|csharp-design-patterns"                # all 23 GoF patterns with modern .NET 8+ forms
  "envoydev/cursor-stack|dotnet"                                # router mapping .NET work areas to specialist skills
  "envoydev/cursor-stack|dotnet-architecture-tests"             # architecture fitness tests: NetArchTest (default)/ArchUnitNET - layer+dependency+naming+isolation rules as build-failing tests
  "envoydev/cursor-stack|dotnet-aspire"                         # .NET Aspire local orchestration: AppHost, ServiceDefaults, service discovery, dashboard
  "envoydev/cursor-stack|dotnet-authentication"                 # ASP.NET Core authn/authz: JWT/OIDC/Identity, policy-based authz, secrets
  "envoydev/cursor-stack|dotnet-code-quality"                   # C# quality enforcement: CSharpier formatter ownership, SDK analyzers + AnalysisLevel, .editorconfig severity, TreatWarningsAsErrors (+ legacy batch promotion), Roslynator, CI gate
  "envoydev/cursor-stack|dotnet-console-apps"                   # console-app interface surface: CLI arg parsing (System.CommandLine 2.0/Spectre.Console.Cli/Cocona) + bot-SDK integration (Telegram/Discord/Slack/exchange) in a BackgroundService
  "envoydev/cursor-stack|dotnet-cryptography"                   # System.Security.Cryptography: SHA-2, AES-GCM, RSA/ECDSA, PBKDF2/Argon2id, constant-time compare
  "envoydev/cursor-stack|dotnet-web-error-handling"             # Result + ProblemDetails (RFC 9457) + IExceptionHandler + FluentValidation
  "envoydev/cursor-stack|dotnet-grpc"                           # gRPC: .proto/codegen, ASP.NET Core host, 4 streaming modes, JWT/mTLS, interceptors, health
  "envoydev/cursor-stack|dotnet-hosted-services"                # worker/background-service host: BackgroundService, ExecuteAsync trap, scoped scope, PeriodicTimer, shutdown, Channels
  "envoydev/cursor-stack|dotnet-windows-service"                # Windows Service SCM layer: AddWindowsService, budgets, non-zero-exit recovery, sc.exe install, gMSA/hardening, ServiceBase maintenance
  "envoydev/cursor-stack|dotnet-messaging"                      # event-driven messaging: Wolverine (MIT)/MassTransit, outbox, sagas, RabbitMQ/Azure SB
  "envoydev/cursor-stack|dotnet-migrate"                        # safe migration workflow: EF schema, .NET upgrades, NuGet - rollback + verify per step
  "envoydev/cursor-stack|dotnet-minimal-api"                    # minimal API endpoint mechanics: MapGroup, TypedResults, endpoint filters, binding
  "envoydev/cursor-stack|dotnet-mvc-controllers"                # controller-based Web API: [ApiController], attribute routing, ActionResult<T>, auto-400 filter, action filters, binding
  "envoydev/cursor-stack|dotnet-openapi"                        # OpenAPI doc (Swashbuckle / built-in .NET 9+) + Scalar docs UI
  "envoydev/cursor-stack|dotnet-realtime"                       # SignalR real-time: strongly-typed Hub<T>, IHubContext push, groups/presence, reconnection, JWT-over-querystring, Redis/Azure backplane
  "envoydev/cursor-stack|dotnet-security"                       # OWASP Top 10 (2021) -> .NET 8 mitigations; deprecated-pattern warnings
  "envoydev/cursor-stack|dotnet-source-generators"              # Roslyn IIncrementalGenerator authoring + built-in generators (GeneratedRegex/LoggerMessage/STJ)
  "envoydev/cursor-stack|dotnet-testing"                        # .NET test strategy: AAA, per-layer coverage, library routing
  "envoydev/cursor-stack|dotnet-web-backend"                    # ASP.NET Core cross-cutting: HttpClientFactory, OpenAPI, observability
  "envoydev/cursor-stack|dotnet-winforms"                       # WinForms conventions: MVP/binding, disposal, GDI leaks, high-DPI, migration
  "envoydev/cursor-stack|dotnet-wpf"                            # WPF strict-MVVM conventions, bindings, virtualization
  "envoydev/cursor-stack|postgres"                              # PostgreSQL engine delta: index types, JSONB, SARGability, EXPLAIN, pooling
  "envoydev/cursor-stack|sqlite"                                # SQLite engine delta: WAL/single-writer, PRAGMAs, type affinity, limited ALTER
  "envoydev/cursor-stack|dotnet-data-access"                    # EF Core + NHibernate ORM hub (references/): DbContext, tracking, N+1, projection
  "envoydev/cursor-stack|dotnet-architecture"                   # architecture decision hub (references/): clean/ddd/vsa/modular/microservices
  "envoydev/cursor-stack|markdown-style"                        # Markdown authoring / review: syntax canon (valid) + house style overlay, two-pass procedure
  "envoydev/cursor-stack|docs-as-code"                          # docs-as-code authoring: Mermaid sequence/ER diagrams, ADRs (Nygard/MADR 4), C4 views - per-type references/
  "envoydev/cursor-stack|ilspy-decompile"                       # decompile a .NET assembly (ilspycmd via dnx) to read real API/behavior - framework internals, NuGet source, pre-upgrade checks
  "envoydev/cursor-stack|dotnet-project-setup"                  # .NET solution build spine (hub, references/): src/tests layout, .slnx, Directory.Build.props, global.json, central package management, dotnet-tool pinning
  "envoydev/cursor-stack|dotnet-performance"                    # perf-aware .NET design (hub, references/): allocation/type design (struct vs class, Span, ValueTask) + serialization-format choice (STJ source-gen / Protobuf / MessagePack)
  "envoydev/cursor-stack|dotnet-diagnostics"                    # measure/diagnose a live .NET process (hub, references/): BenchmarkDotNet microbenchmarks + crash/hang/OOM dump capture & first-look SOS analysis
  "envoydev/cursor-stack|nx"                                    # Nx monorepo: project-graph nav + 'nx affected' scoping, generators, module-boundary tags; CLI over MCP; serena-vs-nx routing
)

# (3) MCP servers as "name|args"; scope follows SCOPE.
#     @SERENA_CONTEXT@   -> resolved at install time to serena's --context (ide-assistant).
#     @HOME_MEMORY_DIR@  -> resolved at install time to ~/.memory-mcp (the cross-project DB root).
#     \${CLAUDE_PROJECT_DIR:-.} / \${CLAUDE_CONFIG_DIR} are the shared-baseline path tokens carried
#       verbatim from the shared MCPS baseline; Cursor does no shell interpolation, so both are
#       resolved to concrete paths when .cursor/mcp.json is written (see write_mcp_json).
#     memory (mcp-memory-service): the level word (memory-global default | memory-scoped | memory-project)
#       picks the db path; a space (e.g. 'work') only matters at the scoped level (memory_<space>.db).
#       The [sqlite] extra (not the bare package) is REQUIRED - without it the server has no real
#       embedding backend and refuses to start on any db that already holds memories (works once, on an
#       empty db, then breaks every later launch). [sqlite] gives ONNX embeddings (384-dim, same vectors
#       the peer stack's install writes) with no torch/sentence-transformers weight. Pin syntax is
#       `pkg[extra]==version`, not `pkg[extra]@version` - uvx's `@version` shorthand does not compose
#       with an extra. MCP_MEMORY_SQLITE_PRAGMAS=busy_timeout=15000 raises the service's 5000ms default
#       so two processes sharing one db (this install and the peer stack's, say) wait out a write
#       instead of failing SQLITE_BUSY.
#
# PERFORMANCE - network resolution is the cost of a slow new-session start, so it happens HERE
# (install/update), never at launch:
#   - install/update resolves each runtime's LATEST published version (below) and bakes it into the
#     registration. `install` SKIPS MCPs already registered, so the resolved version stays FROZEN
#     until you run `update` (which removes + re-adds -> re-resolves -> bumps). No versions are
#     hardcoded in this script - "latest at provision, frozen until next update".
#   - launch is fast because versions are PINNED (npx skips dist-tag resolution; uvx reuses its
#     cached env). Do NOT add --prefer-offline: with a freshly-resolved latest version, a stale npm
#     cache index reports "no matching version" and the server dies (-32000). The pin alone is the
#     speed-up; npx fetches the exact version once if the cache lacks it, then reuses it.
#   - serena runs from the pinned PyPI package (NOT git+https, which re-fetched the ref on every
#     launch - the biggest startup cost), web dashboard off (no HTTP server spun up).
#   - memory: --with numpy is injected because mcp-memory-service's sqlite_vec backend needs numpy
#     but doesn't declare it, so uvx's isolated env omits it -> "No module named 'numpy'" (-32000).
#   - offline at provision -> resolution yields empty -> the entry falls back to unpinned.
_npm_latest()  { command -v npm >/dev/null 2>&1 && npm view "$1" version 2>/dev/null | tr -d '[:space:]'; }
_pypi_latest() { curl -fsSL "https://pypi.org/pypi/$1/json" 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['info']['version'])" 2>/dev/null; }
# skills-only exits before mcp.json is ever written, so these four lookups would be paid for
# pins nothing reads - and a flag whose whole point is an isolated, dependency-free skill install
# has no business hitting the network first. Skipping leaves the pins empty, which is the same
# already-supported unpinned state as being offline.
if [ "$SKILLS_ONLY" = true ]; then
  MCP_CONTEXT7_VER=""; MCP_PLAYWRIGHT_VER=""; MCP_SERENA_VER=""; MCP_MEMORY_VER=""
else
  log "resolving latest MCP runtime versions (install/update network step)"
  MCP_CONTEXT7_VER="$(_npm_latest @upstash/context7-mcp)"
  MCP_PLAYWRIGHT_VER="$(_npm_latest @playwright/mcp)"
  MCP_SERENA_VER="$(_pypi_latest serena-agent)"
  MCP_MEMORY_VER="$(_pypi_latest mcp-memory-service)"
fi
# Version-pin suffix: "@1.2.3" when resolved, "" (unpinned fallback) when offline.
CTX7_PIN="${MCP_CONTEXT7_VER:+@$MCP_CONTEXT7_VER}"
PW_PIN="${MCP_PLAYWRIGHT_VER:+@$MCP_PLAYWRIGHT_VER}"
SERENA_PIN="${MCP_SERENA_VER:+@$MCP_SERENA_VER}"
# memory's pin uses '==' (PEP 508 requirement syntax), not the '@version' shorthand the other pins
# use above - uvx's `--from pkg@version` shorthand does not compose with the '[sqlite]' extra. Plain
# parameter expansion, not `[ -n ... ] && MEMORY_PIN=...`: under this script's `set -e`, a standalone
# `&&` statement whose left side is false aborts the whole run.
MEMORY_PIN="${MCP_MEMORY_VER:+==$MCP_MEMORY_VER}"
MEMORY_SPEC="mcp-memory-service[sqlite]${MEMORY_PIN}"

MEMORY_BACKEND="sqlite_vec"
MEMORY_PRAGMAS="busy_timeout=15000"
# MEMORY_LEVEL is '' when the run named no level word - set_cursor_mcps keeps an existing
# registration's MCP_MEMORY_SQLITE_PATH byte-for-byte in that case and only upgrades the rest of the
# entry; the path built here is only what a FRESH (nothing registered yet) install actually gets, and
# it defaults to global exactly like an explicit 'memory-global' would.
case "$MEMORY_LEVEL" in
  scoped) MEMORY_DB_PATH="@HOME_MEMORY_DIR@/memory_${SPACE:-default}.db" ;;
  project) MEMORY_DB_PATH='${CLAUDE_PROJECT_DIR:-.}/.memory-mcp/memory.db' ;;  # single-quoted: stays literal for set_cursor_mcps' own token substitution
  *) MEMORY_DB_PATH="@HOME_MEMORY_DIR@/memory.db" ;;
esac
MEMORY_ENTRY="memory|-e MCP_MEMORY_STORAGE_BACKEND=$MEMORY_BACKEND -e MCP_MEMORY_SQLITE_PATH=$MEMORY_DB_PATH -e MCP_MEMORY_SQLITE_PRAGMAS=$MEMORY_PRAGMAS -- uvx --with numpy --from $MEMORY_SPEC memory server"

# context7 runs REMOTE (the hosted server) by DEFAULT - no local process, and the key stays out of
# .cursor/mcp.json: set CONTEXT7_API_KEY as an OS/user environment variable and Cursor expands
# ${env:CONTEXT7_API_KEY} in the header at launch. Pass the 'context7-local' arg for the local stdio
# server - keyless by default too, and CONTEXT7_BAKE_KEY=1 (with CONTEXT7_API_KEY) bakes --api-key in (keep
# the resulting .cursor/mcp.json uncommitted).
if [ "$CONTEXT7_MODE" = "local" ]; then
  CONTEXT7_SPEC="-- npx -y @upstash/context7-mcp${CTX7_PIN}"
  if [ -n "${CONTEXT7_BAKE_KEY:-}" ] && [ -n "${CONTEXT7_API_KEY:-}" ]; then
    CONTEXT7_SPEC="$CONTEXT7_SPEC --api-key $CONTEXT7_API_KEY"
  fi
else
  CONTEXT7_SPEC="@HTTP@"
fi
CONTEXT7_ENTRY="context7|$CONTEXT7_SPEC"

MCPS=(
  "angular-cli|-- npx -y @angular/cli mcp" # angular-cli: only for Angular workspaces - comment out elsewhere (unpinned: matches the workspace ng).
  "serena|-e SERENA_HOME=.serena/home -- uvx --from serena-agent${SERENA_PIN} serena start-mcp-server --context @SERENA_CONTEXT@ --enable-web-dashboard false --project-from-cwd" # LSP symbol navigation; per-project SERENA_HOME (.serena/home - gitignore it, holds ~327MB LSP) isolates serena's registry/memories/logs/LSP, no pooling across projects/accounts; --project-from-cwd self-activates the repo (.serena/project.yml in cwd) on launch; PyPI (not git), dashboard off
  "playwright|-- npx -y @playwright/mcp${PW_PIN} --user-data-dir \${CLAUDE_PROJECT_DIR:-.}/.playwright --output-dir \${CLAUDE_PROJECT_DIR:-.}/.playwright/screenshots" # drive a real browser for visual checks / web app verification
  "chrome-devtools|-- npx chrome-devtools-mcp@latest" # OPT-IN browser/extension debug; drives a full Chrome (heavy) - comment out outside web projects; no WS-frame payloads; pin a version
  "appium-mcp|-- npx -y appium-mcp@latest" # OPT-IN native mobile E2E (official Appium MCP); embedded UiAutomator2/XCUITest drivers, needs Xcode and/or Android SDK + Java (heavy) - comment out outside Capacitor/Ionic mobile projects; pin a version
  "sentry|@HTTP@" # OPT-IN Sentry error monitoring - hosted remote MCP (mcp.sentry.dev); auth via an Authorization: Sentry-Bearer ${env:SENTRY_ACCESS_TOKEN} header in .cursor/mcp.json (OS env), or no header under 'sentry-oauth'; comment out where the project has no Sentry
  "$MEMORY_ENTRY"  # memory: shared cross-project recall (required, like serena) - preferences, corrections and lessons the docs domains don't hold
  "$CONTEXT7_ENTRY"                           # up-to-date library/framework/SDK docs (beats recalled API knowledge)
)

# (5) Cursor hooks "filename::event" + rules. These are CURSOR-contract scripts (.cursor/hooks.json
# v1) copied out of the run's source clone (hooks/). Each reads its payload on stdin and answers
# an allow/deny permission. A file may be wired to more than one event - list it once per event.
#   - guard-protected-force-push -> beforeShellExecution (blocks a force-push to main/master/develop).
#   - guard-catastrophic-rm      -> beforeShellExecution (blocks recursive rm of /, ~, $HOME, bare *).
#   - guard-ungated-commit       -> beforeShellExecution (a non-trivial git commit needs the review receipt).
#   - guard-read-whole-file      -> beforeReadFile + beforeShellExecution (a whole-file read of a large
#                                   source file, by tool or by shell cat, goes through serena first).
#   - guard-unapproved-dispatch  -> subagentStart (an implementer fan-out needs the recorded approval).
#   - guard-secret-value         -> preToolUse + beforeShellExecution + beforeReadFile (a credential is read for
#                                   presence, never its value: a dump is redacted or denied, judged by content).
#   - docs-session               -> sessionStart + preToolUse + stop (every docs domain's start block, the
#                                   first source change held until a covering section was read, and the
#                                   watch-list nudge at session end via stop's followup_message - Cursor's stop
#                                   cannot block, so this is a nudge, not a gate). Wired UNSCOPED on preToolUse,
#                                   like guard-secret-value - the tool_name check is inside the hook. Ships its
#                                   engine, docs.js, beside it (copied, never itself wired to an event). NOT
#                                   SHIPPED: the subagentStart orientation - Cursor's subagentStart can only
#                                   answer allow/deny, with no channel to inject context, so a dispatched
#                                   subagent reads the generated baseline-project-architecture.mdc pointer rule
#                                   instead of the docs hook's push.
#   - memory-session             -> sessionStart (pushes the memory MCP's own stored preferences,
#                                   corrections, project facts and lessons into the session, newest
#                                   first, own-project then global then related-project, capped at 4KB).
#                                   Ships its engine, memory.js, beside it (copied, never itself wired
#                                   to an event - same split as docs-session/docs.js). Silent whenever
#                                   nothing can be shown (no memory server registered, an empty
#                                   selection, node:sqlite unavailable below Node 22.13) - never blocks
#                                   a session start.
# Two guards do NOT map onto Cursor's hook surface: a stop-contract gate (the stop hook cannot block
# and never sees the response text, and there is no question tool to gate) and usage instrumentation
# (its analyzer reads a transcript format Cursor does not produce).
# Convention enforcement is NOT a hook - its home is a soft, glob-auto-attaching rule
# (.cursor/rules/*.mdc, see CURSOR_RULES), never a pre-edit block.
CURSOR_HOOKS=(
  "guard-protected-force-push.js::beforeShellExecution"
  "guard-catastrophic-rm.js::beforeShellExecution"
  "guard-ungated-commit.js::beforeShellExecution"
  "guard-read-whole-file.js::beforeReadFile"
  "guard-read-whole-file.js::beforeShellExecution"
  "guard-unapproved-dispatch.js::subagentStart"
  "guard-secret-value.js::preToolUse"
  "guard-secret-value.js::beforeShellExecution"
  "guard-secret-value.js::beforeReadFile"
  "docs-session.js::sessionStart"
  "docs-session.js::preToolUse"
  "docs-session.js::stop"
  "memory-session.js::sessionStart"
)
# A rule entry is "name" (copied from the source clone's rules/) or "name|url" (fetched from that
# url - the form for a third-party rule we would reference rather than vendor; currently unused,
# and the one entry shape that still touches the network).
CURSOR_RULES=(
  # Always-on baseline (no paths) - loads every session like AGENTS.md; one job per file, comment out what a project doesn't want.
  "baseline-interaction.mdc"             # communication + evaluating-proposals + planning (merged by exclusion affinity)
  "baseline-quality-gates.mdc"           # code-quality + definition-of-done (merged by exclusion affinity)
  "baseline-security.mdc"
  "baseline-git.mdc"
  "baseline-navigation.mdc"
  "baseline-docs-root.mdc"               # generated-docs root resolution (CURSOR_DOCS_PATH)
  "baseline-memory.mdc"                  # what belongs in the shared memory MCP vs the docs domains
  # Path-scoped routing
  "markdown-docs.mdc"                    # markdown-style routing, path-scoped **/*.md
  "javascript-conventions.mdc"           # JS-family conventions, path-scoped js/jsx/mjs/cjs
  "dotnet-repair-agents.mdc"             # .NET repair-loop routing, path-scoped cs/csproj/sln/xaml
  "angular-repair-agents.mdc"            # Angular repair-loop routing, path-scoped
  # Convention rules (soft, glob auto-attach) - each points ONE file family at its house-style skill; replaced the require-convention-skill hard gate.
  "typescript-conventions.mdc"           # ts/js family -> typescript (framework-agnostic baseline)
  "angular-conventions.mdc"              # Angular file shapes -> angular-conventions (Angular/Ionic projects only)
  "angular-styling-conventions.mdc"      # scss/css -> angular-styling (Angular/Ionic projects only)
  "csharp-conventions.mdc"               # c#: .cs -> csharp (backend, desktop, console)
  "wpf-conventions.mdc"                  # wpf: .xaml -> dotnet-wpf
  "winforms-conventions.mdc"             # winforms: .Designer.cs + *Form.cs code-behind -> dotnet-winforms
  "sql-conventions.mdc"                  # sql: .sql -> database-conventions
  "devops-conventions.mdc"               # rest (devops): Dockerfile/compose/workflow/deploy script -> devops
)

# (6) Subagents (cursor): Cursor-native specialist agents copied into .cursor/agents/ from the run's
# source clone (agents/) on BOTH actions
# (per-agent fail-soft - an agent not yet upstream keeps any existing local copy). Cursor auto-discovers
# .cursor/agents/*.md; no settings wiring needed. All 43 subagents. Cursor (2.5+) has a Task tool and
# subagents that inherit the parent's MCP servers, so the roster carries the FULL orchestration -
# project-task-flow fans out designer/implementer/verifier via the Task tool, the diagnosers dispatch
# evidence-gatherer, and the serena-memory handoff works (MCP is inherited). Cursor's platform limits
# shape the contract: `model: inherit` (Cursor documents only opus-at-high, so effort/model cannot be
# pinned per agent - they inherit the session model), no per-tool `tools:` allowlist (only `readonly`),
# superpowers is an optional /add-plugin (methods referenced 'if installed'), and auto-delegation cannot be
# hard-disabled at the agent level. Bodies lean on the auto-attaching .cursor/rules + installed skills.
CURSOR_AGENTS=(
  "dotnet-build-error-resolver.md"              # implement phase: dotnet build -> categorize errors -> minimal fix loop (serena/LSP), capped
  "dotnet-test-failure-resolver.md"             # implement phase: dotnet test -> red->green repair loop, anti-reward-hacking guard, capped
  "ng-build-error-resolver.md"                  # implement phase: ng build -> minimal fix loop (serena/LSP), capped
  "angular-test-resolver.md"                    # implement phase: ng test/Jest -> red->green repair loop, anti-reward-hacking, capped
  "architecture-analyzer.md"                    # analysis support: read-only per-module characterizer (purpose/surface/deps/patterns/smells) - the architecture + test-coverage captures fan it out, also independently callable
  "test-coverage-analyzer.md"                   # analysis phase: read-only per-surface coverage characterizer - the project-test-coverage-analyzer skill fans it out over the raw results; never runs the suite
  "code-style-analyzer.md"                      # analysis phase: read-only per-language style characterizer - the project-code-style-analyzer skill fans it out per language and merges docs/code-style/CODE-STYLE.md + the inject-code-style hook from its structured reports
  "related-project-analyzer.md"                 # analysis support: read-only sibling-repo characterizer (name/relation/first_read/seam, URL siblings shallow-cloned to scratch) - the project-related-context skill fans it out per sibling and merges docs/related-projects/RELATED-PROJECTS.md
  "ci-failure-diagnoser.md"                     # analysis phase: read-only CI red-run diagnosis via gh - categorize, local repro, route
  "runtime-failure-diagnoser.md"                # analysis phase: read-only bug diagnosis from logs/errors/screenshots - root cause + route, no fix
  "evidence-gatherer.md"                        # diagnosis support: read-only - a diagnoser dispatches it to reproduce/confirm and return a compact digest, keeping log volume off the opus seat
  "security-auditor.md"                         # analysis phase: read-only cross-stack security posture audit - OWASP/CWE punch-list routed to implementers, complements /review
  "integration-reviewer.md"                     # final gate: read-only cross-domain integration review - contract consistency, assembled build/test/migration, the commit gate no single-stack verifier is
  # Per-domain specialist team (10 stacks x designer/implementer/verifier) + architect analysis agents above; model/effort pinned in frontmatter
  "aspnet-solution-designer.md"                 # design phase: ASP.NET Core architecture + plan + test strategy, decomposes into parallel tasks
  "aspnet-implementer.md"                       # build phase: builds one ASP.NET task - code + tests
  "aspnet-verifier.md"                          # verify phase: gates the ASP.NET build vs plan + quality, punch-list back
  "web-angular-solution-designer.md"            # design phase: Angular architecture + plan + test strategy, decomposes
  "web-angular-implementer.md"                  # build phase: builds one Angular task - code + tests
  "web-angular-verifier.md"                     # verify phase: gates the Angular build vs plan + quality
  "wpf-solution-designer.md"                    # design phase: WPF strict-MVVM architecture + plan + test strategy, decomposes
  "wpf-implementer.md"                          # build phase: builds one WPF task - code + tests
  "wpf-verifier.md"                             # verify phase: gates the WPF build vs plan + quality
  "console-solution-designer.md"                # design phase: headless .NET (Generic Host worker/bot/daemon/CLI) architecture + plan + test strategy, decomposes
  "console-implementer.md"                      # build phase: builds one console/worker task - code + tests
  "console-verifier.md"                         # verify phase: gates the console/worker build vs plan + quality
  "ionic-angular-solution-designer.md"          # design phase: Ionic/Capacitor architecture + plan + test strategy, decomposes
  "ionic-angular-implementer.md"                # build phase: builds one mobile task - code + tests
  "ionic-angular-verifier.md"                   # verify phase: gates the mobile build vs plan + quality
  "data-solution-designer.md"                   # design phase: schema/data-model architecture + plan + test strategy, decomposes
  "data-implementer.md"                         # build phase: builds one data task - SQL + migration tests
  "data-verifier.md"                            # verify phase: gates the data build vs plan + quality
  "devops-solution-designer.md"                 # design phase: Docker/CI/CD/deploy architecture + plan + validation strategy, decomposes
  "devops-implementer.md"                       # build phase: builds one devops task - Dockerfile/workflow/deploy + local validation
  "devops-verifier.md"                          # verify phase: gates the devops build vs plan + quality
  "browser-extension-solution-designer.md"      # design phase: MV3 extension architecture (SW/content/UI topology, message contract, permissions) + plan + test strategy, decomposes
  "browser-extension-implementer.md"            # build phase: builds one extension task - code + tests
  "browser-extension-verifier.md"               # verify phase: gates the extension build vs plan + quality
  "windows-service-solution-designer.md"        # design phase: SCM recovery/budget/identity topology + plan + test strategy, decomposes
  "windows-service-implementer.md"              # build phase: builds one Windows Service task - code + tests
  "windows-service-verifier.md"                 # verify phase: gates the Windows Service build vs plan + quality
  "winforms-solution-designer.md"               # design phase: WinForms MVP seam / binding / disposal topology + plan + test strategy, decomposes
  "winforms-implementer.md"                     # build phase: builds one WinForms task - code + tests
  "winforms-verifier.md"                        # verify phase: gates the WinForms build vs plan + quality
)

# (7) Retired names - artifacts this stack once installed and no longer ships. Their files left the
# manifests above, so the copy loops never touch them again: a leftover skill keeps auto-triggering
# next to its successor, a leftover agent stays dispatchable under its old name, and a leftover
# alwaysApply rule keeps loading into every chat. Every run (install == update here) removes exactly
# these names and nothing else - an absent one is a no-op. Extend the matching list whenever a skill,
# rule or agent is renamed or removed. Unquoted on purpose: the parity lint reads the quoted manifest
# blocks only.
RETIRED_SKILLS=(frontend mobile project-task-flow project-task-cycle project-capabilities project-failure-signatures data-security dotnet-error-handling mobile-security)
RETIRED_RULES=(ponytail.mdc scss-conventions.mdc)
RETIRED_AGENTS=(angular-solution-designer.md angular-implementer.md angular-verifier.md mobile-solution-designer.md mobile-implementer.md mobile-verifier.md code-analyzer.md issue-diagnoser.md)

# ===========================================================================
# INSTALL - skills re-add UNCONDITIONALLY (clean copy each run); the .cursor tree is refreshed
# (mcp.json: install skips an already-present server / update re-writes it; hooks.json / rules skip if already wired)
# ===========================================================================
# ===========================================================================
# SOURCE - the ONE revision every artifact in a run comes from
# ===========================================================================
# Every file this stack installs (skills, hooks, agents, rules) lives in this one repo, so a run
# resolves ONE source snapshot and copies out of it. That replaced the per-file
# raw.githubusercontent.com fetches for hooks/rules/agents, for two reasons:
#   - Correctness: raw.githubusercontent.com is CDN-cached (~5 min to propagate after a push), while
#     one snapshot is not. A run that mixed the two could straddle a push and install skills from one
#     revision and agents/rules/hooks from another - silently. One snapshot cannot.
#   - Cost: it collapses ~47 round trips (2 hooks + 12 rules + 33 agents) into a single fetch.
# The snapshot is the rolling release archive first (one asset = one revision, and no git needed to
# take it; the RELEASE-SOURCE file inside names the commit), falling back to a shallow clone when no
# release is reachable - a fork without releases, a blocked CDN, or a local path used by the tests.
# Fail-soft is unchanged: no source leaves SOURCE_DIR empty, every per-file step keeps any existing
# local copy, and STACK_SHA stays empty - which is what suppresses the stamp write, because a wrong
# stamp is worse than none.
SOURCE_DIR=""        # the tree we copy out of
SOURCE_ROOT=""       # what to rm -rf (archive route nests SOURCE_DIR under it)
SOURCE_REPO_URL=""
STACK_SHA=""
STACK_REF=""
SOURCE_FAILED=false

ensure_source() {
  # Resolves on the first call; every later caller reuses it. Memoise BOTH outcomes: five steps call
  # this, and without the failure latch an offline run pays five timeouts for one root cause.
  [ -n "$SOURCE_DIR" ] && return 0                       # one source per run - resolved already
  [ "$SOURCE_FAILED" = true ] && return 1                # ... and one attempt: don't retry per artifact
  local tmp url
  SOURCE_REPO_URL="${STACK_SOURCE_REPO:-${STACK_SKILLS_REPO:-https://github.com/envoydev/cursor-stack}}"

  # Release archive first: one asset is one revision, and no git is needed to take it. The sanity
  # check (skills/ + agents/ present) matters - a wrong URL that 200s would otherwise 'install'
  # nothing and report 47 per-file failures for one bad source.
  tmp="$(mktemp -d)"
  url="$SOURCE_REPO_URL/releases/latest/download/cursor-stack.tar.gz"
  if command -v curl >/dev/null 2>&1 &&
     curl -fsSL "$url" -o "$tmp/cursor-stack.tar.gz" 2>/dev/null &&
     mkdir -p "$tmp/repo" &&
     tar -xzf "$tmp/cursor-stack.tar.gz" -C "$tmp/repo" 2>/dev/null &&
     [ -d "$tmp/repo/skills" ] && [ -d "$tmp/repo/agents" ]; then
    SOURCE_DIR="$tmp/repo"; SOURCE_ROOT="$tmp"
    STACK_SHA="$(sed -n 's/^sha: //p' "$tmp/repo/RELEASE-SOURCE" 2>/dev/null | head -1)"
    STACK_REF="$(sed -n 's/^ref: //p' "$tmp/repo/RELEASE-SOURCE" 2>/dev/null | head -1)"
    log "source: release archive @ ${STACK_REF:-?} $(printf '%.12s' "${STACK_SHA:-unknown}") ($url)"
    return 0
  fi
  rm -rf "$tmp"

  # Fallback: a shallow clone - a fork without releases, a blocked release CDN, or a local test path.
  command -v git >/dev/null 2>&1 || { log "  !! release archive unreachable and git not found - no source"; SOURCE_FAILED=true; return 1; }
  tmp="$(mktemp -d)"
  # Pinned to main: the release branch is what installs deliver, never whatever the repo's
  # default branch happens to be (development lands on develop).
  if ! git clone --depth 1 -b main "$SOURCE_REPO_URL" "$tmp" >/dev/null 2>&1; then
    log "  !! release archive and clone of $SOURCE_REPO_URL both failed - every artifact step keeps its existing copy"
    rm -rf "$tmp"; SOURCE_FAILED=true; return 1
  fi
  SOURCE_DIR="$tmp"; SOURCE_ROOT="$tmp"
  STACK_SHA="$(git -C "$tmp" rev-parse HEAD 2>/dev/null || true)"
  STACK_REF="$(git -C "$tmp" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  [ -n "$STACK_SHA" ] && log "source: clone fallback @ ${STACK_REF:-?} ${STACK_SHA:0:12} ($SOURCE_REPO_URL)" \
                      || log "source: clone fallback ($SOURCE_REPO_URL; no revision - no stamp this run)"
  return 0
}
cleanup_source() { [ -n "$SOURCE_ROOT" ] && rm -rf "$SOURCE_ROOT"; return 0; }
trap cleanup_source EXIT

# The install is versioned, not the file: Cursor has no per-artifact version field (SKILL.md is
# name/description/paths/disable-model-invocation/metadata; an agent is name/description/model/
# readonly/is_background), so a `version:` key would parse nowhere. Instead one stamp names the
# commit every artifact in this run was copied from - exact for every one, nothing to hand-bump.
write_stamp() {
  # No revision -> no stamp. A stamp that names the wrong commit is worse than none, so leave any
  # previous stamp untouched rather than overwrite it with a guess.
  [ -n "$STACK_SHA" ] || { log "  stamp: skipped - no source revision resolved this run"; return 0; }
  local dir dest
  # $PWD for project scope, matching install_skills' dest: the stamp belongs beside the tree it describes.
  case "$SCOPE" in project) dir="$PWD/.cursor" ;; *) dir="$CONFIG_DIR" ;; esac
  mkdir -p "$dir"; dest="$dir/cursor-stack.stamp"
  cat > "$dest" <<STAMP
# cursor-stack install stamp - machine-local, written by cursor-stack.sh / cursor-stack.ps1.
# Names the source commit every artifact in this tree was copied from. Do not hand-edit.
source_repo=$SOURCE_REPO_URL
source_commit=$STACK_SHA
scope=$SCOPE
action=$ACTION
STAMP
  log "  stamp -> $dest (${STACK_SHA:0:12})"
}

install_skills() {
  # git-copy: clone the stack repo (depth 1) and copy each selected skills/<name>/ straight into
  # .cursor/skills - all house skills live in THIS repo (envoydev/cursor-stack), so a plain copy
  # fully reproduces what the skills CLI used to stage. STRICT independence preserved: the dest is
  # .cursor/skills as real copies, never a dependency on a shared .agents/ store
  # (no separate npx-then-copy step needed any more - this writes .cursor/skills directly).
  prune_retired_skills
  ensure_source || { log "  !! no source clone - skills not installed"; return 0; }   # fail-soft: skip, never abort
  local name dest entry
  case "$SCOPE" in project) dest="$PWD/.cursor/skills" ;; *) dest="$CONFIG_DIR/skills" ;; esac
  mkdir -p "$dest"
  for entry in "${SKILLS[@]}"; do
    name="${entry#*|}"
    if [ -d "$SOURCE_DIR/skills/$name" ]; then
      rm -rf "$dest/$name"; cp -R "$SOURCE_DIR/skills/$name" "$dest/$name"
      log "skill [$SCOPE]: $name -> $dest/$name"
    else
      log "  !! skill '$name' not found in $SOURCE_REPO_URL"
    fi
  done
}

prune_retired_skills() {  # drop the RETIRED_SKILLS names under the scope dest (install_skills' own dest)
  local dest name
  case "$SCOPE" in project) dest="$PWD/.cursor/skills" ;; *) dest="$CONFIG_DIR/skills" ;; esac
  for name in ${RETIRED_SKILLS[@]+"${RETIRED_SKILLS[@]}"}; do
    [ -d "$dest/$name" ] && { rm -rf "${dest:?}/$name"; log "  skill pruned (retired upstream): $name"; }
  done
  return 0
}

set_cursor_mcps() {
  # Write/merge Cursor's MCP config: <repo>/.cursor/mcp.json (project) or ~/.cursor/mcp.json (global).
  # Cursor does NOT do shell-style ${VAR} interpolation, so resolve those tokens to concrete paths here.
  # Idempotency: a plain `install` SKIPS an MCP already in mcp.json (its baked
  # pin stays FROZEN); only `update` re-resolves latest and re-writes the entry (bumps the pin).
  local root proj_dir mcp_path entry name args spec tok_proj tok_cfg
  root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ "$SCOPE" = "project" ]; then
    [ -n "$root" ] || { log "  !! not in a git repo - skipping cursor mcp.json"; return 0; }
    mcp_path="$root/.cursor/mcp.json"
  else
    mcp_path="$HOME/.cursor/mcp.json"
  fi
  mkdir -p "$(dirname "$mcp_path")"
  command -v python3 >/dev/null || { log "  !! python3 not found - skipping cursor mcp.json"; return 0; }
  proj_dir="${root:-$(pwd)}"
  tok_proj='${CLAUDE_PROJECT_DIR:-.}'
  tok_cfg='${CLAUDE_CONFIG_DIR}'

  local resolved=()
  for entry in "${MCPS[@]}"; do
    name="${entry%%|*}"; args="${entry#*|}"
    spec="${args//@SERENA_CONTEXT@/$SERENA_CTX}"
    spec="${spec//@HOME_MEMORY_DIR@/$HOME_MEMORY_DIR}"
    spec="${spec//"$tok_proj"/$proj_dir}"
    spec="${spec//"$tok_cfg"/$CONFIG_DIR}"
    # Cursor's launch-time interpolation syntax is ${env:VAR} (no shell ${VAR} expansion) - rewrite any
    # remaining bare ${VAR} token into it (none in the current baseline - the remote entries below carry
    # their ${env:VAR} form directly; kept for future stdio entries). The path tokens above are already
    # resolved and ${VAR:-default} forms never reach here.
    spec="$(printf '%s' "$spec" | sed -E 's/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/${env:\1}/g')"
    resolved+=("$name|$spec")
  done

  local prog; prog=$(cat <<'PY'
import json, os, sys
path, action, sentry_auth, pw_browsers, pw_enabled, mem_level = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4].split(), sys.argv[5], sys.argv[6]
# Refuse a file that parses to the wrong shape rather than falling back to {} - that would REPLACE
# whatever the project already has in mcp.json with just the stack's own servers. An array, string,
# number or boolean all parse fine, and data.setdefault below would then throw on any of them
# (AttributeError or TypeError, depending on the shape) - isinstance is checked up front instead so the
# failure is one clear line, not a traceback.
if os.path.exists(path):
    try:
        data = json.load(open(path))
    except Exception as exc:
        print("  !! mcp.json is not valid JSON (%s) - left untouched; fix it and re-run" % exc)
        sys.exit(1)
    if not isinstance(data, dict):
        print("  !! mcp.json top level is not an object - left untouched")
        sys.exit(1)
else:
    data = {}
servers = data.setdefault("mcpServers", {})
# playwright: a server drives ONE browser, fixed at launch (`--browser`; no runtime switch), so the
# manifest's single `playwright` line becomes one playwright-<engine> server per kept browser, each with
# its own profile folder. Kept = the asked browsers, else the servers already here (a legacy `playwright`
# entry counts as its --browser engine, none = chrome), else chrome. A legacy entry and every dropped
# browser's server are removed; which one is ON is the user's toggle in Customize.
ENGINES = ["chrome", "msedge", "firefox", "webkit"]
def pw_registered():
    got = set()
    for n, v in servers.items():
        if n.startswith("playwright-") and n[len("playwright-"):] in ENGINES:
            got.add(n[len("playwright-"):])
        elif n == "playwright" and isinstance(v, dict):
            a = v.get("args") or []
            got.add(a[a.index("--browser") + 1] if "--browser" in a[:-1] else "chrome")
    return got
lines = []
for line in sys.stdin.read().splitlines():
    if not line.strip():
        continue
    name, spec = line.split("|", 1)
    if name != "playwright":
        lines.append((name, spec)); continue
    want = set(pw_browsers) or pw_registered()
    if pw_enabled:
        want.add(pw_enabled)
    pw_kept = [e for e in ENGINES if e in want] or ["chrome"]
    for gone in ["playwright"] + ["playwright-" + e for e in ENGINES if e not in pw_kept]:
        if gone in servers:
            del servers[gone]
            print("  cursor mcp removed: " + gone + (" (now one server per browser engine)" if gone == "playwright" else " (browser dropped)"))
    for e in pw_kept:
        words, out, prev = spec.split(), [], ""
        for w in words:
            out.append(w + "/" + e if prev == "--user-data-dir" else w)
            if w.startswith("@playwright/mcp"):
                out += ["--browser", e]
            prev = w
        lines.append(("playwright-" + e, " ".join(out)))
    if pw_enabled and len(pw_kept) > 1:
        print("  cursor playwright: keep playwright-" + pw_enabled + " on - switch off "
              + ", ".join("playwright-" + e for e in pw_kept if e != pw_enabled)
              + " in Customize (or: agent mcp disable <name>)")
for name, spec in lines:
    # Skip-if-present on plain install: an MCP
    # already in mcp.json keeps its baked pin (FROZEN until `update` re-resolves and re-writes it).
    # Without this a plain install would re-write the freshly-resolved latest pin and silently bump it.
    # sentry is the one server with no pin to freeze, so the skip yields to a mode ask and to the
    # plain-Bearer migration below - an entry written with the old scheme is rewritten on EVERY run.
    old = servers.get(name) if isinstance(servers.get(name), dict) else None
    old_hdr = ((old or {}).get("headers") or {}).get("Authorization", "")
    stale_sentry = name == "sentry" and old is not None and (bool(sentry_auth) or old_hdr.startswith("Bearer "))
    if action == "install" and name in servers and not stale_sentry:
        print("  cursor mcp " + name + " already configured - skipping")
        continue
    if spec.strip() == "@HTTP@":
        # remote (hosted) server - url/header keyed by name: sentry, else context7
        if name == "sentry":
            # Sentry-Bearer is Sentry's scheme for a direct API token; plain Bearer is reserved for the
            # server's own OAuth-issued tokens and rejects an API token as invalid_token. oauth mode
            # writes NO header: a set-but-wrong header would disable the sign-in fallback, so the two
            # modes never mix. No mode asked -> keep a deliberately headerless entry headerless.
            headerless = old is not None and "mcp.sentry.dev" in str(old.get("url", "")) and not old_hdr
            mode = sentry_auth or ("oauth" if headerless else "token")
            if old_hdr.startswith("Bearer "):
                print("  cursor mcp sentry: migrating the plain Bearer header to Sentry-Bearer")
                mode = sentry_auth or "token"
            entry = {"url": "https://mcp.sentry.dev/mcp"}
            if mode == "token":
                entry["headers"] = {"Authorization": "Sentry-Bearer ${env:SENTRY_ACCESS_TOKEN}"}
            servers[name] = entry
            print("  cursor mcp: sentry (" + mode + ")")
            continue
        else:
            servers[name] = {"url": "https://mcp.context7.com/mcp",
                             "headers": {"CONTEXT7_API_KEY": "${env:CONTEXT7_API_KEY}"}}
        print("  cursor mcp: " + name)
        continue
    # ASSUMPTION: no resolved path token (proj_dir / CONFIG_DIR / HOME_MEMORY_DIR) contains a space.
    # The spec is space-separated by design (-e KEY=VAL -- cmd args); a space inside one token would
    # be mis-parsed here, so project paths with spaces are unsupported.
    tokens = spec.split()
    env, cmd, cmd_args, after_sep, i = {}, None, [], False, 0
    while i < len(tokens):
        t = tokens[i]
        if not after_sep:
            if t == "--":
                after_sep = True; i += 1
            elif t == "-e":
                k, _, v = tokens[i + 1].partition("="); env[k] = v; i += 2
            else:
                i += 1            # ignore any other pre-`--` mcp flags (not used by Cursor)
        else:
            if cmd is None: cmd = t
            else: cmd_args.append(t)
            i += 1
    if cmd is None:
        continue
    # memory, no level word this run: keep the EXISTING registration's db path byte-for-byte (a level
    # word always wins outright) and only upgrade the rest of the entry (command/args/pin/pragmas) -
    # so a plain `update` never silently relocates a project's or a space's memories to global.
    if name == "memory" and not mem_level and old is not None:
        old_path = (old.get("env") or {}).get("MCP_MEMORY_SQLITE_PATH")
        if old_path:
            env["MCP_MEMORY_SQLITE_PATH"] = old_path
    server = {"command": cmd, "args": cmd_args}
    if env:
        server["env"] = env
    servers[name] = server
    print("  cursor mcp: " + name)
json.dump(data, open(path, "w"), indent=2); open(path, "a").write("\n")
print("  cursor mcp.json -> " + path)
PY
)
  # The guard above prints its own specific diagnosis and exits 1 on a bad shape; this tail is what
  # keeps that exit from taking the whole install down under `set -euo pipefail` - without it the
  # pipeline's failure aborts the script here, before migrate_docs_domains ever runs, which is the
  # exact bug this fix removes.
  printf '%s\n' "${resolved[@]}" | python3 -c "$prog" "$mcp_path" "$ACTION" "$SENTRY_AUTH" "$PLAYWRIGHT_BROWSERS" "$PLAYWRIGHT_ENABLED" "$MEMORY_LEVEL" || log "  !! mcp.json wiring failed - left untouched"
  ensure_playwright_browser "$mcp_path"
  ensure_memory_gitignore "$mcp_path" "$proj_dir"
}

# After set_cursor_mcps has written (or left untouched) mcp.json, keep a project-level memory db out of
# git the same way every other stack-generated, machine-local artifact is called out - a printed
# reminder alone (see the end-of-run summary) is not enough for a folder holding personal recall notes,
# so this one writes its OWN .gitignore, absent-only, touching nothing but that one file. Reads the
# path back from the WRITTEN file rather than from $MEMORY_LEVEL, so a plain `update` that kept an
# existing project-level path byte-for-byte (no level word this run) is covered too, not just a fresh
# `memory-project` install.
ensure_memory_gitignore() {
  local mcp_path="$1" proj_dir="$2" db_path gitignore_dir
  command -v python3 >/dev/null 2>&1 || return 0
  db_path="$(python3 -c '
import json, sys
try:
    servers = json.load(open(sys.argv[1])).get("mcpServers") or {}
except Exception:
    sys.exit(0)
print(((servers.get("memory") or {}).get("env") or {}).get("MCP_MEMORY_SQLITE_PATH") or "")' "$mcp_path" 2>/dev/null)"
  [ -n "$db_path" ] || return 0
  case "$db_path" in
    "$proj_dir/.memory-mcp/"*)
      gitignore_dir="$proj_dir/.memory-mcp"
      if [ ! -f "$gitignore_dir/.gitignore" ]; then
        if mkdir -p "$gitignore_dir" 2>/dev/null && printf '*\n' > "$gitignore_dir/.gitignore" 2>/dev/null; then
          log "  cursor memory: .memory-mcp/.gitignore written (project-level db kept out of git)"
        else
          log "  !! could not write $gitignore_dir/.gitignore"
        fi
      fi
      ;;
  esac
}

# firefox / webkit are Playwright's own builds, not a browser the machine already has: download each one
# a written playwright-<engine> server names through the server's OWN bundled playwright (`npx -p <that
# server's pinned @playwright/mcp> playwright`), so the build matches the version Cursor launches. Fail-soft.
ensure_playwright_browser() {
  local pkg engine
  # Fail-soft against a malformed mcp.json too: the guard above may have left the file genuinely
  # untouched (bad JSON, or parsed to a non-object), and this reads that SAME file straight off disk
  # again rather than the already-guarded in-memory value - without its own try/except a crash here
  # would abort the whole install the same way the guard above was just fixed to stop doing.
  python3 -c '
import json, sys
try:
    s = json.load(open(sys.argv[1])).get("mcpServers") or {}
except Exception:
    s = {}
for e in ("firefox", "webkit"):
    a = (s.get("playwright-" + e) or {}).get("args") or []
    pkg = next((x for x in a if x.startswith("@playwright/mcp")), "")
    if pkg:
        print(pkg, e)' "$1" 2>/dev/null | while read -r pkg engine; do
    log "playwright: downloading the $engine build the server launches"
    if ! command -v npx >/dev/null 2>&1 || ! npx -y -p "$pkg" playwright install "$engine" </dev/null; then
      log "  !! could not download $engine - run by hand: npx -y -p $pkg playwright install $engine"
    fi
  done
}

set_cursor_hooks() {
  # Fetch the CURSOR-contract hook scripts into .cursor/hooks/ and wire .cursor/hooks.json (schema v1).
  # Fetched from this repo's hooks/ (Cursor's beforeShellExecution etc. contract). Per-hook
  # fail-soft: a hook not yet upstream keeps any existing local copy.
  ensure_source || log "  !! no source clone - each hook keeps any existing copy"
  local root hooks_json hooks_dir ref_prefix node_exe entry file event cmd src pairs=()
  root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ "$SCOPE" = "project" ]; then
    [ -n "$root" ] || { log "  !! not in a git repo - skipping cursor hooks"; return 0; }
    hooks_json="$root/.cursor/hooks.json"; hooks_dir="$root/.cursor/hooks"; ref_prefix=".cursor/hooks/"
  else
    hooks_json="$HOME/.cursor/hooks.json"; hooks_dir="$HOME/.cursor/hooks"; ref_prefix="./hooks/"
  fi
  mkdir -p "$hooks_dir"
  command -v python3 >/dev/null || { log "  !! python3 not found - skipping cursor hooks.json"; return 0; }
  # Absolute node path dodges the stripped-PATH problem in spawned hook processes (cf. the statusline fix).
  node_exe="$(command -v node || echo node)"

  for entry in "${CURSOR_HOOKS[@]}"; do
    file="${entry%%::*}"; event="${entry##*::}"
    [ -n "$event" ] || continue
    src="$SOURCE_DIR/hooks/$file"
    if [ -n "$SOURCE_DIR" ] && [ -f "$src" ]; then
      # Content-compare-then-skip: only overwrite when the source bytes
      # differ, so an unchanged hook is left untouched (stable mtime, no noisy log).
      if [ -f "$hooks_dir/$file" ] && cmp -s "$src" "$hooks_dir/$file"; then log "  cursor hook current: $file"
      else cp "$src" "$hooks_dir/$file"; chmod +x "$hooks_dir/$file"; log "  cursor hook copied -> $file"; fi
    else
      [ -f "$hooks_dir/$file" ] || { log "  !! not in source and no local copy: $file - skipping"; continue; }
      log "  !! not in source (kept existing copy): $file"
    fi
    cmd="\"$node_exe\" \"$ref_prefix$file\""
    pairs+=("$event|$cmd")
  done

  # docs-session.js requires('./docs.js') from its own directory - the engine is copied beside it,
  # never itself wired to an event (same content-compare-then-skip as the loop above).
  case " ${CURSOR_HOOKS[*]} " in
    *" docs-session.js::"*)
      src="$SOURCE_DIR/hooks/docs.js"
      if [ -n "$SOURCE_DIR" ] && [ -f "$src" ]; then
        if [ -f "$hooks_dir/docs.js" ] && cmp -s "$src" "$hooks_dir/docs.js"; then log "  cursor hook current: docs.js"
        else cp "$src" "$hooks_dir/docs.js"; chmod +x "$hooks_dir/docs.js"; log "  cursor hook copied -> docs.js"; fi
      else
        [ -f "$hooks_dir/docs.js" ] || log "  !! not in source and no local copy: docs.js - skipping"
      fi
      ;;
  esac

  # memory-session.js requires('./memory.js') from its own directory - the engine is copied beside it,
  # never itself wired to an event (same content-compare-then-skip as the loop above and the docs.js copy).
  case " ${CURSOR_HOOKS[*]} " in
    *" memory-session.js::"*)
      src="$SOURCE_DIR/hooks/memory.js"
      if [ -n "$SOURCE_DIR" ] && [ -f "$src" ]; then
        if [ -f "$hooks_dir/memory.js" ] && cmp -s "$src" "$hooks_dir/memory.js"; then log "  cursor hook current: memory.js"
        else cp "$src" "$hooks_dir/memory.js"; chmod +x "$hooks_dir/memory.js"; log "  cursor hook copied -> memory.js"; fi
      else
        [ -f "$hooks_dir/memory.js" ] || log "  !! not in source and no local copy: memory.js - skipping"
      fi
      ;;
  esac

  local prog; prog=$(cat <<'PY'
import json, os, sys
path = sys.argv[1]
# Same refusal as mcp.json's own guard: a wrong-shape file must not be silently replaced with {}, and
# an array/string/number/boolean all parse but would otherwise throw on "version" not in data or the
# item-assignment right after it - isinstance is checked up front for one clear line instead.
if os.path.exists(path):
    try:
        data = json.load(open(path))
    except Exception as exc:
        print("  !! hooks.json is not valid JSON (%s) - left untouched; fix it and re-run" % exc)
        sys.exit(1)
    if not isinstance(data, dict):
        print("  !! hooks.json top level is not an object - left untouched")
        sys.exit(1)
else:
    data = {}
if "version" not in data:
    data["version"] = 1
hooks = data.setdefault("hooks", {})
changed = False
for line in sys.stdin.read().splitlines():
    if not line.strip():
        continue
    event, command = line.split("|", 1)
    arr = hooks.setdefault(event, [])
    if any(h.get("command") == command for h in arr):
        continue
    arr.append({"command": command}); changed = True
if changed:
    json.dump(data, open(path, "w"), indent=2); open(path, "a").write("\n")
    print("  cursor hooks.json -> " + path)
else:
    print("  cursor hooks.json: already wired - unchanged")
PY
)
  # Same tail as set_cursor_mcps' guard, for the same reason: without it a bad hooks.json aborts the
  # whole install under `set -euo pipefail` instead of leaving the file untouched and continuing.
  printf '%s\n' ${pairs[@]+"${pairs[@]}"} | python3 -c "$prog" "$hooks_json" || log "  !! hooks.json wiring failed - left untouched"
}

install_cursor_rules() {
  # Fetch .cursor/rules/*.mdc (soft convention guidance, auto-attached by glob) - e.g. the C# gate analog.
  # Per-rule fail-soft: a rule not yet upstream keeps any existing local copy.
  ensure_source || log "  !! no source clone - each rule keeps any existing copy"
  local root rules_dir entry file url tmp src
  root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ "$SCOPE" = "project" ]; then
    [ -n "$root" ] || { log "  !! not in a git repo - skipping cursor rules"; return 0; }
    rules_dir="$root/.cursor/rules"
  else
    rules_dir="$HOME/.cursor/rules"
  fi
  mkdir -p "$rules_dir"
  for file in ${RETIRED_RULES[@]+"${RETIRED_RULES[@]}"}; do
    [ -f "$rules_dir/$file" ] && { rm -f "$rules_dir/$file"; log "  cursor rule pruned (retired upstream): $file"; }
  done
  for entry in ${CURSOR_RULES[@]+"${CURSOR_RULES[@]}"}; do
    file="${entry%%|*}"                              # "name" -> the source clone; "name|url" -> that url
    if [ "$entry" != "$file" ]; then                 # third-party rule: the one shape still fetched
      url="${entry#*|}"; tmp="$(mktemp)"
      if command -v curl >/dev/null && curl -fsSL "$url" -o "$tmp"; then
        mv "$tmp" "$rules_dir/$file"; log "  cursor rule fetched -> $file"
      else
        rm -f "$tmp"
        [ -f "$rules_dir/$file" ] || { log "  !! fetch failed and no local copy: $file - skipping"; continue; }
        log "  !! fetch failed (kept existing copy): $file"
      fi
      continue
    fi
    src="$SOURCE_DIR/rules/$file"
    if [ -n "$SOURCE_DIR" ] && [ -f "$src" ]; then
      cp "$src" "$rules_dir/$file"; log "  cursor rule copied -> $file"
    else
      [ -f "$rules_dir/$file" ] || { log "  !! not in source and no local copy: $file - skipping"; continue; }
      log "  !! not in source (kept existing copy): $file"
    fi
  done
  stamp_docs_root_rule "$rules_dir"
}

# Bake the resolved generated-docs root into the copied baseline-docs-root.mdc. Cursor has no
# per-project environment store, so a session cannot look the value up - the stamp IS the
# contract. Runs on install AND update, so it tracks CURSOR_DOCS_PATH whenever that changes.
stamp_docs_root_rule() {
  local rules_dir="$1" rule="$1/baseline-docs-root.mdc" val
  [ -f "$rule" ] || return 0
  val="${CURSOR_DOCS_PATH:-.cursor/docs}"
  # A literal replacement, so a value holding regex metacharacters cannot corrupt the rule.
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$rule" "$val" <<'PY' || log "  !! docs-root stamp failed - the rule keeps its placeholder"
import sys
rule, val = sys.argv[1], sys.argv[2]
s = open(rule, encoding="utf-8").read()
open(rule, "w", encoding="utf-8").write(s.replace("__DOCS_ROOT__", val))
PY
    log "  docs root stamped -> $val"
  else
    log "  !! python3 not found - baseline-docs-root.mdc keeps its __DOCS_ROOT__ placeholder"
  fi
}

_migrate_docs_file() {  # $1 = old absolute path, $2 = new absolute path, $3 = label for the log line - ABSENT-ONLY: never overwrites an existing new file, never touches a missing old one (a plain rename/move, so content is unchanged)
  local old="$1" new="$2" label="$3"
  [ -f "$old" ] || return 0
  if [ -e "$new" ]; then
    log "  docs migration ($label): $new already exists - $old left in place, nothing overwritten"
    return 0
  fi
  mkdir -p "$(dirname "$new")"
  mv "$old" "$new"
  log "  docs migration ($label): ${old##*/} -> $new"
}

_enable_docs_domain() {  # $1 = domain folder, $2 = its capture doc, $3 = label - ABSENT-ONLY: when the doc exists and the folder holds no watch.json (nor a dangling link by that name), writes the minimal '{}' that makes the folder a domain the docs engine reads while declaring nothing - no source root, no watch entry, no notOwned; the capture fills in the real entries on its next run. Every exit is 0: under `set -euo pipefail` a failed test as the last statement would end the whole install.
  local dir="$1" doc="$2" label="$3"
  if [ ! -f "$dir/$doc" ] || [ -e "$dir/watch.json" ] || [ -L "$dir/watch.json" ]; then return 0; fi
  if { printf '{}\n' > "$dir/watch.json"; } 2>/dev/null; then
    log "  docs domain ($label): wrote an empty ${dir##*/}/watch.json - the docs engine now reads this folder; the next capture run fills in its entries"
  else
    log "  !! docs domain ($label): could not write $dir/watch.json - the docs engine will not read this folder until a capture writes one"
  fi
  return 0
}

migrate_docs_domains() {  # INSTALL + UPDATE: three absent-only moves onto the docs-domain layout - a file a capture used to write at the OLD path now writes at the NEW one, so an existing install's file is relocated once, byte-identical, and never overwrites a file already at the new path. Touches nothing else: related-context/ keeps every sibling-repo working paper - the capture's own drop-box for cross-repo plans, change requests, issue notes - exactly where it is; only the orientation doc this capture wrote moves out of it. Cursor has no per-project settings store, so the docs root here reads the SAME OS env var stamp_docs_root_rule stamps from - never a settings file.
  local root docs_root base
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || return 0
  docs_root="${CURSOR_DOCS_PATH:-.cursor/docs}"
  base="$root/${docs_root%/}"
  _migrate_docs_file "$base/PROJECT-CODE-STYLE.md" "$base/code-style/CODE-STYLE.md" "code style"
  _migrate_docs_file "$base/architecture/ASSESSMENT.md" "$base/quality/ASSESSMENT.md" "architecture quality"
  _migrate_docs_file "$base/related-context/PROJECT-RELATED-CONTEXT.md" "$base/related-projects/RELATED-PROJECTS.md" "related projects"
  # A moved folder is invisible to the docs engine until it holds a watch.json. Keyed on the doc sitting at its NEW
  # path, not on this run having moved it, so an install an earlier run migrated is switched on too. Only these two:
  # quality/ and related-context/ carry no watch.json BY DESIGN - one there would make either a domain silently.
  _enable_docs_domain "$base/code-style" "CODE-STYLE.md" "code style"
  _enable_docs_domain "$base/related-projects" "RELATED-PROJECTS.md" "related projects"
}

install_cursor_agents() {
  # Fetch each Cursor subagent .md into .cursor/agents/ (Cursor auto-discovers them - no settings wiring).
  # Content-compare-then-skip + per-agent fail-soft (a fetch
  # failure keeps any existing local copy). Scope follows SCOPE like the rules/skills: repo root for
  # project, $HOME for global.
  ensure_source || log "  !! no source clone - each agent keeps any existing copy"
  local root agents_dir file src
  root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ "$SCOPE" = "project" ]; then
    [ -n "$root" ] || { log "  !! not in a git repo - skipping cursor agents"; return 0; }
    agents_dir="$root/.cursor/agents"
  else
    agents_dir="$HOME/.cursor/agents"
  fi
  mkdir -p "$agents_dir"
  for file in ${RETIRED_AGENTS[@]+"${RETIRED_AGENTS[@]}"}; do
    [ -f "$agents_dir/$file" ] && { rm -f "$agents_dir/$file"; log "  cursor agent pruned (retired upstream): $file"; }
  done
  for file in ${CURSOR_AGENTS[@]+"${CURSOR_AGENTS[@]}"}; do
    src="$SOURCE_DIR/agents/$file"
    if [ -n "$SOURCE_DIR" ] && [ -f "$src" ]; then
      if [ -f "$agents_dir/$file" ] && cmp -s "$src" "$agents_dir/$file"; then log "  cursor agent current: $file"
      else cp "$src" "$agents_dir/$file"; log "  cursor agent copied -> $file"; fi
    else
      [ -f "$agents_dir/$file" ] || { log "  !! not in source and no local copy: $file - skipping"; continue; }
      log "  !! not in source (kept existing copy): $file"
    fi
  done
}

# ===========================================================================
# UPDATE - bring everything to latest
# ===========================================================================
remove_skills() {  # rm -rf each manifest skill under the scope dest, so update starts from a clean slate
  local dest entry name
  case "$SCOPE" in project) dest="$PWD/.cursor/skills" ;; *) dest="$CONFIG_DIR/skills" ;; esac
  log "skills [$SCOPE]: removing ${#SKILLS[@]} for clean reinstall"
  for entry in "${SKILLS[@]}"; do
    name="${entry#*|}"
    rm -rf "$dest/$name"
  done
}

update_skills() {
  # Fresh clone + copy - the same as install (the copy overwrites), just cleared first.
  remove_skills
  install_skills
}

prune_agents_cache() {
  # Legacy cleanup: an npx-skills-era install staged an agent-neutral .agents/ store. The git-copy
  # install_skills never creates one, so this is a no-op on a fresh install and only matters for a
  # project upgrading from the old flow. Guard: keep it if any skill entry under .cursor/skills is a
  # symlink (a symlinked tree still depends on .agents/; removing it would dangle).
  # BASE must match install_skills's dest: repo root for SCOPE=project, $HOME for global - otherwise
  # a global install leaves $HOME/.agents unpruned while we check the wrong (repo) base.
  local root d base
  root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ "$SCOPE" = "project" ]; then
    [ -n "$root" ] || return 0
    base="$root"
  else
    base="$HOME"
  fi
  [ -d "$base/.agents" ] || return 0
  local has_symlink=false
  for d in "$base/.cursor/skills"; do
    [ -d "$d" ] || continue
    if find "$d" -maxdepth 1 -type l 2>/dev/null | grep -q .; then has_symlink=true; break; fi
  done
  if $has_symlink; then
    log "  kept .agents/ - a skills tree has symlinks that still depend on it"
  else
    rm -rf "$base/.agents" && log "  pruned .agents/ (skills are real per-agent copies)"
  fi
}

# ===========================================================================
# DISPATCH
# ===========================================================================
# skills-only: run ONLY the skill step and exit, before any prerequisite check (testability -
# drives just the git-copy with no gh/other-tool dependency).
if [ "$SKILLS_ONLY" = true ]; then
  # No stamp here on purpose: this mode lands ONLY skills, so a stamp claiming the whole tree came
  # from this revision would be a lie - and a wrong stamp is worse than none.
  if [ "$ACTION" = "install" ]; then install_skills; else update_skills; fi
  exit 0
fi

prerequisites_check
install_github_cli

# install == update (clean re-add of skills, then refresh the .cursor tree).
if [ "$ACTION" = "install" ]; then install_skills; else update_skills; fi
set_cursor_mcps
set_cursor_hooks
install_cursor_rules
install_cursor_agents
migrate_docs_domains
write_stamp
log "plugins: Cursor plugins install from Cursor chat, not this script. Run '/add-plugin superpowers' in Cursor to add the superpowers workflow skills + hooks. Everything else is a Cursor native (Bugbot, AGENTS.md, Open-VSX LSP extensions); their skill / mcp / hook components are already provisioned here (+ .cursor/rules)."

prune_agents_cache
log "done: $ACTION ($SCOPE, agent=$AGENT). ${#SKILLS[@]} skills, MCPs, cursor-hooks=${#CURSOR_HOOKS[@]}, rules=${#CURSOR_RULES[@]}, agents=${#CURSOR_AGENTS[@]}."

# Reminder: stack-generated, machine-local artifacts that should NOT be committed.
cat <<'GITIGNORE'

Add these stack-generated, machine-local artifacts to the project's .gitignore (or .git/info/exclude):
  .serena          serena per-project state: registry, cache, language servers (SERENA_HOME=.serena/home)
  .cursor          Cursor stack: skills + mcp.json + hooks.json + hook scripts + rules + install stamp
  .slopwatch       dotnet-slopwatch output
  .playwright      playwright MCP user-data-dir + screenshots
  .memory-mcp      memory MCP db at the 'project' level only (global/scoped live under ~/.memory-mcp) - this run already wrote its own .gitignore inside that folder, so nothing further is needed there
GITIGNORE
