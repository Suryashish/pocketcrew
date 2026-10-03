import pytest

from app import brain, sandbox, tools
from app.config import settings


@pytest.fixture
def with_tools(monkeypatch):
    """Tools switched on, with the sandbox replaced by a recorder."""
    ran = []
    monkeypatch.setattr(settings, "tools_enabled", True)
    monkeypatch.setattr(sandbox, "available", lambda: True)

    def fake(agent_id, call):
        ran.append((call.name, call.attrs, call.body))
        if call.name == "serve":
            return "The server is running. Public link for the user: http://crew.test/p/tok/"
        return f"done {call.name}"

    monkeypatch.setattr(tools, "execute", fake)
    return ran


def test_parse_reads_tags_attributes_and_raw_file_bodies():
    reply = (
        'Sure.\n<tool name="write_file" path="site/index.html">\n<!doctype html>\n<h1 class="x">Hi & bye</h1>\n</tool>\n'
        '<tool name="write_file" path="site/app.js">\n```js\nconsole.log("a < b");\n```\n</tool>\n'
        '<tool name="serve" directory="site"></tool>'
    )
    calls = tools.parse(reply)
    assert [c.name for c in calls] == ["write_file", "write_file", "serve"]
    assert calls[0].attrs == {"path": "site/index.html"} and calls[0].body == '<!doctype html>\n<h1 class="x">Hi & bye</h1>'
    assert calls[1].body == 'console.log("a < b");'  # the code fence is unwrapped
    assert calls[2].attrs == {"directory": "site"}
    assert tools.parse("Just an answer, no tools.") == []
    assert tools.parse('<tool name="shell">ls -la')[0].body == "ls -la"  # missing close tag still works


def test_compact_elides_file_bodies_but_keeps_commands():
    reply = '<tool name="write_file" path="a.html">' + "x" * 500 + '</tool><tool name="shell">ls</tool>'
    small = tools.compact(reply)
    assert "x" * 50 not in small and "[500 characters, written]" in small and ">ls</tool>" in small


def test_agent_loop_runs_tools_then_answers(client, user, gemma, with_tools):
    agent_id = client.get("/api/agents").json()[0]["id"]
    gemma.answers = [
        '<tool name="write_file" path="site/index.html"><h1>Cafe</h1></tool>\n<tool name="serve" directory="site"></tool>',
        "Your page is live.",
    ]
    r = client.post(f"/api/agents/{agent_id}/chat", json={"message": "build me a cafe page"}).json()
    assert [name for name, _, _ in with_tools] == ["write_file", "serve"]
    assert r["steps"] == ["📝 Writing site/index.html", "🚀 Starting the web server"]
    # the model forgot the link, so it is appended for the user
    assert r["reply"] == "Your page is live.\n\nOpen it here: http://crew.test/p/tok/"
    assert "## Tools" in gemma.calls[0]["system"] and "write_file" in gemma.calls[0]["system"]
    second = gemma.calls[1]["messages"]
    assert second[-1]["role"] == "user" and '<result tool="serve">' in second[-1]["content"]
    # only the question and the final answer are remembered, not the tool chatter
    history = client.get(f"/api/agents/{agent_id}/chat").json()
    assert [m["role"] for m in history] == ["user", "assistant"]


def test_agent_loop_stops_after_the_step_limit(client, user, gemma, with_tools, monkeypatch):
    monkeypatch.setattr(settings, "max_tool_steps", 2)
    agent_id = client.get("/api/agents").json()[0]["id"]
    gemma.answers = ['<tool name="shell">ls</tool>', '<tool name="shell">ls</tool>', 'All done. <tool name="shell">ls</tool>']
    r = client.post(f"/api/agents/{agent_id}/chat", json={"message": "loop forever"}).json()
    assert len(with_tools) == 2 and r["reply"] == "All done."
    assert "Stop using tools now" in gemma.calls[2]["messages"][-1]["content"]


def test_agents_with_tools_switched_off_never_see_them(client, user, gemma, with_tools):
    agent = client.get("/api/agents").json()[0]
    assert agent["tools"] is True
    client.patch(f"/api/agents/{agent['id']}", json={"name": agent["name"], "tools": False})
    gemma.answers = ['<tool name="shell">rm -rf /</tool>']
    client.post(f"/api/agents/{agent['id']}/chat", json={"message": "hi"})
    assert with_tools == [] and "## Tools" not in gemma.calls[0]["system"]


def test_tools_degrade_politely_without_a_sandbox(monkeypatch):
    monkeypatch.setattr(settings, "tools_enabled", True)
    monkeypatch.setattr(sandbox, "available", lambda: False)
    assert "not available" in tools.execute(1, tools.Call("shell", {}, "ls"))
    assert "no tool called" in tools.execute(1, tools.Call("teleport", {}, "x")) or "not available" in tools.execute(1, tools.Call("teleport", {}, "x"))
    assert "shell" not in tools.instructions(False) and "web_search" in tools.instructions(False)


def test_preview_requires_a_valid_token(client):
    assert client.get("/preview/not-a-token/index.html").status_code == 404
