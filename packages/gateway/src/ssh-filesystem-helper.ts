/**
 * The remote filesystem helper: a self-contained Python 3 program that serves one framed request at a time over its
 * standard streams, one session per (profile, root). It runs over the runner's interactive transport (`SshRunner.open`),
 * so the host needs Python 3 and nothing else installed, and every path it touches is confined to the profile's remote
 * root. The program text and the interpreter start are paid once per session instead of once per operation.
 *
 * The text below is a template literal, escaped in exactly one way: a backslash, a backtick and a dollar-brace are the
 * only sequences it would otherwise consume, so those are the only ones written with a backslash. Everything else is
 * the program's own bytes, one Python line per source line. `test/ssh-helper-source.test.ts` decodes the literal,
 * compiles it with Python and checks the ported engine's notice and its backslash-built patterns survived.
 *
 * Its gitignore matching — the `Ignore`, `IgnoreRule` and `RuleManager` classes, the `REPLACERS` chain that compiles a
 * pattern into a regular expression, the trailing-wildcard handling, the rule ordering with negations and the
 * parent-directory traversal — is a Python port of `node-ignore` 7.0.5 (https://github.com/kaelzhang/node-ignore), MIT,
 * Copyright (c) 2013 Kael Zhang and contributors, whose license is kept verbatim in `node-ignore.LICENSE` beside this
 * module. The port is not installed on the host and adds no dependency: the host has Python 3, not npm. It exists so the
 * helper and the loader read one grammar, and `test/ignore-parity.test.ts` requires every decision the two engines make
 * over a generated corpus to agree.
 */
export const REMOTE_FILESYSTEM_SCRIPT = `import base64, codecs, errno, fnmatch, json, os, re, shutil, stat, struct, sys, tempfile

MAX = 16 * 1024 * 1024
MAX_SNAPSHOT = 16 * 1024 * 1024
MAX_SNAPSHOT_ENTRIES = 20000
MAX_FRONTMATTER = 256 * 1024
# One session request and its answer travel as frames. The request bound is the gateway's own JSON body bound; the
# answer bound sits above the largest answer an operation can legitimately produce (base64 of MAX, and the snapshot
# envelope MAX_SNAPSHOT already caps). A frame above either bound ends the session instead of being resynchronised.
MAX_FRAME = 64 * 1024 * 1024
MAX_REQUEST = 1024 * 1024
REQUEST = 10
RESULT = 11
CLOSE = 12
IGNORE_NAMES = (".gitignore", ".ignore", ".fdignore")
UNRESOLVABLE = ("not_found", "not_directory", "permission_denied", "invalid")


class Done(Exception):
    """One request's answer. Raising unwinds out of the operation, exactly as the one-shot exit did, so a refusal deep
    inside an operation ends that request and only that request."""

    def __init__(self, payload):
        self.payload = payload


def emit(value):
    raise Done(value)


def fail(code, message, path=None):
    error = {"code": code, "message": message}
    if path is not None:
        error["path"] = path
    emit({"ok": False, "error": error})


def code_of(error):
    if isinstance(error, FileNotFoundError):
        return "not_found"
    if isinstance(error, PermissionError):
        return "permission_denied"
    if isinstance(error, NotADirectoryError):
        return "not_directory"
    if isinstance(error, IsADirectoryError):
        return "is_directory"
    if isinstance(error, OSError) and error.errno in (errno.EINVAL, errno.ELOOP, errno.ENXIO):
        return "invalid"
    return "unknown"


def lexical_within(candidate, path):
    if path == candidate:
        return True
    return path.startswith(candidate.rstrip(os.sep) + os.sep)


def confine_read(path):
    for candidate in [root] + ALLOWED_ROOTS:
        if lexical_within(candidate, path):
            if real_within(candidate, path) is None:
                fail("permission_denied", "symlink outside " + candidate)
            return
    if path in ALLOWED_FILES and os.path.realpath(path) in ALLOWED_FILES:
        return
    fail("permission_denied", "path outside workspace")


def account_of():
    try:
        import pwd
        entry = pwd.getpwuid(os.getuid())
        name = entry.pw_name
        home = entry.pw_dir
    except Exception as error:
        fail("unknown", "the remote host did not report the execution account: " + str(error))
    if not name or not home:
        fail("unknown", "the remote host reported an incomplete execution account")
    return name, home


def real_dir(path):
    try:
        real = os.path.realpath(path)
    except OSError:
        return None
    return real if os.path.isdir(real) else None


def real_file(path):
    try:
        real = os.path.realpath(path)
    except OSError:
        return None
    return real if os.path.isfile(real) else None


CONTEXT_NAMES = ("AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD")


def context_file(directory):
    for name in CONTEXT_NAMES:
        found = real_file(os.path.join(directory, name))
        if found:
            return found
    return None


def context_files(workspace, agent_dir):
    found = []
    seen = set()
    first = context_file(agent_dir)
    if first:
        seen.add(first)
        found.append(first)
    chain = []
    directory = workspace
    while True:
        current = context_file(directory)
        if current and current not in seen:
            chain.insert(0, current)
        parent = os.path.dirname(directory)
        if parent == directory:
            break
        directory = parent
    for path in chain:
        if path not in seen:
            seen.add(path)
            found.append(path)
    return found


def find_git_paths(start):
    directory = os.path.realpath(start)
    while True:
        git_path = os.path.join(directory, '.git')
        if os.path.exists(git_path):
            try:
                if os.path.isfile(git_path):
                    with open(git_path, 'r', encoding='utf-8', errors='replace') as handle:
                        content = handle.read().strip()
                    if content.startswith('gitdir: '):
                        git_dir = os.path.realpath(os.path.join(directory, content[8:].strip()))
                        if not os.path.exists(os.path.join(git_dir, 'HEAD')):
                            return None
                        common_path = os.path.join(git_dir, 'commondir')
                        if os.path.exists(common_path):
                            with open(common_path, 'r', encoding='utf-8', errors='replace') as handle:
                                common_git_dir = os.path.realpath(os.path.join(git_dir, handle.read().strip()))
                        else:
                            common_git_dir = git_dir
                        return {'repoDir': directory, 'commonGitDir': common_git_dir}
                if os.path.isdir(git_path):
                    if not os.path.exists(os.path.join(git_path, 'HEAD')):
                        return None
                    return {'repoDir': directory, 'commonGitDir': git_path}
            except OSError:
                return None
        parent = os.path.dirname(directory)
        if parent == directory:
            return None
        directory = parent


def find_shadowed_context_file(workspace):
    paths = find_git_paths(workspace)
    if paths is None:
        return None
    common_git_dir = os.path.realpath(paths['commonGitDir'])
    worktree_root = os.path.realpath(paths['repoDir'])
    main_repo_root = os.path.dirname(common_git_dir)
    if not worktree_root.startswith(main_repo_root + os.sep):
        return None
    if os.path.realpath(os.path.join(main_repo_root, '.git')) != common_git_dir:
        return None
    own = context_file(worktree_root)
    if own is None:
        return None
    return os.path.realpath(os.path.join(main_repo_root, os.path.basename(own)))

def repository_root(start):
    directory = start
    while True:
        if os.path.lexists(os.path.join(directory, ".git")):
            return directory
        parent = os.path.dirname(directory)
        if parent == directory:
            return None
        directory = parent


def resource_roots(workspace, home, agent_dir):
    roots = []
    seen = set()

    def add(path, scope, kind, trusted=False):
        real = real_dir(path)
        if real is None or real in seen:
            return
        seen.add(real)
        root = {"scope": scope, "kind": kind, "path": real}
        if trusted:
            root["requiresTrust"] = True
        roots.append(root)

    stop = repository_root(workspace)
    account_agents = os.path.realpath(os.path.join(home, ".agents", "skills"))
    add(os.path.join(workspace, ".pi", "skills"), "project", "skills", True)
    add(os.path.join(workspace, ".agents", "skills"), "project", "skills")
    directory = workspace
    while True:
        if os.path.realpath(os.path.join(directory, ".agents", "skills")) != account_agents:
            add(os.path.join(directory, ".agents", "skills"), "ancestor", "skills")
        if stop is not None and directory == stop:
            break
        parent = os.path.dirname(directory)
        if parent == directory:
            break
        directory = parent
    add(os.path.join(agent_dir, "skills"), "global", "skills")
    add(os.path.join(home, ".agents", "skills"), "global", "skills")
    add(os.path.join(workspace, ".pi", "prompts"), "project", "prompts", True)
    add(os.path.join(agent_dir, "prompts"), "global", "prompts")
    return roots


def prompt_files(workspace, agent_dir, name):
    files = []
    global_file = real_file(os.path.join(agent_dir, name))
    if global_file:
        files.append({"scope": "global", "path": global_file})
    project_file = real_file(os.path.join(workspace, ".pi", name))
    if project_file:
        files.append({"scope": "project", "path": project_file})
    return files


def discovery():
    name, raw_home = account_of()
    home = os.path.realpath(raw_home)
    agent_dir = os.path.join(home, '.pi', 'agent')
    result = {
        'user': name,
        'home': home,
        'workspaceRoot': root,
        'agentDir': agent_dir,
        'roots': resource_roots(root, home, agent_dir),
        'contextFiles': context_files(root, agent_dir),
        'systemPromptFiles': prompt_files(root, agent_dir, 'SYSTEM.md'),
        'appendSystemPromptFiles': prompt_files(root, agent_dir, 'APPEND_SYSTEM.md'),
    }
    shadowed = find_shadowed_context_file(root)
    if shadowed is not None:
        result['shadowedContextFile'] = shadowed
    return result

def real_within(root, path):
    real = os.path.realpath(path)
    if real == root or real.startswith(root + os.sep):
        return real
    return None


def writable_within(path):
    for entry in ALLOWED_WRITES:
        candidate = entry.get("path")
        boundary = entry.get("boundary")
        if candidate is None or boundary is None or not lexical_within(candidate, path):
            continue
        head = path
        while True:
            if os.path.lexists(head):
                real = os.path.realpath(head)
                if not lexical_within(boundary, real):
                    return False
                if lexical_within(candidate, head) and not lexical_within(candidate, real):
                    return False
                return True
            parent = os.path.dirname(head)
            if parent == head:
                return False
            head = parent
    return False


def confine(root, path):
    if writable_within(path):
        return
    if os.path.lexists(path):
        if real_within(root, path) is None:
            fail("permission_denied", "path outside workspace")
        return
    head = os.path.dirname(path)
    while True:
        if os.path.lexists(head):
            if real_within(root, head) is None:
                fail("permission_denied", "path outside workspace")
            return
        parent = os.path.dirname(head)
        if parent == head:
            fail("permission_denied", "path outside workspace")
        head = parent


def kind_of(mode):
    if stat.S_ISREG(mode):
        return "file"
    if stat.S_ISDIR(mode):
        return "directory"
    if stat.S_ISLNK(mode):
        return "symlink"
    return "other"


def info_of(path, st):
    return {
        "name": os.path.basename(path),
        "path": path,
        "kind": kind_of(st.st_mode),
        "size": st.st_size,
        "mtimeMs": st.st_mtime * 1000.0,
    }


def regular(path):
    """The gateway's own read bound, in the gateway's own words: a read checks this itself, so no separate size
    pre-check has to run before it and no caller sees a different refusal than it did."""
    st = os.stat(path)
    kind = kind_of(st.st_mode)
    if kind == "directory":
        fail("is_directory", "Not a regular file", path)
    if kind != "file":
        fail("invalid", "Not a regular file", path)
    if st.st_size > MAX:
        fail("invalid", "file is " + str(st.st_size) + " bytes; the gateway limit is " + str(MAX) + " bytes", path)
    return st


def identity(path, dev, ino):
    confine_read(path)
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError as error:
        fail(code_of(error), str(error))
    st = os.fstat(fd)
    if st.st_dev != dev or st.st_ino != ino:
        os.close(fd)
        fail("invalid", "file changed since the reader was opened")
    return fd


def decoder():
    return codecs.getincrementaldecoder("utf-8")(errors="replace")


def decoded_bytes(text):
    return len(text.encode("utf-8"))


class Scanner:
    def __init__(self, start_line, end_line):
        self.start_line = start_line
        self.end_line = end_line
        self.position = 0
        self.newlines = 0
        self.line_start = 0
        self.start = None
        self.end = None
        self.first_line_end = None
        self.last_line_start = None
        self.selected_bytes = 0
        self.first_line_bytes = 0
        self.selection = None
        self.first_line = None
        self.head = bytearray()
        self.bom = False
        if start_line == 0:
            self.begin(0)

    def push(self, chunk):
        if self.head is not None:
            take = min(3 - len(self.head), len(chunk))
            self.head += chunk[:take]
            if len(self.head) < 3:
                return
            head = bytes(self.head)
            self.head = None
            self.bom = head[:3] == b"\\xef\\xbb\\xbf"
            self.process(head)
            chunk = chunk[take:]
        self.process(chunk)

    def process(self, chunk):
        base = self.position
        start = 0
        index = chunk.find(b"\\n")
        while index != -1:
            self.feed(chunk, base, start, index)
            position = base + index
            if self.newlines == self.start_line:
                self.end_first_line(position)
            if self.newlines == self.end_line - 1:
                self.end_selection(position)
            self.feed(chunk, base, index, index + 1)
            start = index + 1
            self.newlines += 1
            self.line_start = position + 1
            if self.newlines == self.start_line:
                self.begin(self.line_start)
            if self.newlines == self.end_line - 1:
                self.last_line_start = self.line_start
            index = chunk.find(b"\\n", index + 1)
        self.feed(chunk, base, start, len(chunk))
        self.position += len(chunk)

    def feed(self, chunk, base, start, end):
        if self.bom and base + start < 3:
            start = min(end, 3 - base)
        if end <= start:
            return
        data = chunk[start:end]
        if self.selection is not None:
            self.selected_bytes += decoded_bytes(self.selection.decode(data))
        if self.first_line is not None:
            self.first_line_bytes += decoded_bytes(self.first_line.decode(data))

    def begin(self, start):
        self.start = start
        if self.start_line == self.end_line - 1:
            self.last_line_start = start
        self.selection = decoder()
        self.first_line = decoder()

    def end_first_line(self, position):
        self.first_line_end = position
        if self.first_line is not None:
            self.first_line_bytes += decoded_bytes(self.first_line.decode(b"", True))
        self.first_line = None

    def end_selection(self, position):
        self.end = position
        if self.selection is not None:
            self.selected_bytes += decoded_bytes(self.selection.decode(b"", True))
        self.selection = None

    def finish(self):
        if self.head is not None:
            head = bytes(self.head)
            self.head = None
            self.bom = head[:3] == b"\\xef\\xbb\\xbf"
            self.process(head)
        size = self.position
        if self.start is None:
            return {
                "newlines": self.newlines,
                "start": size,
                "end": size,
                "firstLineEnd": size,
                "lastLineStart": size,
                "selectedBytes": 0,
                "firstLineBytes": 0,
            }
        if self.first_line_end is None:
            self.end_first_line(size)
        if self.end is None:
            self.end_selection(size)
        return {
            "newlines": self.newlines,
            "start": self.start,
            "end": size if self.end is None else self.end,
            "firstLineEnd": size if self.first_line_end is None else self.first_line_end,
            "lastLineStart": self.line_start if self.last_line_start is None else self.last_line_start,
            "selectedBytes": self.selected_bytes,
            "firstLineBytes": self.first_line_bytes,
        }

def skill_head(text, complete, path):
    match = re.match(r"^---\\r?\\n[\\s\\S]*?\\r?\\n---", text)
    if match is not None:
        return {"text": match.group(0)}
    if text.startswith("---") and not complete:
        return {"failure": {"code": "invalid", "message": "execution-side skill " + path + " does not end its frontmatter within " + str(MAX_FRONTMATTER) + " bytes"}}
    return {"text": text}


def failure_of(error):
    return {"code": code_of(error), "message": str(error)}


def snapshot_text(real, read):
    try:
        st = os.stat(real)
    except OSError as error:
        return {"failure": failure_of(error)}
    if not stat.S_ISREG(st.st_mode):
        return None
    if st.st_size > MAX:
        return {"failure": {"code": "invalid", "message": "file is " + str(st.st_size) + " bytes; the gateway limit is " + str(MAX) + " bytes"}}
    if read == "whole":
        try:
            with open(real, "r", encoding="utf-8", errors="replace") as handle:
                return {"text": handle.read()}
        except OSError as error:
            return {"failure": failure_of(error)}
    length = min(st.st_size, MAX_FRONTMATTER)
    try:
        with open(real, "rb") as handle:
            head = handle.read(length)
    except OSError as error:
        return {"failure": failure_of(error)}
    return skill_head(head.decode("utf-8", "replace"), st.st_size <= MAX_FRONTMATTER, real)


# The gitignore engine below is a port of \`node-ignore@7.0.5\` (\`index.js\`, MIT, Kael Zhang and contributors), which the
# resource loader and the local snapshot producer match with. The SSH helper matches with this port, so both producers
# read one grammar instead of one reading a subset of the other's. It is the same REPLACERS chain, the same
# trailing-wildcard handling, the same rule ordering with negations, and the same parent-directory traversal.
#
# The port is pinned by a differential test (\`packages/gateway/test/ignore-parity.test.ts\`) that runs both engines over
# a generated corpus of patterns and paths and requires every decision to agree, and by the real-sshd tests that require
# the two producers to answer the same snapshot.
# A port of \`node-ignore@7.0.5\` (\`index.js\`, MIT, Kael Zhang and contributors) to Python: the same REPLACERS chain
# that turns one gitignore pattern into a regular expression, the same trailing-wildcard handling, the same rule
# ordering with negations, and the same parent-directory traversal. The loader and the local producer match with
# \`node-ignore\` itself; the SSH helper matches with this, so both producers read one grammar rather than one reading
# a subset of the other's. Nothing here is a re-interpretation of gitignore: it is the same transformation.

import re

_TEST_BLANK_LINE = re.compile(r'^\\s+$')
_TEST_INVALID_TRAILING_BACKSLASH = re.compile(r'(?:[^\\\\]|^)\\\\$')
_TEST_INVALID_PATH = re.compile(r'^\\.{0,2}/|^\\.{1,2}$')
_TEST_TRAILING_SLASH = re.compile(r'/$')
_RANGE = re.compile(r'([0-z])-([0-z])')
_LEADING_ESCAPED_EXCLAMATION = re.compile(r'^\\\\!')
_LEADING_ESCAPED_HASH = re.compile(r'^\\\\#')


def _sanitize_range(match):
    start, end = match.group(1), match.group(2)
    return match.group(0) if ord(start[0]) <= ord(end[0]) else ''


def _clean_range_backslash(slashes):
    return slashes[: len(slashes) - len(slashes) % 2]


def _replacer_bom(match):
    return ''


def _replacer_trailing_spaces(match):
    return match.group(1) + (' ' if match.group(2).startswith('\\\\') else '')


def _replacer_spaces(match):
    slashes = match.group(1)
    return slashes[: len(slashes) - len(slashes) % 2] + ' '


def _replacer_metacharacters(match):
    return '\\\\' + match.group(0)


def _replacer_question(match):
    return '[^/]'


def _replacer_leading_slash(match):
    return '^'


def _replacer_slash(match):
    return '\\\\/'


def _replacer_leading_globstar(match):
    return '^(?:.*\\\\/)?'


_ORIGINAL_PATTERN = ['']


def _replacer_starting(match):
    # \`node-ignore\` binds \`this\` to the original pattern for this replacer, so the separator test is over the
    # pattern as it was written, not over the intermediate string this step is editing.
    return '^' if re.search(r'/(?!$)', _ORIGINAL_PATTERN[0]) else '(?:^|\\\\/)'


def _replacer_globstars(match):
    return '(?:\\\\/[^\\\\/]+)*' if match.start() + 6 < len(match.string) else '\\\\/.+'


def _replacer_wildcards(match):
    return match.group(1) + match.group(2).replace('\\\\*', '[^\\\\/]*')


def _replacer_unescape(match):
    return '\\\\'


def _replacer_backslash(match):
    return '\\\\'


def _replacer_range(match):
    lead_escape, body, end_escape, close = match.group(1), match.group(2), match.group(3), match.group(4)
    if lead_escape == '\\\\':
        return '\\\\[' + body + _clean_range_backslash(end_escape) + close
    if close == ']' and len(end_escape) % 2 == 0:
        return '[' + _RANGE.sub(_sanitize_range, body) + end_escape + ']'
    return '[]'


def _replacer_ending(match):
    text = match.group(0)
    return text + '$' if _TEST_TRAILING_SLASH.search(text) else text + '(?=$|\\\\/$)'


# (pattern, replacement, global) in the order \`node-ignore\` applies them. A non-global entry replaces only the first
# match, as \`String.prototype.replace\` does for a regular expression without the \`g\` flag.
REPLACERS = (
    (re.compile('\\ufeff'), _replacer_bom, False),
    (re.compile(r'((?:\\\\\\\\)*?)(\\\\?\\s+)$'), _replacer_trailing_spaces, False),
    (re.compile(r'(\\\\+?)\\s'), _replacer_spaces, True),
    (re.compile(r'[\\\\$.|*+(){^]'), _replacer_metacharacters, True),
    (re.compile(r'(?!\\\\)\\?'), _replacer_question, True),
    (re.compile(r'^/'), _replacer_leading_slash, False),
    (re.compile(r'/'), _replacer_slash, True),
    (re.compile(r'^\\^*\\\\\\*\\\\\\*\\\\/'), _replacer_leading_globstar, False),
    (re.compile(r'^(?=[^^])'), _replacer_starting, False),
    (re.compile(r'\\\\/\\\\\\*\\\\\\*(?=\\\\/|$)'), _replacer_globstars, True),
    (re.compile(r'(^|[^\\\\]+)(\\\\\\*)+(?=.+)'), _replacer_wildcards, True),
    (re.compile(r'\\\\\\\\\\\\(?=[$.|*+(){^])'), _replacer_unescape, True),
    (re.compile(r'\\\\\\\\'), _replacer_backslash, True),
    (re.compile(r'(\\\\)?\\[([^\\]/]*?)(\\\\*)($|\\])'), _replacer_range, True),
    (re.compile(r'(?:[^*])$'), _replacer_ending, False),
)

_REPLACE_TRAILING_WILDCARD = re.compile(r'(^|\\\\/)?\\\\\\*$')


def _apply(pattern, matcher, replacer, global_):
    return matcher.sub(replacer, pattern) if global_ else matcher.sub(replacer, pattern, count=1)


def _make_regex_prefix(pattern):
    _ORIGINAL_PATTERN[0] = pattern
    prefix = pattern
    for matcher, replacer, global_ in REPLACERS:
        prefix = _apply(prefix, matcher, replacer, global_)
    return prefix


def _trailing_wildcard(match):
    if match.group(1):
        return match.group(1) + '[^/]+(?=$|\\\\/$)'
    return '[^/]*(?=$|\\\\/$)'


def _python_safe(expression):
    """The same expression in Python's regular-expression dialect.

    Two shapes \`node-ignore\` emits are valid JavaScript and not valid Python, both from a malformed pattern: \`[]\` is
    an empty class that matches nothing in JavaScript, and a \`]\` outside a class is a literal there. They are
    translated rather than refused, so a rule that means the same thing on both sides still does.
    """
    expression = expression.replace("[]", "(?!)")
    out = []
    in_class = False
    for character in expression:
        if in_class:
            if character == "]":
                in_class = False
        elif character == "[":
            in_class = True
        elif character == "]":
            out.append("\\\\]")
            continue
        out.append(character)
    return "".join(out)


class IgnoreRule:
    def __init__(self, pattern, negative, regex_prefix, ignore_case):
        self.pattern = pattern
        self.negative = negative
        source = _python_safe(_REPLACE_TRAILING_WILDCARD.sub(_trailing_wildcard, regex_prefix, count=1))
        self.regex = re.compile(source, re.IGNORECASE if ignore_case else 0)


def check_pattern(pattern):
    return bool(pattern) and isinstance(pattern, str) \\
        and not _TEST_BLANK_LINE.search(pattern) \\
        and not _TEST_INVALID_TRAILING_BACKSLASH.search(pattern) \\
        and not pattern.startswith('#')


def create_rule(pattern, ignore_case):
    negative = False
    body = pattern
    if body.startswith('!'):
        negative = True
        body = body[1:]
    body = _LEADING_ESCAPED_EXCLAMATION.sub('!', body)
    body = _LEADING_ESCAPED_HASH.sub('#', body)
    return IgnoreRule(pattern, negative, _make_regex_prefix(body), ignore_case)


def check_path(path):
    return bool(path) and isinstance(path, str) and not _TEST_INVALID_PATH.search(path)


class Ignore:
    """The \`Ignore\` surface the producers use: \`add(patterns)\` and \`ignores(path)\`, with \`node-ignore\`'s defaults."""

    def __init__(self, ignore_case=True):
        self._ignore_case = ignore_case
        self._rules = []
        self._cache = {}

    def add(self, patterns):
        for pattern in patterns:
            if check_pattern(pattern):
                self._rules.append(create_rule(pattern, self._ignore_case))
        self._cache = {}
        return self

    def _test(self, path, check_unignored):
        ignored = False
        unignored = False
        for rule in self._rules:
            negative = rule.negative
            if (unignored == negative and ignored != unignored) or (negative and not ignored and not unignored and not check_unignored):
                continue
            if not rule.regex.search(path):
                continue
            ignored = not negative
            unignored = negative
        return ignored

    def _t(self, path, slices, check_unignored):
        if path in self._cache:
            return self._cache[path]
        if slices is None:
            slices = [part for part in path.split('/') if part]
        slices.pop()
        if not slices:
            self._cache[path] = self._test(path, check_unignored)
            return self._cache[path]
        parent = self._t('/'.join(slices) + '/', slices, check_unignored)
        # > It is not possible to re-include a file if a parent directory of that file is excluded.
        self._cache[path] = parent if parent else self._test(path, check_unignored)
        return self._cache[path]

    def ignores(self, path):
        if not check_path(path):
            return False
        return self._t(path, None, False)


def ignore_pattern(line, prefix):
    """One ignore file line as a root-relative pattern, or None when the line is blank or a comment. Mirrors
    \`ignorePattern\` in \`packages/gateway/src/resource-ignore.ts\`: one reading of the prefixing step, in both languages."""
    trimmed = line.strip()
    if not trimmed:
        return None
    if trimmed.startswith('#') and not trimmed.startswith('\\\\#'):
        return None
    pattern = line
    negated = False
    if pattern.startswith('!'):
        negated = True
        pattern = pattern[1:]
    elif pattern.startswith('\\\\!'):
        pattern = pattern[1:]
    if pattern.startswith('/'):
        pattern = pattern[1:]
    prefixed = prefix + pattern if prefix else pattern
    return '!' + prefixed if negated else prefixed


def ignore_rules(text, prefix):
    patterns = []
    for line in text.splitlines():
        pattern = ignore_pattern(line, prefix)
        if pattern is not None:
            patterns.append(pattern)
    return patterns


def resource_snapshot():
    host = discovery()
    directories = []
    files = {}
    total = [0]
    counts = [0]

    def spend(value):
        total[0] += len(json.dumps(value, ensure_ascii=False).encode("utf-8")) + 1
        if total[0] > MAX_SNAPSHOT:
            fail("invalid", "the execution-side resource snapshot exceeds " + str(MAX_SNAPSHOT) + " bytes")

    spend(host)
    def unreadable(path, real, code, message):
        item = {"path": path, "real": real, "failure": {"code": code, "message": message}}
        spend(item)
        directories.append(item)

    def take(path, read):
        existing = files.get(path)
        if existing is not None and existing["read"] == read:
            return
        real = os.path.realpath(path)
        found = snapshot_text(real, read)
        if found is None:
            return
        if found.get("failure", {}).get("code") == "not_found":
            return
        item = {"path": path, "real": real, "read": read}
        item.update(found)
        spend(item)
        files[path] = item

    def ignore_files(directory, prefix, matcher):
        for name in IGNORE_NAMES:
            path = os.path.join(directory, name)
            if not os.path.isfile(path):
                continue
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as handle:
                    text = handle.read()
            except OSError as error:
                item = {"path": path, "real": os.path.realpath(path), "read": "whole", "failure": failure_of(error)}
                spend(item)
                files[path] = item
                continue
            matcher.add(ignore_rules(text, prefix))
            item = {"path": path, "real": os.path.realpath(path), "read": "whole", "text": text}
            spend(item)
            files[path] = item

    def walk(directory, root_path, kind, ancestors, matcher):
        try:
            real = os.path.realpath(directory, strict=True)
        except OSError as error:
            if code_of(error) in UNRESOLVABLE:
                return
            fail(code_of(error), str(error))
        if real in ancestors:
            return
        try:
            own = os.stat(real)
        except OSError as error:
            unreadable(directory, real, code_of(error), str(error))
            return
        if not stat.S_ISDIR(own.st_mode):
            unreadable(directory, real, "not_directory", directory + " is not a directory")
            return
        visited = set(ancestors)
        visited.add(real)
        try:
            names = sorted(os.listdir(directory))
        except OSError as error:
            unreadable(directory, real, code_of(error), str(error))
            return
        relative_dir = os.path.relpath(directory, root_path)
        prefix = "" if relative_dir == "." else relative_dir + "/"
        ignore_files(directory, prefix, matcher)
        entries = []
        for name in names:
            if name.startswith(".") or name == "node_modules":
                continue
            path = os.path.join(directory, name)
            try:
                link = os.lstat(path)
            except OSError as error:
                unreadable(directory, real, code_of(error), str(error))
                return
            link_kind = kind_of(link.st_mode)
            if link_kind == "other":
                continue
            target = os.path.realpath(path)
            try:
                target_kind = kind_of(os.stat(target).st_mode)
            except OSError:
                target_kind = "missing"
            counts[0] += 1
            if counts[0] > MAX_SNAPSHOT_ENTRIES:
                fail("invalid", "the execution-side resource snapshot exceeds " + str(MAX_SNAPSHOT_ENTRIES) + " entries")
            entries.append({"info": info_of(path, link), "real": target, "realKind": target_kind})
        readable = {"path": directory, "real": real, "entries": entries}
        spend(readable)
        directories.append(readable)
        terminal = kind == "skills" and any(entry["info"]["name"] == "SKILL.md" for entry in entries)
        for entry in entries:
            if not lexical_within(root_path, entry["real"]):
                continue
            logical = entry["info"]["path"]
            if terminal and entry["info"]["name"] != "SKILL.md":
                continue
            relative_path = os.path.relpath(logical, root_path)
            if matcher.ignores(relative_path + ("/" if entry["realKind"] == "directory" else "")):
                continue
            if terminal:
                take(logical, "frontmatter")
                continue
            if entry["realKind"] == "directory":
                if kind == "skills":
                    walk(logical, root_path, kind, visited, matcher)
                continue
            if entry["realKind"] != "file" or not entry["info"]["name"].endswith(".md"):
                continue
            take(logical, "frontmatter" if kind == "skills" else "whole")
    for item in host["roots"]:
        walk(item["path"], item["path"], item["kind"], set(), Ignore())
    for path in host["contextFiles"]:
        take(path, "whole")
    for key in ("systemPromptFiles", "appendSystemPromptFiles"):
        for item in host.get(key) or []:
            take(item["path"], "whole")
    snapshot = {"host": host, "directories": directories, "files": list(files.values())}
    if len(json.dumps({"ok": True, "value": snapshot}).encode("utf-8")) > MAX_SNAPSHOT:
        fail("invalid", "the execution-side resource snapshot exceeds " + str(MAX_SNAPSHOT) + " bytes")
    return snapshot

root = os.path.realpath(sys.argv[1])
ALLOWED_ROOTS = []
ALLOWED_FILES = set()
ALLOWED_WRITES = []
STAGING = []


def dispatch(mode, args):
    try:
        if mode == "info":
            path = args[0]
            confine_read(path)
            emit({"ok": True, "value": info_of(path, os.lstat(path))})
        elif mode == "list":
            path = args[0]
            confine_read(path)
            entries = []
            for name in os.listdir(path):
                entry = os.path.join(path, name)
                try:
                    entries.append(info_of(entry, os.lstat(entry)))
                except FileNotFoundError:
                    continue
            emit({"ok": True, "value": entries})
        elif mode == "canonical":
            path = args[0]
            confine_read(path)
            emit({"ok": True, "value": os.path.realpath(path, strict=True)})
        elif mode == "exists":
            path = args[0]
            if not os.path.lexists(path):
                emit({"ok": True, "value": False})
            confine_read(path)
            emit({"ok": True, "value": True})
        elif mode == "read_text":
            path = args[0]
            confine_read(path)
            regular(path)
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                emit({"ok": True, "value": handle.read()})
        elif mode == "read_binary":
            path = args[0]
            confine_read(path)
            regular(path)
            with open(path, "rb") as handle:
                emit({"ok": True, "value": base64.b64encode(handle.read()).decode("ascii")})
        elif mode == "open_reader":
            path = args[0]
            no_follow = args[1] == "1"
            confine_read(path)
            if no_follow and os.path.islink(path):
                fail("invalid", "Refusing to follow a symbolic link")
            regular(path)
            flags = os.O_RDONLY | (os.O_NOFOLLOW if no_follow and hasattr(os, "O_NOFOLLOW") else 0)
            fd = os.open(path, flags)
            st = os.fstat(fd)
            os.close(fd)
            emit({"ok": True, "value": {"path": path, "size": st.st_size, "mtimeMs": st.st_mtime * 1000.0, "dev": st.st_dev, "ino": st.st_ino}})
        elif mode == "reader_info":
            path, dev, ino = args[0], int(args[1]), int(args[2])
            fd = identity(path, dev, ino)
            st = os.fstat(fd)
            os.close(fd)
            emit({"ok": True, "value": info_of(path, st)})
        elif mode == "reader_read":
            path, dev, ino, offset, length = args[0], int(args[1]), int(args[2]), int(args[3]), int(args[4])
            fd = identity(path, dev, ino)
            try:
                data = os.pread(fd, length, offset)
            finally:
                os.close(fd)
            emit({"ok": True, "value": base64.b64encode(data).decode("ascii")})
        elif mode == "reader_scan":
            path, dev, ino, start_line = args[0], int(args[1]), int(args[2]), int(args[3])
            end_line = None if args[4] == "-1" else int(args[4])
            if start_line < 0 or (end_line is not None and end_line <= start_line):
                fail("invalid", "Invalid line range")
            fd = identity(path, dev, ino)
            scanner = Scanner(start_line, float("inf") if end_line is None else end_line)
            try:
                position = 0
                while True:
                    chunk = os.pread(fd, 65536, position)
                    if not chunk:
                        break
                    scanner.push(chunk)
                    position += len(chunk)
            finally:
                os.close(fd)
            emit({"ok": True, "value": scanner.finish()})
        elif mode == "write_begin":
            path = args[0]
            confine(root, path)
            parent = os.path.dirname(path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(path, "wb"):
                pass
            STAGING.append(path)
            emit({"ok": True})
        elif mode == "write_chunk" or mode == "append":
            path = args[0]
            data = base64.b64decode(args[1], validate=True)
            confine(root, path)
            if mode == "append":
                parent = os.path.dirname(path)
                if parent:
                    os.makedirs(parent, exist_ok=True)
            with open(path, "ab") as handle:
                handle.write(data)
            emit({"ok": True})
        elif mode == "write_commit":
            source, destination = args[0], args[1]
            confine(root, source)
            confine(root, destination)
            os.replace(source, destination)
            if source in STAGING:
                STAGING.remove(source)
            emit({"ok": True})
        elif mode == "write_abort":
            path = args[0]
            confine(root, path)
            try:
                os.remove(path)
            except FileNotFoundError:
                pass
            if path in STAGING:
                STAGING.remove(path)
            emit({"ok": True})
        elif mode == "truncate":
            path, size = args[0], int(args[1])
            confine(root, path)
            regular(path)
            os.truncate(path, size)
            emit({"ok": True})
        elif mode == "flush":
            path = args[0]
            confine(root, path)
            handle = os.open(path, os.O_RDWR)
            try:
                if stat.S_ISDIR(os.fstat(handle).st_mode):
                    fail("is_directory", "Is a directory")
                os.fsync(handle)
            finally:
                os.close(handle)
            emit({"ok": True})
        elif mode == "rename":
            source, destination = args[0], args[1]
            confine(root, source)
            confine(root, destination)
            if len(args) > 2 and args[2] == "1" and os.path.lexists(destination) and not os.path.islink(destination):
                os.chmod(source, stat.S_IMODE(os.lstat(destination).st_mode))
            os.rename(source, destination)
            emit({"ok": True})
        elif mode == "remove":
            path = args[0]
            recursive = args[1] == "1"
            force = args[2] == "1"
            if force and not os.path.lexists(path):
                emit({"ok": True})
            confine(root, path)
            try:
                if recursive and os.path.isdir(path) and not os.path.islink(path):
                    shutil.rmtree(path)
                else:
                    os.remove(path)
            except FileNotFoundError:
                if not force:
                    raise
            emit({"ok": True})
        elif mode == "mkdir":
            path = args[0]
            recursive = args[1] == "1"
            confine(root, path)
            if recursive:
                os.makedirs(path, exist_ok=True)
            else:
                os.mkdir(path)
            emit({"ok": True})
        elif mode == "tmpdir":
            prefix = args[0] or "tmp-"
            emit({"ok": True, "value": tempfile.mkdtemp(prefix=prefix, dir=root)})
        elif mode == "tmpfile":
            prefix = args[0] or "tmp-"
            suffix = args[1]
            fd, path = tempfile.mkstemp(prefix=prefix, suffix=suffix, dir=root)
            os.close(fd)
            emit({"ok": True, "value": path})
        elif mode == "snapshot":
            emit({"ok": True, "value": resource_snapshot()})
        elif mode == "discover":
            emit({"ok": True, "value": discovery()})
        else:
            fail("not_supported", "unknown remote filesystem operation: " + mode)
    except OSError as error:
        fail(code_of(error), str(error))
    except ValueError as error:
        fail("invalid", str(error))


def read_exact(stream, count):
    data = b""
    while len(data) < count:
        chunk = stream.read(count - len(data))
        if not chunk:
            return None
        data += chunk
    return data


def send(kind, payload):
    sys.stdout.buffer.write(struct.pack(">BI", kind, len(payload)) + payload)
    sys.stdout.buffer.flush()


def answer(value):
    data = json.dumps(value).encode("utf-8")
    if len(data) > MAX_FRAME:
        data = json.dumps({"ok": False, "error": {"code": "invalid", "message": "the remote filesystem result exceeds " + str(MAX_FRAME) + " bytes"}}).encode("utf-8")
    send(RESULT, data)


def serve():
    """One request frame in, one result frame out, until the gateway closes the session or its pipe ends. The session
    carries its own root, so a request cannot name a different one, and every operation still confines itself."""
    while True:
        header = read_exact(sys.stdin.buffer, 5)
        if header is None:
            return
        kind, length = struct.unpack(">BI", header)
        if kind != REQUEST or length > MAX_REQUEST:
            answer({"ok": False, "error": {"code": "invalid", "message": "the remote filesystem request exceeds " + str(MAX_REQUEST) + " bytes"}})
            return
        payload = read_exact(sys.stdin.buffer, length) if length else b""
        if payload is None:
            return
        try:
            frame = json.loads(payload)
            claimed = frame.get("root")
            if claimed is None or os.path.realpath(claimed) != root:
                fail("permission_denied", "path outside workspace")
            allow = frame.get("allow") or {}
            global ALLOWED_ROOTS, ALLOWED_FILES, ALLOWED_WRITES
            ALLOWED_ROOTS = allow.get("roots") or []
            ALLOWED_FILES = set(allow.get("files") or [])
            ALLOWED_WRITES = allow.get("writes") or []
            dispatch(frame.get("mode"), frame.get("args") or [])
        except Done as done:
            answer(done.payload)
        except OSError as error:
            answer({"ok": False, "error": {"code": code_of(error), "message": str(error)}})
        except ValueError as error:
            answer({"ok": False, "error": {"code": "invalid", "message": str(error)}})


try:
    serve()
finally:
    # Only the staging files this session created, by path, and only on a graceful end: a session that was killed leaves
    # its residue where it is, because it is not a later session's file to remove.
    for path in STAGING:
        try:
            os.remove(path)
        except OSError:
            pass
`;
