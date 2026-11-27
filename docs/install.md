# Install and uninstall Keepgoing

Use a local checkout containing `package.json` and `extensions/keepgoing.ts`. The public `main` branch does not yet include the full extension, and there is no npm release. You need the `pi` CLI on your `PATH`.

## Install

From the checkout directory, run the install command, then check that Pi registered this checkout:

| Step | Linux / macOS | Windows PowerShell |
| --- | --- | --- |
| Install | `./install.sh` | `.\install.ps1` |
| Check installation | `./install.sh status` | `.\install.ps1 status` |

The scripts print the checkout version when installing or removing it. Keep the directory in place while installed: Pi loads the code from there.

In Pi, run `/reload`, then `/jb:keepgoing status` to verify the command is available. To enable automatic continuation for this session, run `/jb:keepgoing on`. No timezone setup is needed. Manual waits are durations; Claude Bridge supplies its reset zone, and `status` uses Pi’s local time. [Examples in different cities](commands.md#timezones-and-waits).

## Uninstall

From the same checkout and Pi home used for installation:

| Step | Linux / macOS | Windows PowerShell |
| --- | --- | --- |
| 1. Preview without changing anything | `./uninstall.sh --dry-run` | `.\uninstall.ps1 -DryRun` |
| 2. Remove the registration | `./uninstall.sh` | `.\uninstall.ps1` |
| 3. Verify it is no longer listed under `User packages:` | `pi list` | `pi list` |

Restart Pi or run `/reload` to unload the extension and cancel pending timers. Both `uninstall` wrappers and the installers’ `uninstall` action remove **only this checkout’s personal local-path registration**. They pass its absolute path to Pi, not the display label: personal relative paths are relative to that Pi home’s agent directory, not the directory you run the script from. A filtered local registration is eligible on the same terms. Both uninstall scripts require `node` on `PATH` for path validation.

Uninstall uses Pi’s `--no-approve` option so it does not load project-local settings from the caller’s directory. The checkout files, project declarations, other local paths, and Git/npm installations are left alone. An absent checkout is a no-op. If a managed source points here, a declaration and its resolved path disagree, the checkout path cannot be represented safely, or multiple personal entries point here, the script refuses removal in that home. A symlink or Windows junction to this directory counts as an alias, not proof of ownership. Even if the exact path is registered, the script leaves both registrations alone rather than removing just one. Unrelated missing declarations without an installed path are left alone; if the identity of a reported installation cannot be verified, removal stops. Inspect `pi list` before resolving such a conflict; `--all-homes` / `-AllHomes` checks each home independently.

### Existing installations and removal

If replacing an installation from a **different source**, inspect `pi list` and use Pi’s package management commands deliberately. For a personal local path, use its resolved absolute path; `(filtered)` is a display annotation. Removing a managed Git/npm package can delete its managed files. Restart Pi before enabling the new copy. Previous opt-in and pending timers do not carry over.

To remove the legacy **sleeppi** package from every discovered Pi home on Linux or macOS, preview with `./uninstall-sleeppi.sh`, then apply with `./uninstall-sleeppi.sh --apply`. It removes only personal (`User packages:`) sleeppi registrations; project packages, manual extensions, and keepgoing are left alone. Restart Pi afterwards.

## Optional checkout installers

By default the scripts use the active Pi home. To manage all discovered homes, unset `PI_CODING_AGENT_DIR` and preview first: `./install.sh --all-homes --dry-run` or `.\install.ps1 -AllHomes -DryRun`. Remove the dry-run flag to apply. The uninstall scripts accept the same flags.

## Platform requirements

- **Linux:** systemd/logind, `systemd-inhibit`, and `tail` with `--pid` support.
- **macOS:** the built-in `caffeinate` utility.
- **Windows:** `powershell.exe` for sleep protection. Native Windows testing is [still pending](manual-test-todo.md).
