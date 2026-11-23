import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseShellLine, planModeRefusal, shellLineWrites } from "./plan-mode-guard"

describe("shellLineWrites", () => {
  test("what a plan needs to look around is run", () => {
    for (const line of [
      "git log --oneline -1",
      "git status --short",
      "git diff HEAD~1 -- src/server/agent.ts",
      "git -C packages/app log -p -3",
      "git --no-pager show HEAD:README.md",
      "git branch -a",
      "git branch -vv",
      "git branch --show-current",
      "git branch --contains abc123",
      "git tag -l 'v1.*'",
      "git remote -v",
      "git stash list",
      "git config --get remote.origin.url",
      "cat README.md",
      "ls -la src | head -20",
      "cd packages/app && ls",
      "grep -rn \"TODO\" src | wc -l",
      "rg --files -g '*.ts' | sort | uniq -c",
      "find . -name '*.test.ts' -newer package.json",
      "cat package.json | jq '.scripts'",
      "ls nope 2>/dev/null || echo missing",
      "git log 2>&1 | tail -5",
      "wc -l < README.md",
      "echo \"$HOME\"",
      "gh pr view 42 --json title",
      "gh api repos/acme/app/pulls",
      "",
    ]) {
      expect([line, shellLineWrites(line)]).toEqual([line, null])
    }
  })

  test("what changes something, or could, is not", () => {
    for (const line of [
      // Plainly writes.
      "touch notes.txt",
      "rm -rf build",
      "mkdir out",
      "git commit -am wip",
      "git checkout main",
      "git push",
      "git branch feature",
      "git branch -D old",
      "git tag v2",
      "git tag -a v2 -m release",
      "git stash",
      "git config user.name me",
      "git remote add evil https://example.com/x.git",
      "npm install",
      // Runs a program the list cannot see into.
      "node -e \"require('fs').writeFileSync('x','')\"",
      "python3 -c 'open(\"x\",\"w\")'",
      "bash -c 'rm x'",
      "sh script.sh",
      "xargs rm",
      "env rm x",
      "awk 'BEGIN { system(\"rm x\") }'",
      "sed -i s/a/b/ file",
      "find . -name '*.log' -delete",
      "find . -exec rm {} +",
      "rg --pre ./evil pattern",
      "fd -x rm",
      "git -c core.pager=./evil log",
      "git -c core.fsmonitor=./evil status",
      "git log --output=stolen.txt",
      "git diff --ext-diff",
      // Reads, but sends what it read to a file.
      "cat secret > copy.txt",
      "echo hi >> notes.txt",
      "git log 2> errors.txt",
      "sort -o sorted.txt names.txt",
      "uniq names.txt deduped.txt",
      "tree -o listing.txt",
      // Hides a command inside one that reads.
      "echo $(rm x)",
      "echo `rm x`",
      "cat \"$(touch x)\"",
      "diff <(rm x) y",
      "(rm x)",
      "ls; rm x",
      "ls && rm x",
      "ls || rm x",
      "ls | tee copy.txt",
      "ls\nrm x",
      "ls & rm x",
      "FOO=1 rm x",
      "/bin/rm x",
      "gh pr merge 42",
      "gh api repos/acme/app/issues -f title=x",
      "gh api -X DELETE repos/acme/app",
    ]) {
      expect([line, typeof shellLineWrites(line)]).toEqual([line, "string"])
    }
  })

  test("quotes are read the way a shell reads them", () => {
    expect(parseShellLine("grep 'a; rm x' file")).toMatchObject({ ok: true, commands: [["grep", "a; rm x", "file"]] })
    expect(parseShellLine('grep "a | b > c" file')).toMatchObject({ ok: true, commands: [["grep", "a | b > c", "file"]] })
    expect(parseShellLine("ls -la | head -3 && git status")).toMatchObject({ ok: true, commands: [["ls", "-la"], ["head", "-3"], ["git", "status"]] })
    expect(parseShellLine("echo 'unclosed")).toEqual({ ok: false, reason: "it has an unclosed quote" })
    // A quoted name is still the name.
    expect(shellLineWrites("'rm' x")).toContain("rm")
    expect(shellLineWrites("\\rm x")).toContain("rm")
  })
})

describe("the guard and the shell agree on what the words are", () => {
  const refused = (line: string) => expect([line, shellLineWrites(line) !== null]).toEqual([line, true])
  const run = (line: string) => expect([line, shellLineWrites(line)]).toEqual([line, null])

  test("quoting the shell undoes cannot hide an option", () => {
    // ANSI-C quotes: bash and zsh read $'-exec' as -exec.
    refused("find . -maxdepth 0 $'-exec' touch /tmp/escape ;")
    refused("find . $'\\x2dexec' touch x ;")
    refused('find . $"-delete"')
    // Pieces joined by the shell are joined here too.
    refused("find . -ex'e'c touch x ';'")
    refused('find . -"de"lete')
    refused("find . -\\delete")
    refused("sort -'o' out.txt in.txt")
  })

  test("a variable could be anything, so it goes nowhere it could matter", () => {
    // Unset, this is `-delete`.
    refused("find . ${NOPE:--delete}")
    refused('find . "${NOPE:--delete}"')
    refused("find . -name x${IFS}-delete")
    refused("sort $OUT in.txt")
    refused('git log "$FORMAT"')
    refused("$CMD README.md")
    refused("${SHELL} -c ls")
    // zsh runs what is inside this.
    refused('echo "${(e):-\\$(touch x)}"')
    refused("echo $[1+1]")
    // Where no argument can make the command write, a variable is only text.
    run('echo "$HOME"')
    run("cat $HOME/.gitconfig")
    run('ls "$PWD/src"')
    run("grep -n \"foo$\" file.txt")
    run("grep -c 'a$' file.txt")
    run("echo cost: 5$")
  })

  test("the shell's own expansions are refused where they make new words", () => {
    refused("find . -{delete,delete}")
    refused("find . -del{ete,}")
    refused("sort -{o,}out in.txt")
    refused("ls {a,b}")
    // A bare pair of braces is itself.
    run("echo {}")
    run("jq '{name: .name}' package.json")
  })

  test("a wildcard cannot become an option, or a second file name", () => {
    // Two matches, and uniq writes the first to the second.
    refused("uniq *.md")
    refused("uniq notes/*.txt")
    // A file named --output=x.ts is one `*.ts` matches.
    refused("sort *.ts")
    refused("find * -name x")
    refused("git log -- *.md")
    refused("sort -[o]ut in.txt")
    refused("rg foo ?.ts")
    refused("*")
    // Behind a fixed beginning it can only be a path.
    run("sort ./*.ts")
    run("rg foo src/*.ts")
    run("find src/* -name x")
    run("git diff -- 'src/*.ts'")
    // And where no argument writes, it does not matter what it matches.
    run("ls *.ts")
    run("cat *.md | wc -l")
    run("wc -l src/*.ts")
    run("[ -f package.json ] && echo yes")
  })

  test("a long option shortened the way the tool allows is still that option", () => {
    refused("sort --out=/tmp/escape /etc/hosts")
    refused("sort --outp out.txt in.txt")
    refused("sort --compress-prog=sh in.txt")
    refused("date --se '2020-01-01'")
    refused("file --comp magic")
    refused("git branch --unset-up")
    refused("git branch --edit-desc")
    refused("git tag --del v1")
    refused("git log --ext-d")
    refused("git config --list --unset-al user.name")
    refused("gh api repos/acme/app --meth POST")
    // Options that only begin the same way are not caught up in it.
    run("sort --check in.txt")
    run("sort --reverse --unique in.txt")
    run("rg --pretty foo")
    run("git log --oneline -3")
    run("git branch --sort=-committerdate --format='%(refname:short)'")
    run("git branch --merged main --no-color")
    run("git branch --show-current")
    run("git config --get user.name")
    run("gh api repos/acme/app/pulls --include")
  })

  test("a redirection is to another descriptor or nowhere, and nothing more", () => {
    // The shell reads >&2file as a file named 2file.
    refused("echo x >&2file")
    refused("echo x > /dev/nullx")
    refused("echo x >&file")
    refused("echo x >| out.txt")
    run("echo x >&2")
    run("ls nope 2>/dev/null; echo done")
    run("git log 2>&1|tail -3")
  })

  test("the file an input redirection reads is not an argument", () => {
    // With a file named --list there, these are writes.
    refused("git config user.name evil < --list")
    refused("git config core.pager evil 0< --get")
    refused("git branch evil < --list")
    refused("uniq a b <c")
    expect(parseShellLine("sort < in.txt -r")).toMatchObject({ commands: [["sort", "-r"]] })
    expect(parseShellLine("wc -l 0<in.txt")).toMatchObject({ commands: [["wc", "-l"]] })
    run("wc -l < README.md")
    run("sort -r < in.txt | head -3")
    run("git config --list < /dev/null")
  })

  test("control characters are not smuggled in", () => {
    refused("ls\rfind . -delete")
    refused("ls \u0000")
    refused("ls \u001b[2K")
    run("ls\t-la\ngit status")
  })

  test("inside double quotes a backslash quotes only what the shell lets it", () => {
    expect(parseShellLine('grep "a\\.b" f')).toMatchObject({ commands: [["grep", "a\\.b", "f"]] })
    expect(parseShellLine('grep "a\\"b" f')).toMatchObject({ commands: [["grep", 'a"b', "f"]] })
    expect(parseShellLine('echo "\\$HOME"')).toMatchObject({ commands: [["echo", "$HOME"]], unknowns: [[null, null]] })
    expect(parseShellLine("ls *.ts src/*.ts $HOME '*.md'")).toMatchObject({
      unknowns: [[null, "wildcard-option", "wildcard", "variable", null]],
    })
  })
})

describe("against a real shell", () => {
  // Pieces of shell syntax, strung together at random. Whatever the guard
  // lets through with every word known is run through bash, which prints the
  // arguments it was actually given.
  const PIECES = ["a", "b c", "-x", "--out", "'q r'", '"d q"', "\\ ", "\\'", '\\"', "\\\\", "\\$", "$", "'$x'", '"\\$y"', '"a\\b"', '"a\\"b"',
    "{}", "=", "#", "%", "^", ",", ":", "@", "+", "]", "}", "!", "x#y", "''", '""', "\t", "  ", "'a'\"b\"c", "2", ">&2", "2>/dev/null", "<in"]
  /** A small seeded generator (mulberry32): the same lines every run, and all of the pieces get used. */
  function pick(seed: number) {
    let state = seed
    return (count: number) => {
      state = (state + 0x6d2b79f5) | 0
      let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
      mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
      return ((mixed ^ (mixed >>> 14)) >>> 0) % count
    }
  }

  test("the words the guard reads are the words bash passes", () => {
    const bash = Bun.which("bash")
    if (!bash) return
    const out = path.join(tmpdir(), `kanna-plan-guard-${process.pid}.args`)
    // Somewhere `<in` has a file to read.
    const cwd = mkdtempSync(path.join(tmpdir(), "kanna-plan-guard-"))
    writeFileSync(path.join(cwd, "in"), "")
    let compared = 0
    for (let seed = 1; seed <= 600; seed += 1) {
      const next = pick(seed)
      const rest = Array.from({ length: 1 + next(7) }, () => PIECES[next(PIECES.length)]!).join(next(3) === 0 ? "" : " ")
      const line = `record ${rest}`
      const parsed = parseShellLine(line)
      // Only what would be run as one plain command, with nothing left to the shell to fill in.
      if (!parsed.ok || parsed.commands.length !== 1 || parsed.commands[0]![0] !== "record" || parsed.unknowns[0]!.some((unknown) => unknown !== null)) continue
      // `record` writes its arguments to a file of its own, so a redirection in the line cannot hide them.
      rmSync(out, { force: true })
      // (A word of its own first: printf given no arguments prints as if given one empty one.)
      Bun.spawnSync([bash, "-c", `record() { printf '%s\\0' start "$@" > "$OUT"; }\n${line}`], { stdin: "ignore", stdout: "ignore", stderr: "ignore", cwd, env: { OUT: out, PATH: process.env.PATH ?? "" } })
      const passed = existsSync(out) ? readFileSync(out, "utf8").split("\0").slice(1, -1) : null
      // `<in` run together with what follows names a file that is not there: bash ran nothing, so there is nothing to compare.
      if (passed === null && line.includes("<in")) continue
      expect<unknown>([line, parsed.commands[0]!.slice(1)]).toEqual([line, passed])
      compared += 1
    }
    rmSync(out, { force: true })
    rmSync(cwd, { recursive: true, force: true })
    // Most generated lines are ones the guard accepts, or this proves little.
    expect(compared).toBeGreaterThan(200)
  })
})

describe("planModeRefusal", () => {
  const env = { CLAUDE_CONFIG_DIR: "/home/me/.claude" }

  test("a shell command that changes something is refused, and one that reads is not", () => {
    expect(planModeRefusal("Bash", { command: "rm -rf build" }, env)).toContain("plan mode")
    expect(planModeRefusal("Bash", { command: "touch notes.txt" }, env)).toContain("not on the list")
    expect(planModeRefusal("Monitor", { command: "npm run dev" }, env)).toContain("plan mode")
    expect(planModeRefusal("Bash", { command: "git log --oneline -1" }, env)).toBeNull()
    expect(planModeRefusal("Bash", { command: "cat README.md | head -5" }, env)).toBeNull()
  })

  test("a file is not written, except the plan itself", () => {
    expect(planModeRefusal("Write", { file_path: "/repo/src/index.ts", content: "x" }, env)).toContain("plan mode")
    expect(planModeRefusal("Edit", { file_path: "/repo/src/index.ts" }, env)).toContain("plan mode")
    expect(planModeRefusal("NotebookEdit", { notebook_path: "/repo/analysis.ipynb" }, env)).toContain("plan mode")
    expect(planModeRefusal("Write", { file_path: "/home/me/.claude/plans/tidy-otter.md" }, env)).toBeNull()
    expect(planModeRefusal("Write", { file_path: "/home/me/.claude/plans/../settings.json" }, env)).toContain("plan mode")
  })

  test("reading, searching, the web and Kanna's own tools are not this function's to stop", () => {
    expect(planModeRefusal("Read", { file_path: "/etc/hostname" }, env)).toBeNull()
    expect(planModeRefusal("WebFetch", { url: "https://example.com" }, env)).toBeNull()
    expect(planModeRefusal("mcp__kanna__read_chat", {}, env)).toBeNull()
    expect(planModeRefusal("ExitPlanMode", {}, env)).toBeNull()
  })
})
