import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { FileError, type FileErrorCode, type FileInfo, type LineScan } from "@earendil-works/pi-durable/env";
import { createSystemSshRunner, type SshProfile, type SshRunner } from "./index.ts";
import { MAX_FILE_BYTES, MAX_READERS, READER_TTL_MS, ReaderRegistry, agentDefinitionRoots, asFileError, contentOf, fileFailure, readerMethod, relativePath, resolveWorkspacePath, tempName, within, type ExecutionHost, type ExecutionHostIdentity, type FileRequest, type FilesystemServer, type GatewayReader, type ResourceRoot } from "./filesystem.ts";
import { workspaceOwner, type WorkspaceRegistry } from "./workspaces.ts";

/** One remote filesystem request may run this long before the session drops it with an unknown outcome. */
export const SSH_FILE_TIMEOUT_MS = 60_000;
/**
 * Bytes of one base64 chunk sent to the remote writer. A chunk travels as one request frame, and the frame bound
 * (`MAX_REQUEST_BYTES`) is what a chunk has to fit under, so a write of the maximum size costs at most
 * `MAX_FILE_BYTES / WRITE_CHUNK_BYTES` frames.
 */
const WRITE_CHUNK_BYTES = 32 * 1024;

/**
 * The remote helper: a self-contained Python 3 program that serves one framed request at a time over its standard
 * streams, one session per (profile, root). It runs over the runner's interactive transport (`SshRunner.open`), so the
 * host needs Python 3 and nothing else installed, and every path it touches is confined to the profile's remote root.
 * The program text and the interpreter start are paid once per session instead of once per operation.
 *
 * Its gitignore matching — the `Ignore`, `IgnoreRule` and `RuleManager` classes, the `REPLACERS` chain that
 * compiles a pattern into a regular expression, the trailing-wildcard handling, the rule ordering with negations and
 * the parent-directory traversal — is a Python port of `node-ignore` 7.0.5
 * (https://github.com/kaelzhang/node-ignore), MIT, Copyright (c) 2013 Kael Zhang and contributors, whose license is
 * kept verbatim in `node-ignore.LICENSE` beside this file. The port is not installed on the host and adds no
 * dependency: the host has Python 3, not npm. It exists so the helper and the loader read one grammar, and
 * `test/ignore-parity.test.ts` requires every decision the two engines make over a generated corpus to agree.
 */
export const REMOTE_FILESYSTEM_SCRIPT = "import base64, codecs, errno, fnmatch, json, os, re, shutil, stat, struct, sys, tempfile\n\nMAX = 16 * 1024 * 1024\nMAX_SNAPSHOT = 16 * 1024 * 1024\nMAX_SNAPSHOT_ENTRIES = 20000\nMAX_FRONTMATTER = 256 * 1024\n# One session request and its answer travel as frames. The request bound is the gateway's own JSON body bound; the\n# answer bound sits above the largest answer an operation can legitimately produce (base64 of MAX, and the snapshot\n# envelope MAX_SNAPSHOT already caps). A frame above either bound ends the session instead of being resynchronised.\nMAX_FRAME = 64 * 1024 * 1024\nMAX_REQUEST = 1024 * 1024\nREQUEST = 10\nRESULT = 11\nCLOSE = 12\nIGNORE_NAMES = (\".gitignore\", \".ignore\", \".fdignore\")\nUNRESOLVABLE = (\"not_found\", \"not_directory\", \"permission_denied\", \"invalid\")\n\n\nclass Done(Exception):\n    \"\"\"One request's answer. Raising unwinds out of the operation, exactly as the one-shot exit did, so a refusal deep\n    inside an operation ends that request and only that request.\"\"\"\n\n    def __init__(self, payload):\n        self.payload = payload\n\n\ndef emit(value):\n    raise Done(value)\n\n\ndef fail(code, message, path=None):\n    error = {\"code\": code, \"message\": message}\n    if path is not None:\n        error[\"path\"] = path\n    emit({\"ok\": False, \"error\": error})\n\n\ndef code_of(error):\n    if isinstance(error, FileNotFoundError):\n        return \"not_found\"\n    if isinstance(error, PermissionError):\n        return \"permission_denied\"\n    if isinstance(error, NotADirectoryError):\n        return \"not_directory\"\n    if isinstance(error, IsADirectoryError):\n        return \"is_directory\"\n    if isinstance(error, OSError) and error.errno in (errno.EINVAL, errno.ELOOP, errno.ENXIO):\n        return \"invalid\"\n    return \"unknown\"\n\n\ndef lexical_within(candidate, path):\n    if path == candidate:\n        return True\n    return path.startswith(candidate.rstrip(os.sep) + os.sep)\n\n\ndef confine_read(path):\n    for candidate in [root] + ALLOWED_ROOTS:\n        if lexical_within(candidate, path):\n            if real_within(candidate, path) is None:\n                fail(\"permission_denied\", \"symlink outside \" + candidate)\n            return\n    if path in ALLOWED_FILES and os.path.realpath(path) in ALLOWED_FILES:\n        return\n    fail(\"permission_denied\", \"path outside workspace\")\n\n\ndef account_of():\n    try:\n        import pwd\n        entry = pwd.getpwuid(os.getuid())\n        name = entry.pw_name\n        home = entry.pw_dir\n    except Exception as error:\n        fail(\"unknown\", \"the remote host did not report the execution account: \" + str(error))\n    if not name or not home:\n        fail(\"unknown\", \"the remote host reported an incomplete execution account\")\n    return name, home\n\n\ndef real_dir(path):\n    try:\n        real = os.path.realpath(path)\n    except OSError:\n        return None\n    return real if os.path.isdir(real) else None\n\n\ndef real_file(path):\n    try:\n        real = os.path.realpath(path)\n    except OSError:\n        return None\n    return real if os.path.isfile(real) else None\n\n\nCONTEXT_NAMES = (\"AGENTS.override.md\", \"AGENTS.md\", \"AGENTS.MD\", \"CLAUDE.md\", \"CLAUDE.MD\")\n\n\ndef context_file(directory):\n    for name in CONTEXT_NAMES:\n        found = real_file(os.path.join(directory, name))\n        if found:\n            return found\n    return None\n\n\ndef context_files(workspace, agent_dir):\n    found = []\n    seen = set()\n    first = context_file(agent_dir)\n    if first:\n        seen.add(first)\n        found.append(first)\n    chain = []\n    directory = workspace\n    while True:\n        current = context_file(directory)\n        if current and current not in seen:\n            chain.insert(0, current)\n        parent = os.path.dirname(directory)\n        if parent == directory:\n            break\n        directory = parent\n    for path in chain:\n        if path not in seen:\n            seen.add(path)\n            found.append(path)\n    return found\n\n\ndef find_git_paths(start):\n    directory = os.path.realpath(start)\n    while True:\n        git_path = os.path.join(directory, '.git')\n        if os.path.exists(git_path):\n            try:\n                if os.path.isfile(git_path):\n                    with open(git_path, 'r', encoding='utf-8', errors='replace') as handle:\n                        content = handle.read().strip()\n                    if content.startswith('gitdir: '):\n                        git_dir = os.path.realpath(os.path.join(directory, content[8:].strip()))\n                        if not os.path.exists(os.path.join(git_dir, 'HEAD')):\n                            return None\n                        common_path = os.path.join(git_dir, 'commondir')\n                        if os.path.exists(common_path):\n                            with open(common_path, 'r', encoding='utf-8', errors='replace') as handle:\n                                common_git_dir = os.path.realpath(os.path.join(git_dir, handle.read().strip()))\n                        else:\n                            common_git_dir = git_dir\n                        return {'repoDir': directory, 'commonGitDir': common_git_dir}\n                if os.path.isdir(git_path):\n                    if not os.path.exists(os.path.join(git_path, 'HEAD')):\n                        return None\n                    return {'repoDir': directory, 'commonGitDir': git_path}\n            except OSError:\n                return None\n        parent = os.path.dirname(directory)\n        if parent == directory:\n            return None\n        directory = parent\n\n\ndef find_shadowed_context_file(workspace):\n    paths = find_git_paths(workspace)\n    if paths is None:\n        return None\n    common_git_dir = os.path.realpath(paths['commonGitDir'])\n    worktree_root = os.path.realpath(paths['repoDir'])\n    main_repo_root = os.path.dirname(common_git_dir)\n    if not worktree_root.startswith(main_repo_root + os.sep):\n        return None\n    if os.path.realpath(os.path.join(main_repo_root, '.git')) != common_git_dir:\n        return None\n    own = context_file(worktree_root)\n    if own is None:\n        return None\n    return os.path.realpath(os.path.join(main_repo_root, os.path.basename(own)))\n\ndef repository_root(start):\n    directory = start\n    while True:\n        if os.path.lexists(os.path.join(directory, \".git\")):\n            return directory\n        parent = os.path.dirname(directory)\n        if parent == directory:\n            return None\n        directory = parent\n\n\ndef resource_roots(workspace, home, agent_dir):\n    roots = []\n    seen = set()\n\n    def add(path, scope, kind, trusted=False):\n        real = real_dir(path)\n        if real is None or real in seen:\n            return\n        seen.add(real)\n        root = {\"scope\": scope, \"kind\": kind, \"path\": real}\n        if trusted:\n            root[\"requiresTrust\"] = True\n        roots.append(root)\n\n    stop = repository_root(workspace)\n    account_agents = os.path.realpath(os.path.join(home, \".agents\", \"skills\"))\n    add(os.path.join(workspace, \".pi\", \"skills\"), \"project\", \"skills\", True)\n    add(os.path.join(workspace, \".agents\", \"skills\"), \"project\", \"skills\")\n    directory = workspace\n    while True:\n        if os.path.realpath(os.path.join(directory, \".agents\", \"skills\")) != account_agents:\n            add(os.path.join(directory, \".agents\", \"skills\"), \"ancestor\", \"skills\")\n        if stop is not None and directory == stop:\n            break\n        parent = os.path.dirname(directory)\n        if parent == directory:\n            break\n        directory = parent\n    add(os.path.join(agent_dir, \"skills\"), \"global\", \"skills\")\n    add(os.path.join(home, \".agents\", \"skills\"), \"global\", \"skills\")\n    add(os.path.join(workspace, \".pi\", \"prompts\"), \"project\", \"prompts\", True)\n    add(os.path.join(agent_dir, \"prompts\"), \"global\", \"prompts\")\n    return roots\n\n\ndef prompt_files(workspace, agent_dir, name):\n    files = []\n    global_file = real_file(os.path.join(agent_dir, name))\n    if global_file:\n        files.append({\"scope\": \"global\", \"path\": global_file})\n    project_file = real_file(os.path.join(workspace, \".pi\", name))\n    if project_file:\n        files.append({\"scope\": \"project\", \"path\": project_file})\n    return files\n\n\ndef discovery():\n    name, raw_home = account_of()\n    home = os.path.realpath(raw_home)\n    agent_dir = os.path.join(home, '.pi', 'agent')\n    result = {\n        'user': name,\n        'home': home,\n        'workspaceRoot': root,\n        'agentDir': agent_dir,\n        'roots': resource_roots(root, home, agent_dir),\n        'contextFiles': context_files(root, agent_dir),\n        'systemPromptFiles': prompt_files(root, agent_dir, 'SYSTEM.md'),\n        'appendSystemPromptFiles': prompt_files(root, agent_dir, 'APPEND_SYSTEM.md'),\n    }\n    shadowed = find_shadowed_context_file(root)\n    if shadowed is not None:\n        result['shadowedContextFile'] = shadowed\n    return result\n\ndef real_within(root, path):\n    real = os.path.realpath(path)\n    if real == root or real.startswith(root + os.sep):\n        return real\n    return None\n\n\ndef writable_within(path):\n    for entry in ALLOWED_WRITES:\n        candidate = entry.get(\"path\")\n        boundary = entry.get(\"boundary\")\n        if candidate is None or boundary is None or not lexical_within(candidate, path):\n            continue\n        head = path\n        while True:\n            if os.path.lexists(head):\n                real = os.path.realpath(head)\n                if not lexical_within(boundary, real):\n                    return False\n                if lexical_within(candidate, head) and not lexical_within(candidate, real):\n                    return False\n                return True\n            parent = os.path.dirname(head)\n            if parent == head:\n                return False\n            head = parent\n    return False\n\n\ndef confine(root, path):\n    if writable_within(path):\n        return\n    if os.path.lexists(path):\n        if real_within(root, path) is None:\n            fail(\"permission_denied\", \"path outside workspace\")\n        return\n    head = os.path.dirname(path)\n    while True:\n        if os.path.lexists(head):\n            if real_within(root, head) is None:\n                fail(\"permission_denied\", \"path outside workspace\")\n            return\n        parent = os.path.dirname(head)\n        if parent == head:\n            fail(\"permission_denied\", \"path outside workspace\")\n        head = parent\n\n\ndef kind_of(mode):\n    if stat.S_ISREG(mode):\n        return \"file\"\n    if stat.S_ISDIR(mode):\n        return \"directory\"\n    if stat.S_ISLNK(mode):\n        return \"symlink\"\n    return \"other\"\n\n\ndef info_of(path, st):\n    return {\n        \"name\": os.path.basename(path),\n        \"path\": path,\n        \"kind\": kind_of(st.st_mode),\n        \"size\": st.st_size,\n        \"mtimeMs\": st.st_mtime * 1000.0,\n    }\n\n\ndef regular(path):\n    \"\"\"The gateway's own read bound, in the gateway's own words: a read checks this itself, so no separate size\n    pre-check has to run before it and no caller sees a different refusal than it did.\"\"\"\n    st = os.stat(path)\n    kind = kind_of(st.st_mode)\n    if kind == \"directory\":\n        fail(\"is_directory\", \"Not a regular file\", path)\n    if kind != \"file\":\n        fail(\"invalid\", \"Not a regular file\", path)\n    if st.st_size > MAX:\n        fail(\"invalid\", \"file is \" + str(st.st_size) + \" bytes; the gateway limit is \" + str(MAX) + \" bytes\", path)\n    return st\n\n\ndef identity(path, dev, ino):\n    confine_read(path)\n    try:\n        fd = os.open(path, os.O_RDONLY)\n    except OSError as error:\n        fail(code_of(error), str(error))\n    st = os.fstat(fd)\n    if st.st_dev != dev or st.st_ino != ino:\n        os.close(fd)\n        fail(\"invalid\", \"file changed since the reader was opened\")\n    return fd\n\n\ndef decoder():\n    return codecs.getincrementaldecoder(\"utf-8\")(errors=\"replace\")\n\n\ndef decoded_bytes(text):\n    return len(text.encode(\"utf-8\"))\n\n\nclass Scanner:\n    def __init__(self, start_line, end_line):\n        self.start_line = start_line\n        self.end_line = end_line\n        self.position = 0\n        self.newlines = 0\n        self.line_start = 0\n        self.start = None\n        self.end = None\n        self.first_line_end = None\n        self.last_line_start = None\n        self.selected_bytes = 0\n        self.first_line_bytes = 0\n        self.selection = None\n        self.first_line = None\n        self.head = bytearray()\n        self.bom = False\n        if start_line == 0:\n            self.begin(0)\n\n    def push(self, chunk):\n        if self.head is not None:\n            take = min(3 - len(self.head), len(chunk))\n            self.head += chunk[:take]\n            if len(self.head) < 3:\n                return\n            head = bytes(self.head)\n            self.head = None\n            self.bom = head[:3] == b\"\\xef\\xbb\\xbf\"\n            self.process(head)\n            chunk = chunk[take:]\n        self.process(chunk)\n\n    def process(self, chunk):\n        base = self.position\n        start = 0\n        index = chunk.find(b\"\\n\")\n        while index != -1:\n            self.feed(chunk, base, start, index)\n            position = base + index\n            if self.newlines == self.start_line:\n                self.end_first_line(position)\n            if self.newlines == self.end_line - 1:\n                self.end_selection(position)\n            self.feed(chunk, base, index, index + 1)\n            start = index + 1\n            self.newlines += 1\n            self.line_start = position + 1\n            if self.newlines == self.start_line:\n                self.begin(self.line_start)\n            if self.newlines == self.end_line - 1:\n                self.last_line_start = self.line_start\n            index = chunk.find(b\"\\n\", index + 1)\n        self.feed(chunk, base, start, len(chunk))\n        self.position += len(chunk)\n\n    def feed(self, chunk, base, start, end):\n        if self.bom and base + start < 3:\n            start = min(end, 3 - base)\n        if end <= start:\n            return\n        data = chunk[start:end]\n        if self.selection is not None:\n            self.selected_bytes += decoded_bytes(self.selection.decode(data))\n        if self.first_line is not None:\n            self.first_line_bytes += decoded_bytes(self.first_line.decode(data))\n\n    def begin(self, start):\n        self.start = start\n        if self.start_line == self.end_line - 1:\n            self.last_line_start = start\n        self.selection = decoder()\n        self.first_line = decoder()\n\n    def end_first_line(self, position):\n        self.first_line_end = position\n        if self.first_line is not None:\n            self.first_line_bytes += decoded_bytes(self.first_line.decode(b\"\", True))\n        self.first_line = None\n\n    def end_selection(self, position):\n        self.end = position\n        if self.selection is not None:\n            self.selected_bytes += decoded_bytes(self.selection.decode(b\"\", True))\n        self.selection = None\n\n    def finish(self):\n        if self.head is not None:\n            head = bytes(self.head)\n            self.head = None\n            self.bom = head[:3] == b\"\\xef\\xbb\\xbf\"\n            self.process(head)\n        size = self.position\n        if self.start is None:\n            return {\n                \"newlines\": self.newlines,\n                \"start\": size,\n                \"end\": size,\n                \"firstLineEnd\": size,\n                \"lastLineStart\": size,\n                \"selectedBytes\": 0,\n                \"firstLineBytes\": 0,\n            }\n        if self.first_line_end is None:\n            self.end_first_line(size)\n        if self.end is None:\n            self.end_selection(size)\n        return {\n            \"newlines\": self.newlines,\n            \"start\": self.start,\n            \"end\": size if self.end is None else self.end,\n            \"firstLineEnd\": size if self.first_line_end is None else self.first_line_end,\n            \"lastLineStart\": self.line_start if self.last_line_start is None else self.last_line_start,\n            \"selectedBytes\": self.selected_bytes,\n            \"firstLineBytes\": self.first_line_bytes,\n        }\n\ndef skill_head(text, complete, path):\n    match = re.match(r\"^---\\r?\\n[\\s\\S]*?\\r?\\n---\", text)\n    if match is not None:\n        return {\"text\": match.group(0)}\n    if text.startswith(\"---\") and not complete:\n        return {\"failure\": {\"code\": \"invalid\", \"message\": \"execution-side skill \" + path + \" does not end its frontmatter within \" + str(MAX_FRONTMATTER) + \" bytes\"}}\n    return {\"text\": text}\n\n\ndef failure_of(error):\n    return {\"code\": code_of(error), \"message\": str(error)}\n\n\ndef snapshot_text(real, read):\n    try:\n        st = os.stat(real)\n    except OSError as error:\n        return {\"failure\": failure_of(error)}\n    if not stat.S_ISREG(st.st_mode):\n        return None\n    if st.st_size > MAX:\n        return {\"failure\": {\"code\": \"invalid\", \"message\": \"file is \" + str(st.st_size) + \" bytes; the gateway limit is \" + str(MAX) + \" bytes\"}}\n    if read == \"whole\":\n        try:\n            with open(real, \"r\", encoding=\"utf-8\", errors=\"replace\") as handle:\n                return {\"text\": handle.read()}\n        except OSError as error:\n            return {\"failure\": failure_of(error)}\n    length = min(st.st_size, MAX_FRONTMATTER)\n    try:\n        with open(real, \"rb\") as handle:\n            head = handle.read(length)\n    except OSError as error:\n        return {\"failure\": failure_of(error)}\n    return skill_head(head.decode(\"utf-8\", \"replace\"), st.st_size <= MAX_FRONTMATTER, real)\n\n\n# The gitignore engine below is a port of `node-ignore@7.0.5` (`index.js`, MIT, Kael Zhang and contributors), which the\n# resource loader and the local snapshot producer match with. The SSH helper matches with this port, so both producers\n# read one grammar instead of one reading a subset of the other's. It is the same REPLACERS chain, the same\n# trailing-wildcard handling, the same rule ordering with negations, and the same parent-directory traversal.\n#\n# The port is pinned by a differential test (`packages/gateway/test/ignore-parity.test.ts`) that runs both engines over\n# a generated corpus of patterns and paths and requires every decision to agree, and by the real-sshd tests that require\n# the two producers to answer the same snapshot.\n# A port of `node-ignore@7.0.5` (`index.js`, MIT, Kael Zhang and contributors) to Python: the same REPLACERS chain\n# that turns one gitignore pattern into a regular expression, the same trailing-wildcard handling, the same rule\n# ordering with negations, and the same parent-directory traversal. The loader and the local producer match with\n# `node-ignore` itself; the SSH helper matches with this, so both producers read one grammar rather than one reading\n# a subset of the other's. Nothing here is a re-interpretation of gitignore: it is the same transformation.\n\nimport re\n\n_TEST_BLANK_LINE = re.compile(r'^\\s+$')\n_TEST_INVALID_TRAILING_BACKSLASH = re.compile(r'(?:[^\\\\]|^)\\\\$')\n_TEST_INVALID_PATH = re.compile(r'^\\.{0,2}/|^\\.{1,2}$')\n_TEST_TRAILING_SLASH = re.compile(r'/$')\n_RANGE = re.compile(r'([0-z])-([0-z])')\n_LEADING_ESCAPED_EXCLAMATION = re.compile(r'^\\\\!')\n_LEADING_ESCAPED_HASH = re.compile(r'^\\\\#')\n\n\ndef _sanitize_range(match):\n    start, end = match.group(1), match.group(2)\n    return match.group(0) if ord(start[0]) <= ord(end[0]) else ''\n\n\ndef _clean_range_backslash(slashes):\n    return slashes[: len(slashes) - len(slashes) % 2]\n\n\ndef _replacer_bom(match):\n    return ''\n\n\ndef _replacer_trailing_spaces(match):\n    return match.group(1) + (' ' if match.group(2).startswith('\\\\') else '')\n\n\ndef _replacer_spaces(match):\n    slashes = match.group(1)\n    return slashes[: len(slashes) - len(slashes) % 2] + ' '\n\n\ndef _replacer_metacharacters(match):\n    return '\\\\' + match.group(0)\n\n\ndef _replacer_question(match):\n    return '[^/]'\n\n\ndef _replacer_leading_slash(match):\n    return '^'\n\n\ndef _replacer_slash(match):\n    return '\\\\/'\n\n\ndef _replacer_leading_globstar(match):\n    return '^(?:.*\\\\/)?'\n\n\n_ORIGINAL_PATTERN = ['']\n\n\ndef _replacer_starting(match):\n    # `node-ignore` binds `this` to the original pattern for this replacer, so the separator test is over the\n    # pattern as it was written, not over the intermediate string this step is editing.\n    return '^' if re.search(r'/(?!$)', _ORIGINAL_PATTERN[0]) else '(?:^|\\\\/)'\n\n\ndef _replacer_globstars(match):\n    return '(?:\\\\/[^\\\\/]+)*' if match.start() + 6 < len(match.string) else '\\\\/.+'\n\n\ndef _replacer_wildcards(match):\n    return match.group(1) + match.group(2).replace('\\\\*', '[^\\\\/]*')\n\n\ndef _replacer_unescape(match):\n    return '\\\\'\n\n\ndef _replacer_backslash(match):\n    return '\\\\'\n\n\ndef _replacer_range(match):\n    lead_escape, body, end_escape, close = match.group(1), match.group(2), match.group(3), match.group(4)\n    if lead_escape == '\\\\':\n        return '\\\\[' + body + _clean_range_backslash(end_escape) + close\n    if close == ']' and len(end_escape) % 2 == 0:\n        return '[' + _RANGE.sub(_sanitize_range, body) + end_escape + ']'\n    return '[]'\n\n\ndef _replacer_ending(match):\n    text = match.group(0)\n    return text + '$' if _TEST_TRAILING_SLASH.search(text) else text + '(?=$|\\\\/$)'\n\n\n# (pattern, replacement, global) in the order `node-ignore` applies them. A non-global entry replaces only the first\n# match, as `String.prototype.replace` does for a regular expression without the `g` flag.\nREPLACERS = (\n    (re.compile('\\ufeff'), _replacer_bom, False),\n    (re.compile(r'((?:\\\\\\\\)*?)(\\\\?\\s+)$'), _replacer_trailing_spaces, False),\n    (re.compile(r'(\\\\+?)\\s'), _replacer_spaces, True),\n    (re.compile(r'[\\\\$.|*+(){^]'), _replacer_metacharacters, True),\n    (re.compile(r'(?!\\\\)\\?'), _replacer_question, True),\n    (re.compile(r'^/'), _replacer_leading_slash, False),\n    (re.compile(r'/'), _replacer_slash, True),\n    (re.compile(r'^\\^*\\\\\\*\\\\\\*\\\\/'), _replacer_leading_globstar, False),\n    (re.compile(r'^(?=[^^])'), _replacer_starting, False),\n    (re.compile(r'\\\\/\\\\\\*\\\\\\*(?=\\\\/|$)'), _replacer_globstars, True),\n    (re.compile(r'(^|[^\\\\]+)(\\\\\\*)+(?=.+)'), _replacer_wildcards, True),\n    (re.compile(r'\\\\\\\\\\\\(?=[$.|*+(){^])'), _replacer_unescape, True),\n    (re.compile(r'\\\\\\\\'), _replacer_backslash, True),\n    (re.compile(r'(\\\\)?\\[([^\\]/]*?)(\\\\*)($|\\])'), _replacer_range, True),\n    (re.compile(r'(?:[^*])$'), _replacer_ending, False),\n)\n\n_REPLACE_TRAILING_WILDCARD = re.compile(r'(^|\\\\/)?\\\\\\*$')\n\n\ndef _apply(pattern, matcher, replacer, global_):\n    return matcher.sub(replacer, pattern) if global_ else matcher.sub(replacer, pattern, count=1)\n\n\ndef _make_regex_prefix(pattern):\n    _ORIGINAL_PATTERN[0] = pattern\n    prefix = pattern\n    for matcher, replacer, global_ in REPLACERS:\n        prefix = _apply(prefix, matcher, replacer, global_)\n    return prefix\n\n\ndef _trailing_wildcard(match):\n    if match.group(1):\n        return match.group(1) + '[^/]+(?=$|\\\\/$)'\n    return '[^/]*(?=$|\\\\/$)'\n\n\ndef _python_safe(expression):\n    \"\"\"The same expression in Python's regular-expression dialect.\n\n    Two shapes `node-ignore` emits are valid JavaScript and not valid Python, both from a malformed pattern: `[]` is\n    an empty class that matches nothing in JavaScript, and a `]` outside a class is a literal there. They are\n    translated rather than refused, so a rule that means the same thing on both sides still does.\n    \"\"\"\n    expression = expression.replace(\"[]\", \"(?!)\")\n    out = []\n    in_class = False\n    for character in expression:\n        if in_class:\n            if character == \"]\":\n                in_class = False\n        elif character == \"[\":\n            in_class = True\n        elif character == \"]\":\n            out.append(\"\\\\]\")\n            continue\n        out.append(character)\n    return \"\".join(out)\n\n\nclass IgnoreRule:\n    def __init__(self, pattern, negative, regex_prefix, ignore_case):\n        self.pattern = pattern\n        self.negative = negative\n        source = _python_safe(_REPLACE_TRAILING_WILDCARD.sub(_trailing_wildcard, regex_prefix, count=1))\n        self.regex = re.compile(source, re.IGNORECASE if ignore_case else 0)\n\n\ndef check_pattern(pattern):\n    return bool(pattern) and isinstance(pattern, str) \\\n        and not _TEST_BLANK_LINE.search(pattern) \\\n        and not _TEST_INVALID_TRAILING_BACKSLASH.search(pattern) \\\n        and not pattern.startswith('#')\n\n\ndef create_rule(pattern, ignore_case):\n    negative = False\n    body = pattern\n    if body.startswith('!'):\n        negative = True\n        body = body[1:]\n    body = _LEADING_ESCAPED_EXCLAMATION.sub('!', body)\n    body = _LEADING_ESCAPED_HASH.sub('#', body)\n    return IgnoreRule(pattern, negative, _make_regex_prefix(body), ignore_case)\n\n\ndef check_path(path):\n    return bool(path) and isinstance(path, str) and not _TEST_INVALID_PATH.search(path)\n\n\nclass Ignore:\n    \"\"\"The `Ignore` surface the producers use: `add(patterns)` and `ignores(path)`, with `node-ignore`'s defaults.\"\"\"\n\n    def __init__(self, ignore_case=True):\n        self._ignore_case = ignore_case\n        self._rules = []\n        self._cache = {}\n\n    def add(self, patterns):\n        for pattern in patterns:\n            if check_pattern(pattern):\n                self._rules.append(create_rule(pattern, self._ignore_case))\n        self._cache = {}\n        return self\n\n    def _test(self, path, check_unignored):\n        ignored = False\n        unignored = False\n        for rule in self._rules:\n            negative = rule.negative\n            if (unignored == negative and ignored != unignored) or (negative and not ignored and not unignored and not check_unignored):\n                continue\n            if not rule.regex.search(path):\n                continue\n            ignored = not negative\n            unignored = negative\n        return ignored\n\n    def _t(self, path, slices, check_unignored):\n        if path in self._cache:\n            return self._cache[path]\n        if slices is None:\n            slices = [part for part in path.split('/') if part]\n        slices.pop()\n        if not slices:\n            self._cache[path] = self._test(path, check_unignored)\n            return self._cache[path]\n        parent = self._t('/'.join(slices) + '/', slices, check_unignored)\n        # > It is not possible to re-include a file if a parent directory of that file is excluded.\n        self._cache[path] = parent if parent else self._test(path, check_unignored)\n        return self._cache[path]\n\n    def ignores(self, path):\n        if not check_path(path):\n            return False\n        return self._t(path, None, False)\n\n\ndef ignore_pattern(line, prefix):\n    \"\"\"One ignore file line as a root-relative pattern, or None when the line is blank or a comment. Mirrors\n    `ignorePattern` in `packages/gateway/src/resource-ignore.ts`: one reading of the prefixing step, in both languages.\"\"\"\n    trimmed = line.strip()\n    if not trimmed:\n        return None\n    if trimmed.startswith('#') and not trimmed.startswith('\\\\#'):\n        return None\n    pattern = line\n    negated = False\n    if pattern.startswith('!'):\n        negated = True\n        pattern = pattern[1:]\n    elif pattern.startswith('\\\\!'):\n        pattern = pattern[1:]\n    if pattern.startswith('/'):\n        pattern = pattern[1:]\n    prefixed = prefix + pattern if prefix else pattern\n    return '!' + prefixed if negated else prefixed\n\n\ndef ignore_rules(text, prefix):\n    patterns = []\n    for line in text.splitlines():\n        pattern = ignore_pattern(line, prefix)\n        if pattern is not None:\n            patterns.append(pattern)\n    return patterns\n\n\ndef resource_snapshot():\n    host = discovery()\n    directories = []\n    files = {}\n    total = [0]\n    counts = [0]\n\n    def spend(value):\n        total[0] += len(json.dumps(value, ensure_ascii=False).encode(\"utf-8\")) + 1\n        if total[0] > MAX_SNAPSHOT:\n            fail(\"invalid\", \"the execution-side resource snapshot exceeds \" + str(MAX_SNAPSHOT) + \" bytes\")\n\n    spend(host)\n    def unreadable(path, real, code, message):\n        item = {\"path\": path, \"real\": real, \"failure\": {\"code\": code, \"message\": message}}\n        spend(item)\n        directories.append(item)\n\n    def take(path, read):\n        existing = files.get(path)\n        if existing is not None and existing[\"read\"] == read:\n            return\n        real = os.path.realpath(path)\n        found = snapshot_text(real, read)\n        if found is None:\n            return\n        if found.get(\"failure\", {}).get(\"code\") == \"not_found\":\n            return\n        item = {\"path\": path, \"real\": real, \"read\": read}\n        item.update(found)\n        spend(item)\n        files[path] = item\n\n    def ignore_files(directory, prefix, matcher):\n        for name in IGNORE_NAMES:\n            path = os.path.join(directory, name)\n            if not os.path.isfile(path):\n                continue\n            try:\n                with open(path, \"r\", encoding=\"utf-8\", errors=\"replace\") as handle:\n                    text = handle.read()\n            except OSError as error:\n                item = {\"path\": path, \"real\": os.path.realpath(path), \"read\": \"whole\", \"failure\": failure_of(error)}\n                spend(item)\n                files[path] = item\n                continue\n            matcher.add(ignore_rules(text, prefix))\n            item = {\"path\": path, \"real\": os.path.realpath(path), \"read\": \"whole\", \"text\": text}\n            spend(item)\n            files[path] = item\n\n    def walk(directory, root_path, kind, ancestors, matcher):\n        try:\n            real = os.path.realpath(directory, strict=True)\n        except OSError as error:\n            if code_of(error) in UNRESOLVABLE:\n                return\n            fail(code_of(error), str(error))\n        if real in ancestors:\n            return\n        try:\n            own = os.stat(real)\n        except OSError as error:\n            unreadable(directory, real, code_of(error), str(error))\n            return\n        if not stat.S_ISDIR(own.st_mode):\n            unreadable(directory, real, \"not_directory\", directory + \" is not a directory\")\n            return\n        visited = set(ancestors)\n        visited.add(real)\n        try:\n            names = sorted(os.listdir(directory))\n        except OSError as error:\n            unreadable(directory, real, code_of(error), str(error))\n            return\n        relative_dir = os.path.relpath(directory, root_path)\n        prefix = \"\" if relative_dir == \".\" else relative_dir + \"/\"\n        ignore_files(directory, prefix, matcher)\n        entries = []\n        for name in names:\n            if name.startswith(\".\") or name == \"node_modules\":\n                continue\n            path = os.path.join(directory, name)\n            try:\n                link = os.lstat(path)\n            except OSError as error:\n                unreadable(directory, real, code_of(error), str(error))\n                return\n            link_kind = kind_of(link.st_mode)\n            if link_kind == \"other\":\n                continue\n            target = os.path.realpath(path)\n            try:\n                target_kind = kind_of(os.stat(target).st_mode)\n            except OSError:\n                target_kind = \"missing\"\n            counts[0] += 1\n            if counts[0] > MAX_SNAPSHOT_ENTRIES:\n                fail(\"invalid\", \"the execution-side resource snapshot exceeds \" + str(MAX_SNAPSHOT_ENTRIES) + \" entries\")\n            entries.append({\"info\": info_of(path, link), \"real\": target, \"realKind\": target_kind})\n        readable = {\"path\": directory, \"real\": real, \"entries\": entries}\n        spend(readable)\n        directories.append(readable)\n        terminal = kind == \"skills\" and any(entry[\"info\"][\"name\"] == \"SKILL.md\" for entry in entries)\n        for entry in entries:\n            if not lexical_within(root_path, entry[\"real\"]):\n                continue\n            logical = entry[\"info\"][\"path\"]\n            if terminal and entry[\"info\"][\"name\"] != \"SKILL.md\":\n                continue\n            relative_path = os.path.relpath(logical, root_path)\n            if matcher.ignores(relative_path + (\"/\" if entry[\"realKind\"] == \"directory\" else \"\")):\n                continue\n            if terminal:\n                take(logical, \"frontmatter\")\n                continue\n            if entry[\"realKind\"] == \"directory\":\n                if kind == \"skills\":\n                    walk(logical, root_path, kind, visited, matcher)\n                continue\n            if entry[\"realKind\"] != \"file\" or not entry[\"info\"][\"name\"].endswith(\".md\"):\n                continue\n            take(logical, \"frontmatter\" if kind == \"skills\" else \"whole\")\n    for item in host[\"roots\"]:\n        walk(item[\"path\"], item[\"path\"], item[\"kind\"], set(), Ignore())\n    for path in host[\"contextFiles\"]:\n        take(path, \"whole\")\n    for key in (\"systemPromptFiles\", \"appendSystemPromptFiles\"):\n        for item in host.get(key) or []:\n            take(item[\"path\"], \"whole\")\n    snapshot = {\"host\": host, \"directories\": directories, \"files\": list(files.values())}\n    if len(json.dumps({\"ok\": True, \"value\": snapshot}).encode(\"utf-8\")) > MAX_SNAPSHOT:\n        fail(\"invalid\", \"the execution-side resource snapshot exceeds \" + str(MAX_SNAPSHOT) + \" bytes\")\n    return snapshot\n\nroot = os.path.realpath(sys.argv[1])\nALLOWED_ROOTS = []\nALLOWED_FILES = set()\nALLOWED_WRITES = []\nSTAGING = []\n\n\ndef dispatch(mode, args):\n    try:\n        if mode == \"info\":\n            path = args[0]\n            confine_read(path)\n            emit({\"ok\": True, \"value\": info_of(path, os.lstat(path))})\n        elif mode == \"list\":\n            path = args[0]\n            confine_read(path)\n            entries = []\n            for name in os.listdir(path):\n                entry = os.path.join(path, name)\n                try:\n                    entries.append(info_of(entry, os.lstat(entry)))\n                except FileNotFoundError:\n                    continue\n            emit({\"ok\": True, \"value\": entries})\n        elif mode == \"canonical\":\n            path = args[0]\n            confine_read(path)\n            emit({\"ok\": True, \"value\": os.path.realpath(path, strict=True)})\n        elif mode == \"exists\":\n            path = args[0]\n            if not os.path.lexists(path):\n                emit({\"ok\": True, \"value\": False})\n            confine_read(path)\n            emit({\"ok\": True, \"value\": True})\n        elif mode == \"read_text\":\n            path = args[0]\n            confine_read(path)\n            regular(path)\n            with open(path, \"r\", encoding=\"utf-8\", errors=\"replace\") as handle:\n                emit({\"ok\": True, \"value\": handle.read()})\n        elif mode == \"read_binary\":\n            path = args[0]\n            confine_read(path)\n            regular(path)\n            with open(path, \"rb\") as handle:\n                emit({\"ok\": True, \"value\": base64.b64encode(handle.read()).decode(\"ascii\")})\n        elif mode == \"open_reader\":\n            path = args[0]\n            no_follow = args[1] == \"1\"\n            confine_read(path)\n            if no_follow and os.path.islink(path):\n                fail(\"invalid\", \"Refusing to follow a symbolic link\")\n            regular(path)\n            flags = os.O_RDONLY | (os.O_NOFOLLOW if no_follow and hasattr(os, \"O_NOFOLLOW\") else 0)\n            fd = os.open(path, flags)\n            st = os.fstat(fd)\n            os.close(fd)\n            emit({\"ok\": True, \"value\": {\"path\": path, \"size\": st.st_size, \"mtimeMs\": st.st_mtime * 1000.0, \"dev\": st.st_dev, \"ino\": st.st_ino}})\n        elif mode == \"reader_info\":\n            path, dev, ino = args[0], int(args[1]), int(args[2])\n            fd = identity(path, dev, ino)\n            st = os.fstat(fd)\n            os.close(fd)\n            emit({\"ok\": True, \"value\": info_of(path, st)})\n        elif mode == \"reader_read\":\n            path, dev, ino, offset, length = args[0], int(args[1]), int(args[2]), int(args[3]), int(args[4])\n            fd = identity(path, dev, ino)\n            try:\n                data = os.pread(fd, length, offset)\n            finally:\n                os.close(fd)\n            emit({\"ok\": True, \"value\": base64.b64encode(data).decode(\"ascii\")})\n        elif mode == \"reader_scan\":\n            path, dev, ino, start_line = args[0], int(args[1]), int(args[2]), int(args[3])\n            end_line = None if args[4] == \"-1\" else int(args[4])\n            if start_line < 0 or (end_line is not None and end_line <= start_line):\n                fail(\"invalid\", \"Invalid line range\")\n            fd = identity(path, dev, ino)\n            scanner = Scanner(start_line, float(\"inf\") if end_line is None else end_line)\n            try:\n                position = 0\n                while True:\n                    chunk = os.pread(fd, 65536, position)\n                    if not chunk:\n                        break\n                    scanner.push(chunk)\n                    position += len(chunk)\n            finally:\n                os.close(fd)\n            emit({\"ok\": True, \"value\": scanner.finish()})\n        elif mode == \"write_begin\":\n            path = args[0]\n            confine(root, path)\n            parent = os.path.dirname(path)\n            if parent:\n                os.makedirs(parent, exist_ok=True)\n            with open(path, \"wb\"):\n                pass\n            STAGING.append(path)\n            emit({\"ok\": True})\n        elif mode == \"write_chunk\" or mode == \"append\":\n            path = args[0]\n            data = base64.b64decode(args[1], validate=True)\n            confine(root, path)\n            if mode == \"append\":\n                parent = os.path.dirname(path)\n                if parent:\n                    os.makedirs(parent, exist_ok=True)\n            with open(path, \"ab\") as handle:\n                handle.write(data)\n            emit({\"ok\": True})\n        elif mode == \"write_commit\":\n            source, destination = args[0], args[1]\n            confine(root, source)\n            confine(root, destination)\n            os.replace(source, destination)\n            if source in STAGING:\n                STAGING.remove(source)\n            emit({\"ok\": True})\n        elif mode == \"write_abort\":\n            path = args[0]\n            confine(root, path)\n            try:\n                os.remove(path)\n            except FileNotFoundError:\n                pass\n            if path in STAGING:\n                STAGING.remove(path)\n            emit({\"ok\": True})\n        elif mode == \"truncate\":\n            path, size = args[0], int(args[1])\n            confine(root, path)\n            regular(path)\n            os.truncate(path, size)\n            emit({\"ok\": True})\n        elif mode == \"flush\":\n            path = args[0]\n            confine(root, path)\n            handle = os.open(path, os.O_RDWR)\n            try:\n                if stat.S_ISDIR(os.fstat(handle).st_mode):\n                    fail(\"is_directory\", \"Is a directory\")\n                os.fsync(handle)\n            finally:\n                os.close(handle)\n            emit({\"ok\": True})\n        elif mode == \"rename\":\n            source, destination = args[0], args[1]\n            confine(root, source)\n            confine(root, destination)\n            if len(args) > 2 and args[2] == \"1\" and os.path.lexists(destination) and not os.path.islink(destination):\n                os.chmod(source, stat.S_IMODE(os.lstat(destination).st_mode))\n            os.rename(source, destination)\n            emit({\"ok\": True})\n        elif mode == \"remove\":\n            path = args[0]\n            recursive = args[1] == \"1\"\n            force = args[2] == \"1\"\n            if force and not os.path.lexists(path):\n                emit({\"ok\": True})\n            confine(root, path)\n            try:\n                if recursive and os.path.isdir(path) and not os.path.islink(path):\n                    shutil.rmtree(path)\n                else:\n                    os.remove(path)\n            except FileNotFoundError:\n                if not force:\n                    raise\n            emit({\"ok\": True})\n        elif mode == \"mkdir\":\n            path = args[0]\n            recursive = args[1] == \"1\"\n            confine(root, path)\n            if recursive:\n                os.makedirs(path, exist_ok=True)\n            else:\n                os.mkdir(path)\n            emit({\"ok\": True})\n        elif mode == \"tmpdir\":\n            prefix = args[0] or \"tmp-\"\n            emit({\"ok\": True, \"value\": tempfile.mkdtemp(prefix=prefix, dir=root)})\n        elif mode == \"tmpfile\":\n            prefix = args[0] or \"tmp-\"\n            suffix = args[1]\n            fd, path = tempfile.mkstemp(prefix=prefix, suffix=suffix, dir=root)\n            os.close(fd)\n            emit({\"ok\": True, \"value\": path})\n        elif mode == \"snapshot\":\n            emit({\"ok\": True, \"value\": resource_snapshot()})\n        elif mode == \"discover\":\n            emit({\"ok\": True, \"value\": discovery()})\n        else:\n            fail(\"not_supported\", \"unknown remote filesystem operation: \" + mode)\n    except OSError as error:\n        fail(code_of(error), str(error))\n    except ValueError as error:\n        fail(\"invalid\", str(error))\n\n\ndef read_exact(stream, count):\n    data = b\"\"\n    while len(data) < count:\n        chunk = stream.read(count - len(data))\n        if not chunk:\n            return None\n        data += chunk\n    return data\n\n\ndef send(kind, payload):\n    sys.stdout.buffer.write(struct.pack(\">BI\", kind, len(payload)) + payload)\n    sys.stdout.buffer.flush()\n\n\ndef answer(value):\n    data = json.dumps(value).encode(\"utf-8\")\n    if len(data) > MAX_FRAME:\n        data = json.dumps({\"ok\": False, \"error\": {\"code\": \"invalid\", \"message\": \"the remote filesystem result exceeds \" + str(MAX_FRAME) + \" bytes\"}}).encode(\"utf-8\")\n    send(RESULT, data)\n\n\ndef serve():\n    \"\"\"One request frame in, one result frame out, until the gateway closes the session or its pipe ends. The session\n    carries its own root, so a request cannot name a different one, and every operation still confines itself.\"\"\"\n    while True:\n        header = read_exact(sys.stdin.buffer, 5)\n        if header is None:\n            return\n        kind, length = struct.unpack(\">BI\", header)\n        if kind != REQUEST or length > MAX_REQUEST:\n            answer({\"ok\": False, \"error\": {\"code\": \"invalid\", \"message\": \"the remote filesystem request exceeds \" + str(MAX_REQUEST) + \" bytes\"}})\n            return\n        payload = read_exact(sys.stdin.buffer, length) if length else b\"\"\n        if payload is None:\n            return\n        try:\n            frame = json.loads(payload)\n            claimed = frame.get(\"root\")\n            if claimed is None or os.path.realpath(claimed) != root:\n                fail(\"permission_denied\", \"path outside workspace\")\n            allow = frame.get(\"allow\") or {}\n            global ALLOWED_ROOTS, ALLOWED_FILES, ALLOWED_WRITES\n            ALLOWED_ROOTS = allow.get(\"roots\") or []\n            ALLOWED_FILES = set(allow.get(\"files\") or [])\n            ALLOWED_WRITES = allow.get(\"writes\") or []\n            dispatch(frame.get(\"mode\"), frame.get(\"args\") or [])\n        except Done as done:\n            answer(done.payload)\n        except OSError as error:\n            answer({\"ok\": False, \"error\": {\"code\": code_of(error), \"message\": str(error)}})\n        except ValueError as error:\n            answer({\"ok\": False, \"error\": {\"code\": \"invalid\", \"message\": str(error)}})\n\n\ntry:\n    serve()\nfinally:\n    # Only the staging files this session created, by path, and only on a graceful end: a session that was killed leaves\n    # its residue where it is, because it is not a later session's file to remove.\n    for path in STAGING:\n        try:\n            os.remove(path)\n        except OSError:\n            pass\n";

/**
 * The program reaches the host as one argv word, so the remote shell never has to parse it; `ssh` hands the whole
 * command to the remote shell, and the bootstrap restores `sys.argv` to the program's own arguments.
 */
const REMOTE_FILESYSTEM_BASE64 = Buffer.from(REMOTE_FILESYSTEM_SCRIPT, "utf8").toString("base64");
const REMOTE_BOOTSTRAP = "import base64,sys;src=base64.b64decode(sys.argv[1]);sys.argv=[sys.argv[0]]+sys.argv[2:];exec(compile(src,'hepi','exec'))";

/** One request frame's own bound, and the answer bound the session refuses to slice past. Both sides enforce them. */
export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const FRAME_REQUEST = 10;
const FRAME_RESULT = 11;
const FRAME_CLOSE = 12;
/** How long a session with no caller attached is kept before it is closed. The terminal's own reconnect window. */
const SESSION_IDLE_MS = 120_000;
/** How long a closed session's helper is given to end itself, staging cleanup included, before it is killed. */
const SESSION_END_GRACE_MS = 5000;

export type SshFilesystemOptions = {
  readonly id: string;
  readonly profiles: readonly SshProfile[];
  readonly runner?: SshRunner;
  /** The gateway's shared registry: a folder registered at runtime is served here at the root it was registered with. */
  readonly workspaces: WorkspaceRegistry;
  readonly readerTtlMs?: number;
  readonly maxReaders?: number;
  /** Overridden by tests that need a session to close at a known moment; the default is `SESSION_IDLE_MS`. */
  readonly sessionIdleMs?: number;
  /**
   * Overridden by tests that need the deadline at a known moment; the default is `SSH_FILE_TIMEOUT_MS`, the deadline
   * the one-shot transport applied to every file operation.
   */
  readonly requestTimeoutMs?: number;
};

/**
 * The read locations the remote helper accepts for one request, beyond the workspace root it always has: the
 * execution-side resource roots (ADR 0002) and the context, system-prompt and append-prompt files that live outside any
 * root. Everything else on the host stays unreachable, so resource access does not widen into a general home read.
 */
export type ReadAuthorization = {
  /** Execution-side resource roots a read may also name; empty for a mutation. */
  readonly roots: readonly string[];
  /** Execution-side resource files a read may also name; empty for a mutation. */
  readonly files: readonly string[];
  /** The same resource locations, for a mutation that refuses them instead of remapping them into the workspace. */
  readonly denied: readonly string[];
  /**
   * The one restricted resource surface a mutation may name besides the workspace: the host's agent definition
   * directories, when the request declared \`resource: "agent-definitions"\`. Each entry carries the directory and the
   * account home (or workspace) whose existing ancestors are the boundary the directory may be created under. Empty for
   * every other mutation.
   */
  readonly writes: readonly { readonly path: string; readonly boundary: string }[];
};

/** The reader identity the remote helper keeps: the opened path and the device/inode it was opened as. */
type RemoteReader = { readonly path: string; readonly dev: number; readonly ino: number; close(context: Context): Promise<void> };

type RemoteResult = { ok: true; value: unknown } | { ok: false; error: FileError };
type RemoteOpened = { path: string; size: number; mtimeMs: number; dev: number; ino: number };

const FILE_ERROR_CODES: readonly FileErrorCode[] = ["aborted", "not_found", "permission_denied", "not_directory", "is_directory", "invalid", "not_supported", "unknown"];

/**
 * One framed conversation with a host program: a request written, its result read, and what a death means. `settle`
 * detaches the request's abort listener before it answers, because the gateway's own controller outlives every request
 * and a listener left behind would accumulate for the life of the process.
 */
type Pending = { readonly answer: (result: RemoteResult) => void; written: boolean };

/**
 * One helper session for one `(profile, root)`: its process, the request it may have written, and the frames it reads.
 * A request waits its turn instead of opening a second channel, and the two ways a request can fail stay apart — a
 * request the session never wrote failed here and is reported as not sent, while one whose frame was written is the
 * host's outcome to report, which is unknown once the session dies. Nothing is ever replayed.
 */
class Session {
  readonly #profile: SshProfile;
  readonly #root: string;
  readonly #idleMs: number;
  #child: ChildProcess;
  #buffer = Buffer.alloc(0);
  #pending: Pending | undefined;
  /** The dispatch chain: one request in flight, every other waiter chained behind it. */
  #queue: Promise<void> = Promise.resolve();
  #idle: ReturnType<typeof setTimeout> | undefined;
  #closed = false;
  /** The one teardown this session runs, so a cancellation and a close cannot both end it. */
  #ending: Promise<void> | undefined;
  /** The gateway's file deadline for one request, the same bound the one-shot transport applied. */
  readonly #requestTimeoutMs: number;
  /** Set while a multi-part write is in progress, so an idle close cannot end the session under it. */
  #pinned = false;
  /** What the helper said before it answered anything, so a host that cannot run it at all is a named limit. */
  #stderr = "";
  #spawnError: string | undefined;
  #exitCode: number | null = null;
  /** Whether the helper has ever answered: a session that never did failed to start rather than failed a request. */
  #ready = false;

  constructor(profile: SshProfile, root: string, runner: SshRunner, command: readonly string[], idleMs: number, requestTimeoutMs: number) {
    this.#profile = profile;
    this.#root = root;
    this.#idleMs = idleMs;
    this.#requestTimeoutMs = requestTimeoutMs;
    // The runner's transport owns the connection and the pipes; this session owns only the frames on them.
    this.#child = runner.open!({ profile: profile.id, host: profile.host, root, cwd: root, port: profile.port, identityFile: profile.identityFile, knownHostsFile: profile.knownHostsFile, command });
    this.#child.stdout!.on("data", (chunk: Buffer) => this.#consume(chunk));
    this.#child.stderr!.on("data", (chunk: Buffer) => { if (this.#stderr.length < 8192) this.#stderr += chunk.toString("utf8"); });
    // A write to a pipe whose far end is already gone reports EPIPE on the stream, not at the call site: it means the
    // session ended, which the close handler already reports, so it must not become an uncaught error.
    this.#child.stdin!.on("error", () => this.#die());
    this.#child.on("close", (code: number | null) => { this.#exitCode = code; this.#die(); });
    this.#child.on("error", (error: NodeJS.ErrnoException) => { this.#spawnError = error.code ?? error.message; this.#die(); });
    this.#touch();
  }

  get profile(): SshProfile { return this.#profile; }
  get closed(): boolean { return this.#closed; }

  /** Whether this session serves that profile and root: one session per pair, and nothing else reuses it. */
  matches(profile: SshProfile, root: string): boolean {
    return this.#profile.id === profile.id && this.#profile.host === profile.host && this.#root === root
      && this.#profile.port === profile.port && this.#profile.identityFile === profile.identityFile
      && this.#profile.knownHostsFile === profile.knownHostsFile;
  }

  /** Whether this session may be closed for being unused: nothing in flight and no pinned write. */
  get idle(): boolean { return this.#pending === undefined && !this.#pinned && !this.#closed; }

  pin(): void { this.#pinned = true; }

  unpin(): void { this.#pinned = false; this.#touch(); }

  /**
   * One request: wait for the session to be free, write the frame, and answer with what comes back. The request has
   * the gateway's own file deadline, so a host that accepts a frame and never answers cannot hold the request, or the
   * waiters chained behind it, forever.
   */
  request(mode: string, args: readonly string[], allow: ReadAuthorization | undefined, signal: AbortSignal): Promise<RemoteResult> {
    const expiresAt = Date.now() + this.#requestTimeoutMs;
    const run = this.#queue.then(() => this.#dispatch(mode, args, allow, signal, expiresAt));
    // A failed request is a value, not a broken chain: the next waiter still gets its turn.
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  #dispatch(mode: string, args: readonly string[], allow: ReadAuthorization | undefined, signal: AbortSignal, expiresAt: number): Promise<RemoteResult> {
    if (this.#closed) return Promise.resolve(notSent());
    if (signal.aborted) return Promise.resolve(notSent());
    // A request that waited past its deadline was never written: that is a local failure, not an unknown remote
    // outcome, so it is reported as not sent rather than as a write that may have happened.
    if (Date.now() >= expiresAt) return Promise.resolve(notSent());
    const payload = Buffer.from(JSON.stringify({ mode, args, root: this.#root, allow: allow === undefined ? {} : { roots: allow.roots, files: allow.files, writes: allow.writes } }), "utf8");
    if (payload.length > MAX_REQUEST_BYTES) return Promise.resolve(dispatchFailure("invalid", "the request exceeds the " + MAX_REQUEST_BYTES + " byte session limit"));
    return new Promise<RemoteResult>((settle) => {
      const abort = () => {
        if (this.#pending !== pending) return;
        // The frame may or may not have reached the host: nothing is replayed, and the session is dropped rather than
        // letting a late answer be attributed to a later request.
        this.#fail("unknown", "ssh filesystem outcome unknown");
        this.#drop();
      };
      // The deadline starts when the frame is written: the host has the request, so the answer is its outcome to
      // report, and a late one is never attributed to a later request.
      const deadline = setTimeout(() => {
        if (this.#pending !== pending) return;
        this.#fail("unknown", "ssh filesystem outcome unknown");
        this.#drop();
      }, Math.max(0, expiresAt - Date.now()));
      const pending: Pending = {
        answer: (result) => { clearTimeout(deadline); signal.removeEventListener("abort", abort); settle(result); },
        written: false,
      };
      this.#pending = pending;
      this.#clearIdle();
      signal.addEventListener("abort", abort, { once: true });
      const header = Buffer.alloc(5);
      header.writeUInt8(FRAME_REQUEST, 0);
      header.writeUInt32BE(payload.length, 1);
      pending.written = true;
      try {
        this.#child.stdin!.write(Buffer.concat([header, payload]));
      } catch {
        this.#fail("unknown", "ssh filesystem outcome unknown");
        this.#drop();
      }
    });
  }

  #consume(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 5) {
      const kind = this.#buffer.readUInt8(0);
      const length = this.#buffer.readUInt32BE(1);
      if (length > MAX_FRAME_BYTES) {
        // The stream is no longer trustworthy: the request fails and the session ends, rather than resynchronising.
        this.#fail("unknown", "the remote filesystem answer is above the " + MAX_FRAME_BYTES + " byte session limit");
        this.#drop();
        return;
      }
      if (this.#buffer.length < 5 + length) return;
      const payload = this.#buffer.subarray(5, 5 + length);
      this.#buffer = this.#buffer.subarray(5 + length);
      if (kind === FRAME_RESULT) this.#answer(payload);
      else if (kind === FRAME_CLOSE) this.#drop();
    }
  }

  #answer(payload: Buffer): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    this.#pending = undefined;
    this.#ready = true;
    let parsed: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string; path?: string } };
    try {
      parsed = JSON.parse(payload.toString("utf8"));
    } catch {
      pending.answer(dispatchFailure("unknown", "remote filesystem returned no result"));
      this.#drop();
      return;
    }
    pending.answer(parsed.ok === true
      ? { ok: true, value: parsed.value }
      : { ok: false, error: new FileError(fileErrorCode(parsed.error?.code), parsed.error?.message ?? "remote filesystem failed", parsed.error?.path) });
    this.#touch();
  }

  /** End the request in flight as the given failure, keeping "never sent" for one whose frame was not written. */
  #fail(code: FileErrorCode, message: string): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    this.#pending = undefined;
    pending.answer(pending.written ? dispatchFailure(code, message) : notSent());
  }

  /**
   * The session is over: the request in flight is the host's unknown outcome, and no waiter was ever sent. A session
   * that never answered at all is a host that could not run the helper — a named limit, not an unknown outcome.
   */
  #die(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearIdle();
    const pending = this.#pending;
    if (pending === undefined) return;
    this.#pending = undefined;
    pending.answer(pending.written ? this.#death() : notSent());
  }

  /**
   * What a death means for the request that was written and never answered. A session that never answered at all
   * failed to start, and how it failed is known: the transport could not reach the host, or the host cannot run the
   * helper. Only a session that had answered and then died leaves the operation's outcome unknown.
   */
  #death(): RemoteResult {
    if (this.#spawnError !== undefined) return dispatchFailure("unknown", "ssh host unreachable");
    if (!this.#ready) {
      const message = this.#stderr.trim();
      if (/python3: (command )?not found/i.test(this.#stderr)) return dispatchFailure("not_supported", "the SSH host needs Python 3 on PATH for gateway filesystem operations: " + (message || "the host has no python3"));
      // ssh's own failure code: the connection never carried a request, so the host is unreachable rather than unknown.
      if (this.#exitCode === 255) return dispatchFailure("unknown", "ssh host unreachable" + (message === "" ? "" : ": " + message));
    }
    return dispatchFailure("unknown", "ssh filesystem outcome unknown");
  }

  /** End the session the way `close` does: every gateway-initiated end is graceful and bounded. */
  #drop(): void { void this.close(); }

  /**
   * End the session: the helper is asked to close, and given the bounded grace to remove the staging files it created
   * itself, then it is killed. Every end the gateway initiates — an idle close, a cancellation, a deadline — takes
   * this path, so a session the gateway ends cleans up after itself. A host that has already gone cannot be asked,
   * which is why an abnormal death still leaves its residue.
   */
  async close(): Promise<void> {
    this.#ending ??= this.#end();
    await this.#ending;
  }

  async #end(): Promise<void> {
    this.#closed = true;
    this.#clearIdle();
    this.#fail("unknown", "ssh filesystem outcome unknown");
    const gone = this.#child.exitCode !== null || this.#child.signalCode !== null;
    const ending = gone ? Promise.resolve() : new Promise<void>((resolveEnd) => {
      const timer = setTimeout(() => { this.#child.kill("SIGKILL"); resolveEnd(); }, SESSION_END_GRACE_MS);
      this.#child.once("close", () => { clearTimeout(timer); resolveEnd(); });
    });
    const stdin = this.#child.stdin;
    if (stdin !== null && !stdin.destroyed) {
      const header = Buffer.alloc(5);
      header.writeUInt8(FRAME_CLOSE, 0);
      header.writeUInt32BE(0, 1);
      try { stdin.write(header); } catch { /* the helper is already gone; the grace below still bounds the end */ }
      stdin.end();
    }
    await ending;
  }

  #touch(): void {
    this.#clearIdle();
    if (this.#closed || this.#pinned) return;
    this.#idle = setTimeout(() => { this.#idle = undefined; if (this.idle) void this.close(); }, this.#idleMs);
    this.#idle.unref?.();
  }

  #clearIdle(): void { if (this.#idle !== undefined) { clearTimeout(this.#idle); this.#idle = undefined; } }
}

function dispatchFailure(code: FileErrorCode, message: string): RemoteResult { return { ok: false, error: new FileError(code, message) }; }

/** A request the session never wrote: a local failure, never an unknown remote outcome. */
function notSent(): RemoteResult { return dispatchFailure("aborted", "the request was not sent"); }

/**
 * Serves `/v1/files` for SSH workspaces: `remote-<profile>` names a profile and the profile's `remoteRoot` is the
 * workspace. Read, write and edit work through one persistent Python 3 session per (profile, root) over the runner's
 * interactive transport; the gateway installs nothing on the host and no service listens there.
 *
 * Remote writes are staged: the target's directory holds a temporary file that receives the content and is then
 * renamed over the target, so a failed write leaves the previous content. A dispatched mutation whose response is lost
 * is not retried: the caller sees an unknown outcome rather than a second write. A request the session never wrote is
 * reported as not sent, which is a local failure with no remote effect.
 */
export class SshFilesystem implements FilesystemServer {
  readonly id: string;
  readonly #profiles: ReadonlyMap<string, SshProfile>;
  readonly #workspaces: WorkspaceRegistry;
  readonly #runner: SshRunner;
  readonly #sessions: Session[] = [];
  readonly #idleMs: number;
  readonly #requestTimeoutMs: number;
  readonly readers: ReaderRegistry<RemoteReader>;
  readonly #controller = new AbortController();

  constructor(options: SshFilesystemOptions) {
    this.id = options.id;
    this.#profiles = new Map(options.profiles.map(profile => [profile.id, profile]));
    this.#workspaces = options.workspaces;
    this.#runner = options.runner ?? createSystemSshRunner();
    this.#idleMs = options.sessionIdleMs ?? SESSION_IDLE_MS;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? SSH_FILE_TIMEOUT_MS;
    this.readers = new ReaderRegistry(options.readerTtlMs ?? READER_TTL_MS, options.maxReaders ?? MAX_READERS);
  }

  async execute(request: FileRequest): Promise<unknown> {
    try {
      // The registry decides which profile and root an id names; an id it does not hold is unknown, never a prefix
      // that happens to match a profile's name.
      const owner = workspaceOwner(this.#workspaces, this.#profiles, request.workspaceId);
      if (owner === undefined) return fileFailure(new FileError("permission_denied", "unknown workspace"));
      const profile = owner.profile;
      this.readers.reap();
      const root = owner.root;
      // A transport that cannot hold a session open is a named limit, and there is no second per-call code path: the
      // capability is reported once instead of quietly changing what every request costs and how it can fail.
      if (this.#runner.open === undefined) return fileFailure(new FileError("not_supported", "this SSH transport cannot hold a filesystem session open"));
      if (request.method === "executionHost") return await this.#executionHost(profile, root);
      // One discovery is one helper request: the account, the roots and the text of every file the walk needs come back
      // together, so the per-request host resolution and the per-file read of the resource walk disappear.
      if (request.method === "resourceSnapshot") return await this.#snapshot(profile, root);
      // Every other method names a path, and a read also names the host locations it may reach. The read authorization
      // is resolved from the host itself, so a request can never name a resource root the host does not have. The three
      // methods that name no target path and pass no allow list resolve nothing: a temporary file and a reader close
      // have no resource location to refuse and no path to remap.
      const allow = NAMELESS_METHODS.includes(request.method) ? undefined : await this.#readAuthorization(profile, root, request);
      // A resource location is read-only, exactly as it is on the local filesystem: a mutation naming one is refused
      // instead of being remapped under the workspace, where it would create an unrelated file.
      // A mutation names one or two paths: `renameFile` also names its destination, which must be refused the same way.
      if (allow !== undefined && !READ_METHODS.includes(request.method)) {
        for (const target of [request.path, request.destinationPath]) {
          if (target !== undefined && mutationDenied(allow, root, target)) {
            return fileFailure(new FileError("permission_denied", "execution-side resource locations are read-only", target));
          }
        }
      }
      // The temporary-directory methods name no target path; everything else does. A read may name a resource
      // location by its real host path, which is not below the workspace and must not be remapped into it.
      const resourceRead = READ_METHODS.includes(request.method) && allow !== undefined && isResourceRead(allow, request.path);
      if (request.handle !== undefined) return await this.#reader(profile, request, allow, resourceRead);
      // A mutation inside an agent definition directory names a real absolute host path; every other mutation keeps the
      // workspace mapping, so an unauthorized absolute path still lands inside the workspace and is reported missing.
      const mutationTarget = (target: string | undefined): string | undefined => target === undefined ? undefined
        : allow !== undefined && isAgentWrite(allow, target) ? resolve(target) : remotePath(root, target);
      const path = request.path === undefined ? undefined : READ_METHODS.includes(request.method) ? remoteReadPath(root, request.path, allow) : mutationTarget(request.path);
      switch (request.method) {
        case "readTextFile": return await this.#readText(profile, root, path!, allow);
        case "readBinaryFile": return await this.#readBinary(profile, root, path!, allow);
        case "writeFile": return await this.#write(profile, root, path!, contentOf(request), allow);
        case "appendFile": return await this.#append(profile, root, path!, contentOf(request));
        case "truncateFile": return await this.#simple(profile, root, ["truncate", path!, String(request.size ?? 0)], allow);
        case "flushFile": return await this.#simple(profile, root, ["flush", path!], allow);
        case "renameFile": return await this.#simple(profile, root, ["rename", path!, mutationTarget(request.destinationPath)!, request.options?.preserveMode === true ? "1" : "0"], allow);
        case "remove": return await this.#simple(profile, root, ["remove", path!, request.options?.recursive === true ? "1" : "0", request.options?.force === true ? "1" : "0"], allow);
        case "createDir": return await this.#simple(profile, root, ["mkdir", path!, request.options?.recursive === false ? "0" : "1"], allow);
        case "createTempDir": { const result = await this.#call(profile, root, ["tmpdir", tempName(request.prefix ?? "tmp-")]); return result.ok ? { ok: true, value: relativePath(root, String(result.value)) } : fileFailure(result.error); }
        case "createTempFile": { const result = await this.#call(profile, root, ["tmpfile", tempName(request.prefix ?? "tmp-"), tempName(request.suffix ?? "")]); return result.ok ? { ok: true, value: relativePath(root, String(result.value)) } : fileFailure(result.error); }
        case "fileInfo": return await this.#info(profile, root, path!, allow, resourceRead);
        case "listDir": {
          const result = await this.#call(profile, root, ["list", path!], allow);
          return result.ok ? { ok: true, value: (result.value as FileInfo[]).map(item => reportInfo(root, item, resourceRead)) } : fileFailure(result.error);
        }
        case "canonicalPath": { const result = await this.#call(profile, root, ["canonical", path!], allow); return result.ok ? { ok: true, value: reportPath(root, String(result.value), resourceRead) } : fileFailure(result.error); }
        case "exists": return await this.#simple(profile, root, ["exists", path!], allow);
        case "openBinaryReader": return await this.#open(profile, root, path!, request.options?.noFollow === true, allow);
        default: return fileFailure(new FileError("not_supported", request.method + " is not supported by the SSH filesystem"));
      }
    } catch (error) { return fileFailure(asFileError(error)); }
  }

  /** Close every session this filesystem opened, after aborting the work in flight. */
  async close(): Promise<void> {
    this.#controller.abort();
    await this.readers.close();
    const sessions = this.#sessions.splice(0, this.#sessions.length);
    await Promise.all(sessions.map((session) => session.close()));
  }

  /** The host's own account, home and resource roots, discovered by the remote helper (ADR 0002). */
  async #executionHost(profile: SshProfile, root: string): Promise<unknown> {
    const host = await this.#host(profile, root);
    return host.ok ? { ok: true, value: host.value } : fileFailure(host.error);
  }

  /** The whole resource scope set of this host in one helper request (ADR 0002). */
  async #snapshot(profile: SshProfile, root: string): Promise<unknown> {
    const result = await this.#call(profile, root, ["snapshot"]);
    return result.ok ? { ok: true, value: result.value } : fileFailure(result.error);
  }

  /**
   * The host's own account, home and scope set. The account and the discovery are one request, so the locations reads
   * are authorized against are still the host's answer and never a value the gateway supplied (ADR 0002), while a
   * request that needs them pays one round trip instead of two.
   */
  async #host(profile: SshProfile, root: string): Promise<{ ok: true; value: ExecutionHost } | { ok: false; error: FileError }> {
    const discovered = await this.#call(profile, root, ["discover"]);
    return discovered.ok ? { ok: true, value: discovered.value as ExecutionHost } : { ok: false, error: discovered.error };
  }

  /**
   * The read locations one request may name. Every method that names a path resolves them, because the workspace root
   * is also the helper's confinement root, so an unreachable host fails a write too. A mutation keeps only the
   * workspace: the resource roots stay readable and never writable through the file RPC.
   */
  async #readAuthorization(profile: SshProfile, root: string, request: FileRequest): Promise<ReadAuthorization> {
    const host = await this.#host(profile, root);
    if (!host.ok) throw host.error;
    return readAuthorization(host.value, request.method, request.resource === "agent-definitions");
  }

  /** A read whose own bound is the gateway's: the helper applies it and reports it in the gateway's words. */
  async #readText(profile: SshProfile, root: string, path: string, allow: ReadAuthorization | undefined): Promise<unknown> {
    const result = await this.#call(profile, root, ["read_text", path], allow);
    return result.ok ? { ok: true, value: result.value } : fileFailure(result.error);
  }

  async #readBinary(profile: SshProfile, root: string, path: string, allow: ReadAuthorization | undefined): Promise<unknown> {
    const result = await this.#call(profile, root, ["read_binary", path], allow);
    return result.ok ? { ok: true, value: result.value } : fileFailure(result.error);
  }

  async #info(profile: SshProfile, root: string, path: string, allow: ReadAuthorization | undefined, resourceRead: boolean): Promise<unknown> {
    const result = await this.#call(profile, root, ["info", path], allow);
    return result.ok ? { ok: true, value: reportInfo(root, result.value as FileInfo, resourceRead) } : fileFailure(result.error);
  }

  async #simple(profile: SshProfile, root: string, argv: readonly string[], allow: ReadAuthorization | undefined): Promise<unknown> {
    const result = await this.#call(profile, root, argv, allow);
    return result.ok ? { ok: true, value: result.value } : fileFailure(result.error);
  }

  async #open(profile: SshProfile, root: string, path: string, noFollow: boolean, allow: ReadAuthorization | undefined): Promise<unknown> {
    const result = await this.#call(profile, root, ["open_reader", path, noFollow ? "1" : "0"], allow);
    if (!result.ok) return fileFailure(result.error);
    const opened = result.value as RemoteOpened;
    // Nothing stays open on the host: each read re-opens the file and checks the identity it was opened as.
    const reader: RemoteReader = { path: opened.path, dev: opened.dev, ino: opened.ino, close: async () => {} };
    return { ok: true, value: this.readers.add(profile.id, root, reader) };
  }

  async #reader(profile: SshProfile, request: FileRequest, allow: ReadAuthorization | undefined, resourceRead: boolean): Promise<unknown> {
    const stored = this.readers.take(request.handle!, profile.id);
    if (stored === undefined) return fileFailure(new FileError("invalid", "unknown or expired reader"));
    if (request.method === "reader.close") { this.readers.remove(request.handle!); return { ok: true }; }
    const { path, dev, ino } = stored.reader;
    const reader: GatewayReader = {
      info: async () => {
        const result = await this.#call(profile, stored.root, ["reader_info", path, String(dev), String(ino)], allow);
        return result.ok ? { ok: true as const, value: reportInfo(stored.root, result.value as FileInfo, resourceRead) } : result;
      },
      read: async (offset: number, length: number) => {
        const result = await this.#call(profile, stored.root, ["reader_read", path, String(dev), String(ino), String(offset), String(length)], allow);
        return result.ok ? { ok: true as const, value: String(result.value) } : result;
      },
      scanLines: async (options: { startLine: number; endLine?: number }) => {
        const result = await this.#call(profile, stored.root, ["reader_scan", path, String(dev), String(ino), String(options.startLine), options.endLine === undefined ? "-1" : String(options.endLine)], allow);
        return result.ok ? { ok: true as const, value: result.value as LineScan } : result;
      },
    };
    return await readerMethod(reader, request);
  }

  /**
   * Stage `content` in the target directory, then rename it over the target so a failed write changes nothing. The
   * whole write rides one pinned session: an idle close or a cancellation cannot move a half-written file to another
   * helper, and a lost commit answer is an unknown outcome that is never re-sent.
   */
  async #write(profile: SshProfile, root: string, path: string, content: string | Uint8Array, allow?: ReadAuthorization): Promise<unknown> {
    const bytes = toBytes(content);
    if (bytes.byteLength > MAX_FILE_BYTES) return fileFailure(new FileError("invalid", "content exceeds the " + MAX_FILE_BYTES + " byte gateway limit"));
    const staging = dirname(path) + "/.hepi-write-" + randomUUID() + ".tmp";
    const session = this.#session(profile, root);
    session.pin();
    try {
      const begun = await session.request("write_begin", [staging], allow, this.#controller.signal);
      if (!begun.ok) return fileFailure(begun.error);
      for (let offset = 0; offset < bytes.byteLength; offset += WRITE_CHUNK_BYTES) {
        const chunk = Buffer.from(bytes.subarray(offset, offset + WRITE_CHUNK_BYTES)).toString("base64");
        const written = await session.request("write_chunk", [staging, chunk], allow, this.#controller.signal);
        if (!written.ok) { await session.request("write_abort", [staging], allow, this.#controller.signal); return fileFailure(written.error); }
      }
      const committed = await session.request("write_commit", [staging, path], allow, this.#controller.signal);
      if (!committed.ok) { await session.request("write_abort", [staging], allow, this.#controller.signal); return fileFailure(committed.error); }
      return { ok: true, value: undefined };
    } finally {
      session.unpin();
    }
  }

  /** Append `content` in bounded chunks, so no single request frame carries more than one chunk. */
  async #append(profile: SshProfile, root: string, path: string, content: string | Uint8Array): Promise<unknown> {
    const bytes = toBytes(content);
    if (bytes.byteLength > MAX_FILE_BYTES) return fileFailure(new FileError("invalid", "content exceeds the " + MAX_FILE_BYTES + " byte gateway limit"));
    for (let offset = 0; offset < bytes.byteLength; offset += WRITE_CHUNK_BYTES) {
      const chunk = Buffer.from(bytes.subarray(offset, offset + WRITE_CHUNK_BYTES)).toString("base64");
      const written = await this.#call(profile, root, ["append", path, chunk]);
      if (!written.ok) return fileFailure(written.error);
    }
    if (bytes.byteLength === 0) return await this.#simple(profile, root, ["append", path, ""], undefined);
    return { ok: true, value: undefined };
  }

  /** One request on this (profile, root)'s session. */
  async #call(profile: SshProfile, root: string, argv: readonly string[], allow?: ReadAuthorization): Promise<RemoteResult> {
    return await this.#session(profile, root).request(argv[0]!, argv.slice(1), allow, this.#controller.signal);
  }

  /**
   * The one session for this (profile, root), opening it when there is none. A session that has ended is replaced by
   * the next request, which is why a death mid-write is reported rather than papered over: the write's own session
   * object is pinned and cannot be swapped for another.
   */
  #session(profile: SshProfile, root: string): Session {
    const existing = this.#sessions.find((session) => session.matches(profile, root) && !session.closed);
    if (existing !== undefined) return existing;
    // A session that has ended is forgotten here rather than kept: the next request opens its own.
    for (let index = this.#sessions.length - 1; index >= 0; index -= 1) {
      if (this.#sessions[index]!.closed) this.#sessions.splice(index, 1);
    }
    const session = new Session(profile, root, this.#runner, ["python3", "-c", REMOTE_BOOTSTRAP, REMOTE_FILESYSTEM_BASE64, root], this.#idleMs, this.#requestTimeoutMs);
    this.#sessions.push(session);
    return session;
  }
}

/** Methods that name no target path and pass no allow list: they resolve no authorization and run no discovery. */
const NAMELESS_METHODS: readonly string[] = ["createTempDir", "createTempFile", "reader.close"];

/** Whether a request only reads: those may name a resource location as well as the workspace. */
const READ_METHODS: readonly string[] = ["readTextFile", "readBinaryFile", "fileInfo", "listDir", "canonicalPath", "exists", "openBinaryReader", "reader.info", "reader.read", "reader.scanLines"];

/**
 * The host locations one request may name. A read reaches the workspace, the execution-side resource roots and the
 * host's own resource files; every other method is confined to the workspace and may only refuse those locations, so a
 * resource path is read-only exactly as it is on the local filesystem. An unauthorized absolute path is not remapped to
 * a resource; it keeps the workspace mapping and is reported missing, so it cannot be used to probe the host.
 */
export function readAuthorization(host: ExecutionHost, method: string, agentDefinitions = false): ReadAuthorization {
  const reading = READ_METHODS.includes(method);
  const resourceRoots = host.roots.map((root: ResourceRoot) => root.path);
  const resourceFiles = [host.contextFiles, host.systemPromptFiles.map((file) => file.path), host.appendSystemPromptFiles.map((file) => file.path)].flat();
  // The agent definition directories are the one named capability that reaches outside the workspace. A read may name
  // them; a mutation may write them, so they are added to neither the read roots nor the refused locations.
  const agentRoots = agentDefinitions ? agentDefinitionRoots(host) : [];
  return {
    roots: reading ? [...resourceRoots, ...agentRoots] : [],
    files: reading ? resourceFiles : [],
    denied: reading ? [] : [...resourceRoots, ...resourceFiles],
    writes: reading ? [] : agentRoots.map((path) => ({ path, boundary: within(host.workspaceRoot, path) ? host.workspaceRoot : host.home })),
  };
}

/**
 * Whether a request names an execution-side resource location rather than a workspace path. Such a read keeps its real
 * host path in results, while a workspace read keeps the logical workspace path — the same distinction the local
 * filesystem makes, so a project resource inside the workspace is still reported at the path the host's tools use.
 */
export function isResourceRead(allow: ReadAuthorization, path: string | undefined): boolean {
  if (path === undefined || !isAbsolute(path)) return false;
  const target = resolve(path);
  return allow.roots.some((location) => within(location, target)) || allow.files.includes(target);
}

/** Whether a mutating request names one of the request's own writable agent definition directories. */
export function isAgentWrite(allow: ReadAuthorization, path: string | undefined): boolean {
  if (path === undefined || !isAbsolute(path)) return false;
  const target = resolve(path);
  return allow.writes.some((location) => within(location.path, target));
}

/**
 * A result's path: the logical workspace path inside the workspace, and the real host path outside it. A resource root
 * lives outside the workspace, and its real path is the one ordinary host tools can read (ADR 0002), so it is reported
 * as-is rather than mangled into a workspace-relative form that names no file.
 */
export function reportPath(root: string, path: string, resourceRead: boolean): string {
  return resourceRead ? path : relativePath(root, path);
}

export function reportInfo(root: string, info: FileInfo, resourceRead: boolean): FileInfo {
  return { ...info, path: reportPath(root, info.path, resourceRead) };
}

/** A remote path in any of the three accepted forms; the helper confines the result to the profile's root. */
function remotePath(root: string, path: string | undefined): string { return resolveWorkspacePath(root, path); }

/**
 * Whether a mutating request names an execution-side resource location. Both accepted forms are checked: the raw
 * absolute host path a resource lives at, and the workspace-mapped path the logical (`/.agents/skills/...`) and
 * relative (`AGENTS.md`) aliases resolve to, so an alias cannot write a resource its physical path is refused.
 */
export function mutationDenied(allow: ReadAuthorization, root: string, path: string): boolean {
  return [path, remotePath(root, path)].some((candidate) => allow.denied.some((location) => within(location, resolve(candidate))));
}

/**
 * A read path: a relative or logical path is the workspace path it always was, and an absolute path inside one of the
 * request's read locations is taken as the real host path it is. Anything else keeps the workspace mapping, so an
 * unauthorized absolute path lands inside the workspace and is reported missing rather than served.
 */
function remoteReadPath(root: string, path: string | undefined, allow: ReadAuthorization | undefined): string {
  if (path === undefined || path === "") throw new FileError("invalid", "path is required");
  if (allow !== undefined && isAbsolute(path)) {
    const target = resolve(path);
    if (allow.roots.some((allowed) => within(allowed, target)) || allow.files.includes(target)) return target;
  }
  return remotePath(root, path);
}

function toBytes(content: string | Uint8Array): Uint8Array { return typeof content === "string" ? Buffer.from(content, "utf8") : content; }

function fileErrorCode(code: string | undefined): FileErrorCode { return FILE_ERROR_CODES.includes(code as FileErrorCode) ? code as FileErrorCode : "unknown"; }
