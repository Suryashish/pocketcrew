"""The tools an agent can call, and the text protocol it calls them with.

Gemma has no reliable native function calling, so tools are requested with a
small tag syntax that also carries raw file contents without any escaping:

    <tool name="write_file" path="site/index.html">
    <!doctype html> ...
    </tool>
"""
import logging
import re
import shlex
from dataclasses import dataclass, field

from . import sandbox
from .config import settings

log = logging.getLogger("pocketcrew.tools")

TOOL_RE = re.compile(r'<tool\s+name="([a-z_]+)"([^>]*)>(.*?)(?:</tool>|\Z)', re.S)
ATTR_RE = re.compile(r'([a-z_]+)="([^"]*)"')
MAX_CALLS_PER_TURN = 6
MAX_FILE_CHARS = 200_000

# Runs inside the sandbox, so a page fetch can never reach the platform's own network.
FETCH_SCRIPT = r'''
import html.parser, re, sys, urllib.request
class Text(html.parser.HTMLParser):
    skip = 0; out = []
    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript", "svg", "head"): self.skip += 1
        if tag in ("p", "br", "div", "li", "tr", "h1", "h2", "h3", "h4"): self.out.append("\n")
    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript", "svg", "head") and self.skip: self.skip -= 1
    def handle_data(self, data):
        if not self.skip: self.out.append(data)
req = urllib.request.Request(sys.argv[1], headers={"User-Agent": "Mozilla/5.0 (compatible; PocketCrew/1.0)"})
with urllib.request.urlopen(req, timeout=20) as r:
    kind = r.headers.get("content-type", "")
    body = r.read(600_000).decode(r.headers.get_content_charset() or "utf-8", "replace")
if "html" in kind:
    p = Text(); p.feed(body); body = "".join(p.out)
print(re.sub(r"\n\s*\n+", "\n\n", re.sub(r"[ \t]+", " ", body)).strip()[:6000])
'''


@dataclass
class Call:
    name: str
    attrs: dict = field(default_factory=dict)
    body: str = ""


def instructions(has_sandbox: bool) -> str:
    """The part of the system prompt that teaches the tool protocol."""
    lines = [
        "## Tools",
        "You can act, not just talk. To use a tool, write a tool tag exactly as shown. You may put several "
        "tags in one reply; they run in order. After the tags, stop: you will receive the results and can "
        "then use more tools or answer the user. Never invent a tool result.",
        "",
        '<tool name="web_search">what to look up</tool>  Search the web. Returns titles, links and snippets.',
    ]
    if has_sandbox:
        lines += [
            '<tool name="fetch_url">https://example.com/page</tool>  Read a web page as text.',
            '<tool name="shell">command</tool>  Run a bash command on your Linux computer (Debian, Python 3, '
            "Node.js, git, curl; no root). It starts in your workspace folder, and files there are kept "
            "between conversations. Each command has 120 seconds.",
            '<tool name="write_file" path="site/index.html">file contents</tool>  Create or overwrite a '
            "file in your workspace (path relative to it). Put the raw contents between the tags, with no "
            "escaping and no code fences.",
            '<tool name="serve" directory="site"></tool>  Start a web server for a folder and get a public '
            "link the user can open. For a custom server put its start command between the tags; it must "
            "listen on 0.0.0.0 and the port in the $PORT environment variable.",
            "",
            "Rules: use tools only when they help; answer simple questions directly. When you build a web "
            "page, write the files, then call serve, then give the user the link. Use relative links between "
            'files (href="style.css", never "/style.css"). Do not start servers with shell; use serve. '
            "When you are finished, reply in plain text with no tool tags.",
        ]
    else:
        lines += ["", "Rules: search only when you need current or specific facts. When you are finished, "
                  "reply in plain text with no tool tags."]
    return "\n".join(lines)


def parse(reply: str) -> list[Call]:
    calls = []
    for name, raw_attrs, body in TOOL_RE.findall(reply):
        body = body.strip("\n")
        fenced = re.fullmatch(r"\s*```[\w+-]*\n(.*?)\n?```\s*", body, re.S)  # models like to fence file contents
        if fenced:
            body = fenced.group(1)
        calls.append(Call(name, dict(ATTR_RE.findall(raw_attrs)), body))
    return calls[:MAX_CALLS_PER_TURN]


def strip_calls(reply: str) -> str:
    """The reply without any tool tags (for a final answer that still contains some)."""
    return TOOL_RE.sub("", reply).strip()


def compact(reply: str) -> str:
    """The model's own turn, with file bodies elided so they are not sent back every step."""

    def shrink(match: re.Match) -> str:
        name, attrs, body = match.groups()
        if name == "write_file" and len(body) > 200:
            body = f"[{len(body)} characters, written]"
        return f'<tool name="{name}"{attrs}>{body}</tool>'

    return TOOL_RE.sub(shrink, reply)


def describe(call: Call) -> str:
    """One short line telling the user what the agent is doing."""
    first = (call.body.strip().splitlines() or [""])[0][:80]
    if call.name == "web_search":
        return f"🌐 Searching: {first}"
    if call.name == "fetch_url":
        return f"📖 Reading {first}"
    if call.name == "shell":
        return f"💻 Running: {first}"
    if call.name == "write_file":
        return f"📝 Writing {call.attrs.get('path', 'a file')}"
    if call.name == "serve":
        return "🚀 Starting the web server"
    return f"🔧 {call.name}"


def _search(query: str) -> str:
    if not query.strip():
        return "Error: empty search query."
    try:
        from ddgs import DDGS

        hits = DDGS().text(query.strip()[:300], max_results=5)
    except Exception as e:
        log.info("Search failed: %s", e)
        return "Error: web search is not available right now."
    if not hits:
        return "No results."
    return "\n\n".join(f"{h.get('title', '')}\n{h.get('href', '')}\n{h.get('body', '')[:300]}" for h in hits)


def execute(agent_id: int, call: Call) -> str:
    """Run one tool call and return its result as text for the model. Never raises."""
    body = call.body.strip()
    try:
        if call.name == "web_search":
            return _search(body)
        if not sandbox.available():
            return "Error: this tool needs the sandbox computer, which is not available on this server."
        if call.name == "fetch_url":
            if not re.match(r"https?://", body):
                return "Error: give a full http(s) URL."
            code, out = sandbox.run(agent_id, f"python3 - {shlex.quote(body)} <<'PY'\n{FETCH_SCRIPT}\nPY", 40)
            return out if code == 0 else f"Error: could not read that page.\n{out[-400:]}"
        if call.name == "shell":
            if not body:
                return "Error: empty command."
            code, out = sandbox.run(agent_id, body, 120)
            return f"exit code {code}\n{out}" if out else f"exit code {code} (no output)"
        if call.name == "write_file":
            if len(call.body) > MAX_FILE_CHARS:
                return "Error: that file is too large."
            path = sandbox.write_file(agent_id, call.attrs.get("path", ""), call.body + "\n")
            return f"Wrote {path} ({len(call.body)} characters)."
        if call.name == "serve":
            url = sandbox.serve(agent_id, call.attrs.get("directory", "."), body)
            return f"The server is running. Public link for the user: {url}"
        return f"Error: there is no tool called {call.name}."
    except sandbox.SandboxError as e:
        return f"Error: {e}"
    except Exception:
        log.exception("Tool %s failed", call.name)
        return "Error: the tool failed unexpectedly."


def enabled(agent) -> bool:
    return bool(settings.tools_enabled and agent.tools)
