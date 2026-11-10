# logtap

A terminal UI to filter, search, group and copy the logs of a running command.

## Install

```sh
brew install akeuuh/tap/logtap
```

Requires Node (installed by Homebrew as a dependency).

## Usage

```sh
logtap -- yarn log-server
```

Every line is also appended, without colors, to `logtap-<date>.log` in the current directory.

| Key | Action |
|-----|--------|
| `f` | Keep only lines matching a regex (empty = all) |
| `/` | Search and highlight |
| `n` / `N` | Previous / next match |
| `Esc` | Clear the search |
| `m` | Open a named group, or close the open one |
| `c` | Copy the displayed lines (filter applied) |
| `y` | Copy the last group (open or closed) |
| `↑` `↓` `PgUp` `PgDn` `g` `G` | Scroll, `G` goes back to the bottom and follows |
| `q` | Quit |

Copying uses `pbcopy`, so it only works on macOS.

### Options

```sh
logtap -f 'error|warn' -- yarn log-server   # start with a filter
logtap -o server.log -- yarn log-server     # write the log to this file
```

The command is run without a shell. For pipes or redirections, wrap it in `sh -c`:

```sh
logtap -- sh -c 'yarn log-server 2>&1 | grep -v DEBUG'
```

### Extract a group

```sh
logtap extract logtap-2026-11-10T09-00-00-000Z.log login
```

Prints every group from the log file whose label contains `login`.
