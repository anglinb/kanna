/**
 * What a Claude session may do while it is in plan mode.
 *
 * Plan mode is read-only, and elsewhere Kanna leans on that (a chat in plan
 * mode can only start chats in plan mode: `ChatOrchestrator.resolveRun`). The
 * CLI on its own does not hold a session to it:
 *
 *  - A file write it asks about, and Kanna's `canUseTool` said yes to every
 *    ask, so `Write` created the file.
 *  - A shell command it does not ask about at all. It hands the command to a
 *    safety classifier, which answers whether the command is dangerous, not
 *    whether it changes anything: `touch notes.txt` and a `node -e` that
 *    writes a file both ran, with no callback of ours consulted.
 *
 * So the decision is made here, and it is made from a `PreToolUse` hook
 * (`startClaudeSession`), which the CLI runs before every tool call whatever
 * the permission mode.
 *
 * A shell command is let through only when it can be seen to read: every
 * command in it is on a list of ones that do, with none of the flags that
 * make them write or run something else, and no redirection to a file. That
 * is deliberately narrow. What it turns away the agent can usually do with
 * `Read`, `Grep` and `Glob`, and the refusal says so.
 */

import { homedir } from "node:os"
import path from "node:path"

type Verdict = string | null

const READ_ONLY = "read-only"

/**
 * What a word will be when the shell runs it, where that is not what is
 * written: a variable's value, or the file names a wildcard matches. For most
 * commands it does not matter what a word turns into; for the ones whose
 * arguments decide whether they write, it does (`shellLineWrites`).
 *
 *  - "variable": holds `$NAME`. It could be any text, an option included.
 *  - "wildcard-option": a wildcard with nothing fixed before it (`*.ts`), or
 *    behind a dash, so a file's name can come out as an option.
 *  - "wildcard": any other wildcard (`src/*.ts`). One word here, any number
 *    of words there.
 */
type Unknown = "variable" | "wildcard-option" | "wildcard" | null

/** Words of one command, and why the line could not be split into commands when it could not. */
type Parsed = { ok: true; commands: string[][]; unknowns: Unknown[][] } | { ok: false; reason: string }

const EXPANSION = "it uses a shell expansion that could turn into anything (${...}, $[...], $'...' or $\"...\")"

/**
 * Splits a shell line into its commands (at `|`, `&&`, `||`, `;` and line
 * breaks), reading quotes as bash and zsh do. Anything that would run a
 * command this cannot see, or send output to a file, ends the parse with the
 * reason. So does anything the shell would rewrite in a way this does not
 * follow exactly: the guard is only as good as its agreement with the shell
 * about what the words are.
 */
export function parseShellLine(line: string): Parsed {
  const commands: string[][] = []
  const unknowns: Unknown[][] = []
  let words: string[] = []
  let wordUnknowns: Unknown[] = []
  let word = ""
  let hasWord = false
  /** What was written before the word's first unquoted wildcard, when it has one. */
  let globPrefix: string | null = null
  let expands = false
  /** The next word is the file an input redirection reads, which the command is not given. */
  let readsFrom = false
  const endWord = () => {
    if (hasWord && readsFrom) {
      readsFrom = false
    } else if (hasWord) {
      words.push(word)
      // A lone `[` is the test command, not a wildcard.
      const glob = word === "[" ? null : globPrefix
      wordUnknowns.push(expands ? "variable" : glob === null ? null : glob === "" || glob.startsWith("-") ? "wildcard-option" : "wildcard")
    }
    word = ""
    hasWord = false
    globPrefix = null
    expands = false
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) {
      commands.push(words)
      unknowns.push(wordUnknowns)
    }
    words = []
    wordUnknowns = []
  }
  const fail = (reason: string): Parsed => ({ ok: false, reason })

  /**
   * A `$` at `index`. Null when it is only a dollar sign; a reason when the
   * line must be refused; otherwise it starts a variable, whose value this
   * cannot know. `quoted`: inside double quotes, where `$'` and `$"` are
   * plain text.
   */
  const dollar = (index: number, quoted: boolean): { fail: string } | { variable: boolean } => {
    const next = line[index + 1]
    if (next === "(") return { fail: "it runs another command inside it ($(...) or backticks)" }
    // `${X:--delete}` is `-delete` when X is unset, and zsh runs code from `${(e)...}`.
    if (next === "{" || next === "[") return { fail: EXPANSION }
    if (!quoted && (next === "'" || next === '"')) return { fail: EXPANSION }
    // A name, a positional or special parameter, or one of zsh's `$+x`, `$~x`, `$=x`, `$^x`.
    return { variable: next !== undefined && /[A-Za-z0-9_@*#?!$\-+~=^]/.test(next) }
  }

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    const next = line[index + 1]
    const code = char.charCodeAt(0)

    // Tab and line break are the shell's own. Any other control character is
    // one the shell and this would have to agree on, and nothing needs one.
    if ((code < 0x20 && char !== "\t" && char !== "\n") || code === 0x7f) return fail("it has a control character in it")

    if (char === "'") {
      const close = line.indexOf("'", index + 1)
      if (close === -1) return fail("it has an unclosed quote")
      word += line.slice(index + 1, close)
      hasWord = true
      index = close
      continue
    }
    if (char === '"') {
      let close = index + 1
      let text = ""
      for (; close < line.length && line[close] !== '"'; close += 1) {
        const inner = line[close]!
        if (inner === "`") return fail("it runs another command inside it ($(...) or backticks)")
        if (inner === "$") {
          const found = dollar(close, true)
          if ("fail" in found) return fail(found.fail)
          if (found.variable) expands = true
        }
        // Inside double quotes a backslash only quotes these; before anything else it is itself.
        if (inner === "\\" && close + 1 < line.length && '$`"\\\n'.includes(line[close + 1]!)) {
          close += 1
          if (line[close] !== "\n") text += line[close]
          continue
        }
        text += inner
      }
      if (close >= line.length) return fail("it has an unclosed quote")
      word += text
      hasWord = true
      index = close
      continue
    }
    if (char === "\\") {
      if (next === undefined || next === "\n") return fail("it continues onto another line")
      word += next
      hasWord = true
      index += 1
      continue
    }
    if (char === "`") return fail("it runs another command inside it ($(...) or backticks)")
    if (char === "#" && !hasWord) {
      // A comment, to the end of the line: the shell passes none of it on.
      while (index + 1 < line.length && line[index + 1] !== "\n") index += 1
      continue
    }
    if (char === "$") {
      const found = dollar(index, false)
      if ("fail" in found) return fail(found.fail)
      if (found.variable) expands = true
      word += char
      hasWord = true
      continue
    }
    if (char === "(" || char === ")") return fail("it uses a subshell")
    if (char === "{") {
      // `-{delete,x}` is two words to the shell. A bare `{}` is itself.
      if (next !== "}") return fail("it uses brace expansion ({a,b}), which the shell turns into several words")
      word += "{}"
      hasWord = true
      index += 1
      continue
    }
    if (char === "*" || char === "?" || char === "[") {
      if (globPrefix === null) globPrefix = word
      word += char
      hasWord = true
      continue
    }
    if (char === "\n" || char === ";") {
      endCommand()
      continue
    }
    if (char === "|") {
      endCommand()
      if (next === "|") index += 1
      continue
    }
    if (char === "&") {
      if (next === "&") {
        endCommand()
        index += 1
        continue
      }
      // `2>&1` is handled where the `>` is; a bare `&` runs in the background.
      return fail("it starts a background job (&)")
    }
    if (char === ">") {
      // The descriptor before it (`2>`) is part of the redirection, not an argument.
      if (hasWord && /^\d+$/.test(word)) {
        word = ""
        hasWord = false
        globPrefix = null
        expands = false
      } else {
        endWord()
      }
      let cursor = index + 1
      if (line[cursor] === ">") cursor += 1
      while (line[cursor] === " " || line[cursor] === "\t") cursor += 1
      // Another descriptor or /dev/null, and nothing more: `>&2file` is a file named "2file".
      const target = /^(&\d+|\/dev\/null)(?=$|[\s;|&)])/.exec(line.slice(cursor))
      if (!target) return fail("it writes its output to a file")
      index = cursor + target[0].length - 1
      continue
    }
    if (char === "<") {
      if (next === "(") return fail("it runs another command inside it (<(...))")
      // Input redirection reads. Like `>`, a descriptor before it belongs to
      // it; and the file name after it is the shell's, not an argument:
      // `git config a b < --list` is a write, whatever that file is called.
      if (hasWord && /^\d+$/.test(word)) {
        word = ""
        hasWord = false
        globPrefix = null
        expands = false
      } else {
        endWord()
      }
      readsFrom = true
      continue
    }
    if (char === " " || char === "\t") {
      endWord()
      continue
    }
    word += char
    hasWord = true
  }
  endCommand()
  return { ok: true, commands, unknowns }
}

/** A short option given alone or bundled with others: `-o`, `-no`. Not `--output`. */
function hasShortFlag(args: string[], letter: string) {
  return args.some((arg) => /^-[A-Za-z]+/.test(arg) && !arg.startsWith("--") && arg.slice(1).includes(letter))
}

/**
 * A long option, as GNU tools and git read them: spelled out, or any
 * beginning of it (`--out` is `--output`), with or without `=value`. A
 * beginning that two options share is refused by the tool itself, so taking
 * it for the one that writes costs nothing.
 */
function hasLongFlag(args: string[], ...names: string[]) {
  return args.some((arg) => {
    if (!arg.startsWith("--") || arg.length < 3) return false
    const given = arg.split("=", 1)[0]!
    return names.some((name) => name.startsWith(given))
  })
}

const anyArguments = (): Verdict => null

const GIT_READ_SUBCOMMANDS = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "blame", "describe", "shortlog",
  "cat-file", "grep", "merge-base", "rev-list", "show-ref", "name-rev", "for-each-ref", "count-objects",
  "whatchanged", "diff-tree", "diff-index", "diff-files", "check-ignore", "check-attr", "var", "version", "help",
])

/**
 * `git branch` and `git tag` list unless they are given a name to make, or a
 * flag that changes one. `changingShortFlags` is per command: `-a` lists every
 * branch, and makes an annotated tag.
 */
function listingOnly(args: string[], changingShortFlags: string, what: string): Verdict {
  // The switches that put the command in list mode, where a bare word is a pattern or a commit.
  const listMode = ["--list", "-l", "--merged", "--no-merged", "--contains", "--no-contains", "--points-at"]
  const positional = args.filter((arg) => !arg.startsWith("-"))
  if (positional.length > 0 && !args.some((arg) => listMode.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))) {
    return `git ${what} with a name creates or changes one`
  }
  if ([...changingShortFlags].some((letter) => hasShortFlag(args, letter))
    || hasLongFlag(args, "--delete", "--move", "--copy", "--force", "--set-upstream-to", "--set-upstream", "--unset-upstream",
      "--edit-description", "--annotate", "--sign", "--local-user", "--message", "--file", "--edit", "--track", "--no-track",
      "--create-reflog", "--cleanup")) {
    return `that git ${what} command changes a ${what}`
  }
  return null
}

function checkGit(args: string[]): Verdict {
  let index = 0
  for (; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === "-C" || arg === "--git-dir" || arg === "--work-tree" || arg === "--namespace") {
      index += 1
      continue
    }
    if (arg === "--no-pager" || arg === "-P" || arg === "--no-optional-locks" || arg === "--literal-pathspecs"
      || arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) continue
    // `-c name=value` can name a program for git to run (a pager, a diff driver).
    if (arg === "-c" || arg.startsWith("--config-env") || arg.startsWith("--exec-path") || arg === "-p" || arg === "--paginate") {
      return "that git option can make git run another program"
    }
    break
  }
  const subcommand = args[index]
  const rest = args.slice(index + 1)
  if (!subcommand) return null
  if (hasLongFlag(rest, "--output", "--ext-diff", "--open-files-in-pager") || rest.some((arg) => arg.startsWith("--output") || /^-O/.test(arg))) {
    return "that git option writes a file or runs another program"
  }
  if (GIT_READ_SUBCOMMANDS.has(subcommand)) return null
  switch (subcommand) {
    case "branch":
      return listingOnly(rest, "dDmMcCfut", "branch")
    case "tag":
      return listingOnly(rest, "asdfmFue", "tag")
    case "remote":
      return rest.length === 0 || rest[0] === "-v" || rest[0] === "--verbose" || rest[0] === "show" || rest[0] === "get-url"
        ? null
        : "that git remote command changes the remotes"
    case "stash":
      return rest[0] === "list" || rest[0] === "show" ? null : "git stash changes the working tree"
    case "config":
      return (hasLongFlag(rest, "--get", "--get-all", "--get-regexp", "--list") || rest.includes("-l"))
        && !hasLongFlag(rest, "--add", "--unset", "--unset-all", "--replace-all", "--rename-section", "--remove-section", "--edit")
        && !rest.includes("-e")
        ? null
        : "git config without --get or --list can change the configuration"
    case "worktree":
      return rest[0] === "list" ? null : "that git worktree command changes worktrees"
    case "reflog":
      return rest.length === 0 || rest[0] === "show" || rest[0]!.startsWith("-") ? null : "that git reflog command changes the reflog"
    default:
      return `git ${subcommand} is not a command that only reads`
  }
}

const GH_READ: Record<string, Set<string>> = {
  pr: new Set(["view", "list", "diff", "checks", "status"]),
  issue: new Set(["view", "list", "status"]),
  repo: new Set(["view", "list"]),
  run: new Set(["view", "list"]),
  release: new Set(["view", "list"]),
  workflow: new Set(["view", "list"]),
  auth: new Set(["status"]),
  label: new Set(["list"]),
}

function checkGh(args: string[]): Verdict {
  const [group, action] = args
  if (!group) return null
  if (group === "status" || group === "search" || group === "--version" || group === "help") return null
  if (group === "api") {
    return hasLongFlag(args, "--method", "--field", "--raw-field", "--input") || hasShortFlag(args, "X") || hasShortFlag(args, "f") || hasShortFlag(args, "F")
      ? "that gh api call sends data (it is not a plain GET)"
      : null
  }
  return GH_READ[group]?.has(action ?? "") ? null : `gh ${group}${action ? ` ${action}` : ""} is not a command that only reads`
}

/**
 * The commands a plan may run, each with the check that keeps it to reading.
 * Left out on purpose: anything that takes a program to run (`xargs`, `env`,
 * `awk`, `sed`, `sh`, an interpreter), and anything that fetches or builds.
 */
const READ_COMMANDS: Record<string, (args: string[]) => Verdict> = {
  ls: anyArguments, cat: anyArguments, head: anyArguments, tail: anyArguments, wc: anyArguments, pwd: anyArguments,
  echo: anyArguments, printf: anyArguments, grep: anyArguments, egrep: anyArguments, fgrep: anyArguments,
  stat: anyArguments, du: anyArguments, df: anyArguments, whoami: anyArguments, uname: anyArguments,
  which: anyArguments, type: anyArguments, basename: anyArguments, dirname: anyArguments, realpath: anyArguments,
  readlink: anyArguments, cut: anyArguments, tr: anyArguments, nl: anyArguments, column: anyArguments,
  diff: anyArguments, cmp: anyArguments, md5sum: anyArguments, sha1sum: anyArguments, sha256sum: anyArguments,
  shasum: anyArguments, jq: anyArguments, true: anyArguments, false: anyArguments, test: anyArguments,
  "[": anyArguments, id: anyArguments, ps: anyArguments, nproc: anyArguments, uptime: anyArguments, cd: anyArguments,
  hostname: (args) => args.every((arg) => arg.startsWith("-")) ? null : "hostname with a name sets the host name",
  date: (args) => hasShortFlag(args, "s") || hasLongFlag(args, "--set") ? "that date command sets the clock" : null,
  file: (args) => hasShortFlag(args, "C") || hasLongFlag(args, "--compile") ? "file -C writes a compiled magic file" : null,
  sort: (args) => hasShortFlag(args, "o") || hasLongFlag(args, "--output", "--compress-program") ? "that sort writes a file or runs another program" : null,
  uniq: (args) => args.filter((arg) => !arg.startsWith("-")).length > 1 ? "uniq with a second file name writes to it" : null,
  tree: (args) => hasShortFlag(args, "o") ? "tree -o writes a file" : null,
  find: (args) => args.some((arg) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(arg))
    ? "that find runs a command or deletes or writes files"
    : null,
  rg: (args) => hasLongFlag(args, "--pre", "--hostname-bin") ? "that rg option runs another program" : null,
  fd: (args) => hasShortFlag(args, "x") || hasShortFlag(args, "X") || hasLongFlag(args, "--exec", "--exec-batch") ? "that fd runs a command" : null,
  git: checkGit,
  gh: checkGh,
}

/**
 * Why a shell line cannot be run in plan mode, or null when everything in it
 * only reads.
 */
export function shellLineWrites(line: string): Verdict {
  const parsed = parseShellLine(line)
  if (!parsed.ok) return parsed.reason
  for (const [index, words] of parsed.commands.entries()) {
    const [name, ...args] = words
    const [nameUnknown, ...argUnknowns] = parsed.unknowns[index]!
    if (!name) continue
    if (nameUnknown) return "the command's own name is a variable or a wildcard"
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(name)) return "it sets a variable for a command"
    const check = Object.hasOwn(READ_COMMANDS, name) ? READ_COMMANDS[name]! : null
    if (!check) return `\`${name.slice(0, 40)}\` is not on the list of commands that only read`
    // The check reads the arguments as written. Where it is the arguments
    // that decide, each has to be what the shell will pass.
    if (check !== anyArguments) {
      if (argUnknowns.includes("variable")) return `it gives \`${name}\` a variable ($...), whose value could be an option that writes`
      if (argUnknowns.includes("wildcard-option")) {
        return `it gives \`${name}\` a wildcard that a file's name could turn into an option; start it with ./ (as in ./*.ts)`
      }
      // `uniq a b` writes to b, and one wildcard can be both.
      if (name === "uniq" && argUnknowns.includes("wildcard")) return "uniq with a wildcard may be given a second file name, which it writes to"
    }
    const verdict = check(args)
    if (verdict) return verdict
  }
  return null
}

/** Tools that change files. */
const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"])
/** Tools that are given a shell line to run. */
const SHELL_TOOLS = new Set(["Bash", "Monitor"])

/**
 * Why a Claude tool call is refused in plan mode, or null when it may run.
 * The one file a plan writes is its own, which the CLI keeps under its
 * config directory.
 */
export function planModeRefusal(toolName: string, input: unknown, env: Record<string, string | undefined> = process.env): string | null {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {}
  if (SHELL_TOOLS.has(toolName)) {
    const reason = shellLineWrites(typeof record.command === "string" ? record.command : "")
    if (!reason) return null
    return `This chat is in plan mode, which is ${READ_ONLY}, and this command was not run: ${reason}. `
      + "Commands that only read are run (ls, cat, head, tail, grep, rg, find, wc, git status/log/diff/show/blame, gh pr view), one after another or piped, with no output sent to a file. "
      + "For anything else use Read, Grep and Glob, or finish the plan and call ExitPlanMode to have it approved."
  }
  if (!FILE_WRITE_TOOLS.has(toolName)) return null
  const target = typeof record.file_path === "string" ? record.file_path : typeof record.notebook_path === "string" ? record.notebook_path : ""
  const plansDir = path.join(env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), ".claude"), "plans")
  if (target && path.resolve(target).startsWith(`${plansDir}${path.sep}`)) return null
  return `This chat is in plan mode, which is ${READ_ONLY}: files are not written until the plan is approved. Call ExitPlanMode with the plan.`
}
